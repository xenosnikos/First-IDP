#!/usr/bin/env bash
# Give the PLO CronJobs in Nebula (docs/NEBULA.md §N9; twizz-gitops apps/nebula/plo.yaml) what
# they need to READ the three clusters, and keep their images from expiring. Nothing here lets
# PLO change a cluster.
#
#   1. ECR twizz-idp: ADD a "keep last 30 plo-*" lifecycle rule (every existing rule is kept).
#      Without it plo-* images fall to the 400-image backstop and the tag gitops pins can expire.
#   2. RBAC (infra/k8s/nebula-plo-rbac.yaml) on staging, prod and nonprod: namespaces + nodes read
#      for the group nebula-plo. That is all a plain run grants.
#   3. `list secrets` ONLY in the namespaces YOU NAME with --helm-namespaces. Helm keeps release
#      values in Secrets and RBAC cannot filter by label, so the group can then read EVERY Secret
#      of a named namespace. A plain run opens none: it prints, per cluster, the namespaces that
#      hold a Helm release, and you decide. Namespaces that hold platform credentials
#      (SENSITIVE below) need PLO_HELM_ALLOW_SENSITIVE on top. A namespace that is not opened
#      shows up in PLO as a coverage gap of the Helm tier; nothing else is affected.
#   4. verify what the group can and cannot do, and that the role's EKS access entry carries NO
#      access policy. The checks impersonate the group, which tests Kubernetes RBAC only; an EKS
#      access policy (AmazonEKSViewPolicy and the like) grants rights outside RBAC that
#      impersonation cannot see, so an entry with any policy attached FAILS the run instead of
#      being reported as "ok".
#
# The IAM role twizz-nebula-plo and its EKS access entries (group nebula-plo, no access policy)
# are Pulumi: `pulumi up` in infra/addons, before or after. RBAC without the entry grants
# nothing, and the entry without RBAC cannot read anything.
#
# Prereqs: AWS_PROFILE=twizz with EKS admin; for prod the SOCKS tunnel up
#   bash ~/twizz_devops/scripts/ssh-rotation/tunnel.sh up
# (the prod API allowlist already has Nebula's NAT: scripts/nebula-capacity-access.sh)
#
#   AWS_PROFILE=twizz bash scripts/nebula-plo-access.sh [--dry-run] [--helm-namespaces <cluster>=<ns>[,<ns>...]]... [--cluster-wide]
#     --dry-run          change nothing: show the ECR rule and server-side dry-run the RBAC
#     --helm-namespaces  open `list secrets` in exactly these namespaces of one cluster
#                        (staging, prod or nonprod); repeat the flag per cluster, e.g.
#                          --helm-namespaces nonprod=cert-manager,ingress-nginx --helm-namespaces staging=monitoring
#                        A namespace without a Helm release is refused (a typo opens nothing).
#     --cluster-wide     bind `list secrets` on the WHOLE cluster instead of per namespace. NOT
#                        needed: PLO falls back to listing Helm releases namespace by namespace
#                        when `kubectl get secrets -A` is refused (PLO src/domains/helm.ts). It
#                        exposes every Secret of the cluster, on prod too: a platform-owner
#                        decision, not a default.
#   PLO_CLUSTERS="staging nonprod"            limit the clusters (default: staging prod nonprod)
#   PLO_HELM_EXCLUDE="argocd auth"            namespaces never to bind, even when named
#   PLO_HELM_ALLOW_SENSITIVE="cert-manager"   sensitive namespaces you accept to open (still must be named)
#
# Idempotent: a second run with the same arguments changes nothing. It never deletes; bindings
# left in namespaces that are no longer named are listed with the command to remove them.
set -euo pipefail
umask 077

