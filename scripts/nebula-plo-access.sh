#!/usr/bin/env bash
# Give the PLO CronJobs in Nebula (docs/NEBULA.md §N9; twizz-gitops apps/nebula/plo.yaml) what
# they need to READ the three clusters, and keep their images from expiring. Nothing here lets
# PLO change a cluster.
#
#   1. ECR twizz-idp: ADD a "keep last 30 plo-*" lifecycle rule (every existing rule is kept).
#      Without it plo-* images fall to the 400-image backstop and the tag gitops pins can expire.
#   2. RBAC (infra/k8s/nebula-plo-rbac.yaml) on staging, prod and nonprod: namespaces + nodes read
#      for the group nebula-plo, and `list secrets` ONLY in the namespaces that hold a Helm
#      release right now (one RoleBinding each). Helm keeps release values in those Secrets and
#      RBAC cannot filter by label, so the group can read every Secret of those namespaces:
#      the script prints the namespaces per cluster. READ THAT LIST.
#   3. verify with `kubectl auth can-i` that the grant is exactly that narrow.
#
# The IAM role twizz-nebula-plo and its EKS access entries (AmazonEKSViewPolicy + group
# nebula-plo) are Pulumi: `pulumi up` in infra/addons, before or after. RBAC without the entry
# grants nothing, and the entry without RBAC cannot read a Secret.
#
# Prereqs: AWS_PROFILE=twizz with EKS admin; for prod the SOCKS tunnel up
#   bash ~/twizz_devops/scripts/ssh-rotation/tunnel.sh up
# (the prod API allowlist already has Nebula's NAT: scripts/nebula-capacity-access.sh)
#
#   AWS_PROFILE=twizz bash scripts/nebula-plo-access.sh [--dry-run] [--cluster-wide]
#     --dry-run        change nothing: show the ECR rule and server-side dry-run the RBAC
#     --cluster-wide   bind `list secrets` on the WHOLE cluster instead of per namespace. NOT
#                      needed: PLO falls back to listing Helm releases namespace by namespace
#                      when `kubectl get secrets -A` is refused (PLO src/domains/helm.ts). It
#                      exposes every Secret of the cluster, on prod too: a platform-owner
#                      decision, not a default.
#   PLO_CLUSTERS="staging nonprod"     limit the clusters (default: staging prod nonprod)
#   PLO_HELM_EXCLUDE="argocd auth"     namespaces never to bind, even if they hold a release
#
# Idempotent: a second run changes nothing. It never deletes; bindings left in namespaces that
# no longer hold a release are listed with the command to remove them.
set -euo pipefail
umask 077

ACCOUNT=848281935985
REGION=eu-west-1
ECR_REPO=twizz-idp
ROLE=twizz-nebula-plo
GROUP=nebula-plo
PART_OF=app.kubernetes.io/part-of=nebula-plo
HELM_ROLE=nebula-plo-helm-releases
CLUSTERS=${PLO_CLUSTERS:-staging prod nonprod}
EXCLUDE=" ${PLO_HELM_EXCLUDE:-} "
DRY=false
WIDE=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=true ;;
    --cluster-wide) WIDE=true ;;
    *) echo "unknown argument: $arg (see the header of $0)" >&2; exit 2 ;;
  esac
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

# ── 2. + 3. RBAC and verification, per cluster ───────────────────────
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

  if aws eks describe-access-entry --region "$REGION" --cluster-name "$eks" --principal-arn "arn:aws:iam::$ACCOUNT:role/$ROLE" --query 'accessEntry.kubernetesGroups' --output text >"$T/entry" 2>/dev/null; then
    echo "   access entry: present (groups: $(tr '\t' ' ' <"$T/entry"))"
  else
    echo "   access entry: MISSING for role $ROLE. Run \`pulumi up\` in infra/addons; until then this RBAC grants nothing."
  fi

  k "${APPLY[@]}" -f "$RBAC" | sed 's/^/   /'

  # namespaces that hold a Helm release right now (names only; Secret contents are never printed)
  k get secrets -A -l owner=helm -o jsonpath='{range .items[*]}{.metadata.namespace}{"\n"}{end}' | sort -u > "$T/ns-all"
  : > "$T/ns"
  while IFS= read -r ns; do
    [ -n "$ns" ] || continue
    case "$EXCLUDE" in *" $ns "*) echo "   excluded by PLO_HELM_EXCLUDE: $ns" ;; *) echo "$ns" >> "$T/ns" ;; esac
  done < "$T/ns-all"

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
    echo "   the group $GROUP will be able to list every Secret of: $(tr '\n' ' ' <"$T/ns")"
    while IFS= read -r ns; do
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
  # bindings in namespaces that no longer hold a release (or are now excluded): report, never delete
  k get rolebindings -A -l "$PART_OF" -o jsonpath='{range .items[*]}{.metadata.namespace}{"\n"}{end}' | sort -u > "$T/bound"
  while IFS= read -r ns; do
    [ -n "$ns" ] || continue
    grep -qxF "$ns" "$T/ns" || echo "   stale binding in $ns. remove: kubectl --kubeconfig $kc_shown -n $ns delete rolebinding $HELM_ROLE"
  done < "$T/bound"

  if $DRY; then echo "   DRY-RUN: nothing applied, verification skipped"; continue; fi

  # ── 3. verify. Impersonation tests RBAC only: the view policy of the access entry is not in it.
  helm_ns=$(head -n1 "$T/ns")
  other_ns=default
  while grep -qxF "$other_ns" "$T/ns"; do other_ns="${other_ns}-x"; done   # a namespace without a binding (it need not exist)
  wide_want=no; $WIDE && wide_want=yes
  checks=("list namespaces:yes" "list nodes:yes"
          "list secrets -n $other_ns:$wide_want" "list secrets --all-namespaces:$wide_want"
          "get secrets -n $other_ns:no" "create secrets -n kube-system:no" "delete secrets -n kube-system:no"
          "create pods --subresource=exec -n kube-system:no" "get pods --subresource=log -n kube-system:no"
          "patch deployments -n default:no" "delete pods -n default:no" "patch nodes:no" "create rolebindings -n kube-system:no")
  [ -n "$helm_ns" ] && checks+=("list secrets -n $helm_ns:yes" "get secrets -n $helm_ns:no" "watch secrets -n $helm_ns:no")
  for check in "${checks[@]}"; do
    q=${check%:*}; want=${check##*:}
    read -r -a qa <<<"$q"
    got=$(k auth can-i "${qa[@]}" --as nebula-plo-check --as-group "$GROUP" 2>/dev/null || true)
    if [ "$got" = "$want" ]; then mark=ok; else mark="UNEXPECTED (want $want)"; FAIL=1; fi
    printf '   %-52s %-4s %s\n' "$q" "$got" "$mark"
  done
done

if [ "$FAIL" != 0 ]; then echo "RBAC check FAILED: the grant is not what this script intends" >&2; exit 1; fi
if $DRY; then echo "dry run complete: nothing was changed."; else echo "done. Still needed for PLO to read anything: the access entries (pulumi up in infra/addons)."; fi