ACCOUNT=848281935985
REGION=eu-west-1
ECR_REPO=twizz-idp
ROLE=twizz-nebula-plo
GROUP=nebula-plo
PART_OF=app.kubernetes.io/part-of=nebula-plo
HELM_ROLE=nebula-plo-helm-releases
# Namespaces whose Secrets are platform credentials: Argo CD's repository and cluster credentials,
# the SSO cookie secret, External Secrets, Nebula's own database and tokens, the staging/prod
# application secrets, service-account tokens.
SENSITIVE=" argocd auth external-secrets cert-manager kube-system nebula sentinel default "
CLUSTERS=${PLO_CLUSTERS:-staging prod nonprod}
EXCLUDE=" ${PLO_HELM_EXCLUDE:-} "
ALLOW_SENSITIVE=" ${PLO_HELM_ALLOW_SENSITIVE:-} "
DRY=false
WIDE=false
declare -A HELM_ALLOW=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=true ;;
    --cluster-wide) WIDE=true ;;
    --helm-namespaces)
      [ $# -ge 2 ] || { echo "--helm-namespaces needs <cluster>=<ns>[,<ns>...]" >&2; exit 2; }
      shift
      case "$1" in
        staging=?* | prod=?* | nonprod=?*) HELM_ALLOW[${1%%=*}]="${HELM_ALLOW[${1%%=*}]:-} $(tr ',' ' ' <<<"${1#*=}")" ;;
        *) echo "--helm-namespaces: expected staging=..., prod=... or nonprod=..., got '$1'" >&2; exit 2 ;;
      esac ;;
    *) echo "unknown argument: $1 (see the header of $0)" >&2; exit 2 ;;
  esac
  shift
done
for c in "${!HELM_ALLOW[@]}"; do
  case " $CLUSTERS " in *" $c "*) ;; *) echo "--helm-namespaces names cluster '$c', which is not in PLO_CLUSTERS ($CLUSTERS)" >&2; exit 2 ;; esac
  for ns in ${HELM_ALLOW[$c]}; do
    [[ "$ns" =~ ^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$ ]] || { echo "--helm-namespaces: '$ns' is not a namespace name" >&2; exit 2; }
  done
done

# ── refuse to run against the wrong account ──────────────────────────
[ -n "${AWS_PROFILE:-}" ] || { echo "refusing to run: AWS_PROFILE is not set. Use: AWS_PROFILE=twizz bash $0" >&2; exit 1; }
for bin in aws jq; do command -v "$bin" >/dev/null || { echo "$bin is required" >&2; exit 1; }; done
KUBECTL=$(command -v kubectl-real || command -v kubectl) || { echo "kubectl is required" >&2; exit 1; }
GOT=$(aws sts get-caller-identity --query Account --output text)
[ "$GOT" = "$ACCOUNT" ] || { echo "refusing to run: AWS_PROFILE=$AWS_PROFILE is account $GOT, expected $ACCOUNT" >&2; exit 1; }

HERE="$(cd "$(dirname "$0")/.." && pwd)"
RBAC="$HERE/infra/k8s/nebula-plo-rbac.yaml"
[ -f "$RBAC" ] || { echo "missing $RBAC" >&2; exit 1; }
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
APPLY=(apply)
$DRY && APPLY=(apply --dry-run=server)

# ── 1. ECR lifecycle rule for plo-* ──────────────────────────────────
echo "── ECR $ECR_REPO lifecycle"
aws ecr get-lifecycle-policy --region "$REGION" --repository-name "$ECR_REPO" --query lifecyclePolicyText --output text > "$T/ecr-now.json" \
  || { echo "cannot read the lifecycle policy of $ECR_REPO; not inventing one" >&2; exit 1; }
if jq -e 'any(.rules[]; (.selection.tagPrefixList // []) | index("plo-"))' "$T/ecr-now.json" >/dev/null; then
  echo "   already keeps plo-* ($(jq -r '[.rules[] | select((.selection.tagPrefixList // []) | index("plo-")) | .description] | join("; ")' "$T/ecr-now.json"))"
else
  # next free priority below the tagStatus=any backstop, which must stay the last rule
  jq '([.rules[] | select(.selection.tagStatus != "any") | .rulePriority] | max // 0) as $max
      | ([.rules[] | select(.selection.tagStatus == "any") | .rulePriority] | min // 1000000) as $any
      | if $max + 1 >= $any then error("no free rule priority between \($max) and the backstop at \($any)") else . end
      | .rules += [{ rulePriority: ($max + 1), description: "Keep last 30 plo-*",
                     selection: { tagStatus: "tagged", tagPrefixList: ["plo-"], countType: "imageCountMoreThan", countNumber: 30 },
                     action: { type: "expire" } }]
      | .rules |= sort_by(.rulePriority)' "$T/ecr-now.json" > "$T/ecr-new.json"
  echo "   adding: $(jq -c '.rules[] | select((.selection.tagPrefixList // []) | index("plo-"))' "$T/ecr-new.json")"
  if $DRY; then
    echo "   DRY-RUN: policy not written. Rules would be: $(jq -r '[.rules[] | "\(.rulePriority) \(.description)"] | join(" | ")' "$T/ecr-new.json")"
  else
    aws ecr put-lifecycle-policy --region "$REGION" --repository-name "$ECR_REPO" --lifecycle-policy-text "file://$T/ecr-new.json" --query repositoryName --output text | xargs echo "   written to"
  fi
fi

# ── 2. - 4. RBAC, Secret access and verification, per cluster ────────
kubeconfig_for() { # staging|prod|nonprod -> path
  case "$1" in
    staging) grep -v "proxy-url" "$HOME/.kube/twizz-staging.yaml" > "$T/staging.yaml"; echo "$T/staging.yaml" ;; # staging API is public; drop the stale SOCKS line
    prod) echo "$HOME/.kube/twizz-prod.yaml" ;;
    nonprod) echo "$HOME/.kube/twizz-nonprod.yaml" ;;
    *) echo "unknown cluster '$1' in PLO_CLUSTERS (staging, prod, nonprod)" >&2; return 1 ;;
  esac
}
cluster_name() { case "$1" in staging) echo EKS-Moly-staging ;; prod) echo EKS-Moly-Prod ;; nonprod) echo EKS-Twizz-NonProd ;; esac; }

FAIL=0
for target in $CLUSTERS; do
  kc=$(kubeconfig_for "$target")
  eks=$(cluster_name "$target")
  kc_shown="\$HOME/.kube/twizz-$target.yaml"   # for the commands this script prints (the staging copy is temporary)
  k() { "$KUBECTL" --kubeconfig "$kc" "$@"; }
  echo "── $target ($eks)"

  # The access entry must map the role to the group and to NOTHING else. An access policy is
  # authorization outside RBAC: `kubectl auth can-i --as-group` below would not see it.
  principal="arn:aws:iam::$ACCOUNT:role/$ROLE"
  if aws eks describe-access-entry --region "$REGION" --cluster-name "$eks" --principal-arn "$principal" --query 'accessEntry.kubernetesGroups' --output text >"$T/entry" 2>/dev/null; then
    echo "   access entry: present (groups: $(tr '\t' ' ' <"$T/entry"))"
    if [ "$(tr -s '\t\n ' ' ' <"$T/entry" | sed 's/^ //; s/ $//')" != "$GROUP" ]; then
      echo "   UNEXPECTED: the entry must carry exactly the group $GROUP" >&2; FAIL=1
    fi
    if ! aws eks list-associated-access-policies --region "$REGION" --cluster-name "$eks" --principal-arn "$principal" --query 'associatedAccessPolicies[].policyArn' --output text >"$T/policies" 2>"$T/policies.err"; then
      echo "   UNEXPECTED: cannot list the access policies of the entry ($(head -n1 "$T/policies.err" | cut -c1-160)); not assuming there are none" >&2; FAIL=1
    elif [ -n "$(tr -d '[:space:]' <"$T/policies")" ] && [ "$(tr -d '[:space:]' <"$T/policies")" != "None" ]; then
      echo "   UNEXPECTED: the entry has EKS access policies: $(tr '\t\n' '  ' <"$T/policies")" >&2
      echo "              they grant rights the RBAC checks below cannot see (AmazonEKSViewPolicy = pod logs and ConfigMaps of every namespace)." >&2
      echo "              remove them: \`pulumi up\` in infra/addons, or aws eks disassociate-access-policy --cluster-name $eks --principal-arn $principal --policy-arn <arn>" >&2
      FAIL=1
    else
      echo "   access policies: none (the group's RBAC is everything the role can do here)"
    fi
  else
    echo "   access entry: MISSING for role $ROLE. Run \`pulumi up\` in infra/addons; until then this RBAC grants nothing."
  fi

  k "${APPLY[@]}" -f "$RBAC" | sed 's/^/   /'

  # namespaces that hold a Helm release right now (names only; Secret contents are never printed)
  k get secrets -A -l owner=helm -o jsonpath='{range .items[*]}{.metadata.namespace}{"\n"}{end}' | sort -u > "$T/ns-all"
  echo "   namespaces with Helm releases: $(tr '\n' ' ' <"$T/ns-all")"
  : > "$T/ns"
  for ns in ${HELM_ALLOW[$target]:-}; do
    if ! grep -qxF "$ns" "$T/ns-all"; then echo "   REFUSED $ns: no Helm release there (typo?); nothing opened" >&2; FAIL=1; continue; fi
    case "$EXCLUDE" in *" $ns "*) echo "   excluded by PLO_HELM_EXCLUDE: $ns"; continue ;; esac
    case "$SENSITIVE" in *" $ns "*)
      case "$ALLOW_SENSITIVE" in
        *" $ns "*) echo "   SENSITIVE namespace $ns opened on request (PLO_HELM_ALLOW_SENSITIVE)" ;;
        *) echo "   REFUSED $ns: its Secrets are platform credentials. To open it anyway add it to PLO_HELM_ALLOW_SENSITIVE." >&2; FAIL=1; continue ;;
      esac ;;
    esac
    grep -qxF "$ns" "$T/ns" || echo "$ns" >> "$T/ns"
  done
  not_opened=$(grep -vxFf "$T/ns" "$T/ns-all" | tr '\n' ' ' || true)

  if $WIDE; then
    echo "   --cluster-wide: the group $GROUP will be able to list EVERY Secret of $eks"
    k "${APPLY[@]}" -f - <<EOF | sed 's/^/   /'
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: $HELM_ROLE
  labels: { app.kubernetes.io/part-of: nebula-plo }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: $HELM_ROLE }
subjects:
  - { apiGroup: rbac.authorization.k8s.io, kind: Group, name: $GROUP }
EOF
  else
    if [ -s "$T/ns" ]; then
      echo "   the group $GROUP will be able to list every Secret of: $(tr '\n' ' ' <"$T/ns")"
    else
      echo "   no Secret access opened on $target. To open some: --helm-namespaces $target=<ns>[,<ns>...]"
    fi
    [ -z "$not_opened" ] || echo "   not opened (PLO reports them as a Helm coverage gap): $not_opened"
    while IFS= read -r ns; do
      [ -n "$ns" ] || continue
      k "${APPLY[@]}" -f - <<EOF | sed 's/^/   /'
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: $HELM_ROLE
  namespace: $ns
  labels: { app.kubernetes.io/part-of: nebula-plo }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: $HELM_ROLE }
subjects:
  - { apiGroup: rbac.authorization.k8s.io, kind: Group, name: $GROUP }
EOF
    done < "$T/ns"
    if k get clusterrolebinding "$HELM_ROLE" >/dev/null 2>&1; then
      echo "   WARNING: ClusterRoleBinding $HELM_ROLE exists (an earlier --cluster-wide run): every Secret of $eks is readable."
      echo "            remove: kubectl --kubeconfig $kc_shown delete clusterrolebinding $HELM_ROLE"
    fi
  fi
  # bindings in namespaces that are not named now (or are excluded): report, never delete
  k get rolebindings -A -l "$PART_OF" -o jsonpath='{range .items[*]}{.metadata.namespace}{"\n"}{end}' | sort -u > "$T/bound"
  : > "$T/stale"
  while IFS= read -r ns; do
    [ -n "$ns" ] || continue
    grep -qxF "$ns" "$T/ns" && continue
    echo "$ns" >> "$T/stale"
    echo "   stale binding in $ns (its Secrets are still readable). remove: kubectl --kubeconfig $kc_shown -n $ns delete rolebinding $HELM_ROLE"
  done < "$T/bound"

  if $DRY; then echo "   DRY-RUN: nothing applied, verification skipped"; continue; fi

  # ── 4. verify what is granted AND what is denied. With no access policy on the entry (checked
  # above) the group's RBAC is the whole grant, so impersonating the group tests the real thing.
  # The denials name what AmazonEKSViewPolicy or a wider binding would add: pod logs, ConfigMaps,
  # workload objects, Secrets by name, every write.
  wide_want=no; $WIDE && wide_want=yes
  closed_ns=plo-check-unbound   # a namespace that holds no binding (it need not exist)
  checks=("get namespaces:yes" "list namespaces:yes" "get nodes:yes" "list nodes:yes"
          "list secrets -n $closed_ns:$wide_want" "list secrets --all-namespaces:$wide_want"
          "get secrets -n $closed_ns:no" "watch secrets --all-namespaces:no"
          "get pods --subresource=log --all-namespaces:no" "get pods --subresource=log -n kube-system:no"
          "list configmaps --all-namespaces:no" "get configmaps -n kube-system:no"
          "list pods --all-namespaces:no" "list deployments.apps --all-namespaces:no" "list serviceaccounts --all-namespaces:no"
          "create pods --subresource=exec -n kube-system:no" "create serviceaccounts --subresource=token -n kube-system:no"
          "create secrets -n kube-system:no" "delete secrets -n kube-system:no"
          "patch deployments.apps -n default:no" "delete pods -n default:no" "patch nodes:no" "delete namespaces:no"
          "create rolebindings.rbac.authorization.k8s.io -n kube-system:no" "impersonate users:no" "* *:no")
  while IFS= read -r ns; do
    [ -n "$ns" ] || continue
    checks+=("list secrets -n $ns:yes" "get secrets -n $ns:no" "watch secrets -n $ns:no" "list configmaps -n $ns:no" "get pods --subresource=log -n $ns:no")
  done < "$T/ns"
  if ! $WIDE; then
    # every Helm namespace that was NOT opened must really be closed (stale bindings excepted: reported above)
    for ns in $not_opened; do
      grep -qxF "$ns" "$T/stale" || checks+=("list secrets -n $ns:no")
    done
  fi
  for check in "${checks[@]}"; do
    q=${check%:*}; want=${check##*:}
    read -r -a qa <<<"$q"
    got=$(set -f; k auth can-i "${qa[@]}" --as nebula-plo-check --as-group "$GROUP" 2>/dev/null || true)
    got=${got%%$'\n'*}   # "no - no RBAC policy matched" style answers: first line only
    got=${got%% *}
    if [ "$got" = "$want" ]; then mark=ok; else mark="UNEXPECTED (want $want)"; FAIL=1; fi
    printf '   %-62s %-4s %s\n' "$q" "$got" "$mark"
  done
done

if [ "$FAIL" != 0 ]; then echo "FAILED: the grant is not what this script intends, or a namespace was refused (see UNEXPECTED / REFUSED above)" >&2; exit 1; fi
if $DRY; then echo "dry run complete: nothing was changed."; else echo "done. Still needed for PLO to read anything: the access entries (pulumi up in infra/addons)."; fi
