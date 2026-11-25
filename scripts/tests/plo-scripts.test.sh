#!/usr/bin/env bash
# Regression tests of the PLO operator scripts and their infra reference (docs/NEBULA.md §N9):
#   scripts/nebula-plo-access.sh  scripts/nebula-set-plo-secrets.sh  scripts/nebula-set-plo-source-token.sh
#   infra/addons/index.ts  infra/k8s/nebula-plo-rbac.yaml
# Nothing real is called: aws, kubectl and curl are stubs on PATH that record their arguments
# and answer from files. Run:  bash scripts/tests/plo-scripts.test.sh
set -uo pipefail
HERE="${PLO_TEST_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"   # PLO_TEST_ROOT: run against another checkout
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT
PASS=0; FAILED=0
ok() { PASS=$((PASS + 1)); echo "ok    $1"; }
bad() { FAILED=$((FAILED + 1)); echo "FAIL  $1"; [ -z "${2:-}" ] || sed 's/^/        /' <<<"$2" | head -n 25; }
check() { local name=$1; shift; if "$@"; then ok "$name"; else bad "$name" "${OUT:-}"; fi; }

# ── stubs ────────────────────────────────────────────────────────────
mkdir -p "$W/bin"
cat > "$W/bin/aws" <<'STUB'
#!/usr/bin/env bash
# state: $STUB/sm/<name with / as __>.json = secret string; $STUB/policies = associated access policies
echo "aws $*" >> "$STUB/calls"
arg() { local want=$1; shift; while [ $# -gt 0 ]; do [ "$1" = "$want" ] && { echo "$2"; return; }; shift; done; }
f() { echo "$STUB/sm/${1//\//__}.json"; }
case "$1 $2" in
  "sts get-caller-identity") echo 848281935985 ;;
  "ecr get-lifecycle-policy") echo '{"rules":[{"rulePriority":1,"description":"Keep last 30 plo-*","selection":{"tagStatus":"tagged","tagPrefixList":["plo-"],"countType":"imageCountMoreThan","countNumber":30},"action":{"type":"expire"}}]}' ;;
  "eks describe-access-entry") [ -f "$STUB/no-entry" ] && exit 254; cat "$STUB/entry-groups" 2>/dev/null || echo nebula-plo ;;
  "eks list-associated-access-policies") [ -f "$STUB/policies-denied" ] && { echo "AccessDenied" >&2; exit 254; }; cat "$STUB/policies" 2>/dev/null || true ;;
  # like AWS: a secret scheduled for deletion ($STUB/sm/<name>.json.deleting) still DESCRIBES (with DeletedDate)
  # and no longer reads; a missing one is ResourceNotFoundException; $STUB/describe-denied lists names it refuses
  "secretsmanager describe-secret")
    n=$(arg --secret-id "$@")
    if grep -qxF "$n" "$STUB/describe-denied" 2>/dev/null; then echo "An error occurred (AccessDeniedException) when calling the DescribeSecret operation: not authorized" >&2; exit 254; fi
    if [ -f "$(f "$n").deleting" ]; then echo "{\"Name\":\"$n\",\"DeletedDate\":\"2026-11-26T10:00:00+00:00\"}"
    elif [ -f "$(f "$n")" ]; then echo "{\"Name\":\"$n\"}"
    else echo "An error occurred (ResourceNotFoundException) when calling the DescribeSecret operation: Secrets Manager can't find the specified secret." >&2; exit 254; fi ;;
  "secretsmanager get-secret-value")
    n=$(arg --secret-id "$@")
    if [ -f "$(f "$n").deleting" ]; then echo "An error occurred (InvalidRequestException) when calling the GetSecretValue operation: You can't perform this operation on the secret because it was marked for deletion." >&2; exit 254; fi
    cat "$(f "$n")" ;;
  "secretsmanager create-secret") n=$(arg --name "$@"); s=$(arg --secret-string "$@"); cp "${s#file://}" "$(f "$n")"; echo "write $n" >> "$STUB/writes"; echo "$n" ;;
  "secretsmanager put-secret-value") n=$(arg --secret-id "$@"); [ -f "$(f "$n").deleting" ] && { echo "An error occurred (InvalidRequestException): marked for deletion" >&2; exit 254; }; s=$(arg --secret-string "$@"); cp "${s#file://}" "$(f "$n")"; echo "write $n" >> "$STUB/writes"; echo v2 ;;
  *) echo "stub aws: unexpected $*" >&2; exit 99 ;;
esac
STUB
cat > "$W/bin/kubectl" <<'STUB'
#!/usr/bin/env bash
# Emulates the RBAC this script creates: the group may get/list namespaces and nodes, and list
# secrets in a namespace once a RoleBinding was applied there. $STUB/over-grant lists extra
# "verb resource" pairs a wider grant would allow.
echo "kubectl $*" >> "$STUB/calls"
[ "$1" = --kubeconfig ] && shift 2
case "$1" in
  apply)
    if [ "${*: -1}" = - ]; then
      doc=$(cat); kind=$(sed -n 's/^kind: //p' <<<"$doc"); ns=$(sed -n 's/^  namespace: //p' <<<"$doc")
      case " $* " in *" --dry-run=server "*) echo "$kind dry" ;; *) echo "$kind ${ns:-cluster}" >> "$STUB/bound"; echo "$kind created" ;; esac
    else echo "rbac applied"; fi ;;
  get)
    case "$2" in
      secrets) cat "$STUB/helm-ns" ;;
      clusterrolebinding) exit 1 ;;
      rolebindings) cat "$STUB/preexisting-bindings" 2>/dev/null; sed -n 's/^RoleBinding //p' "$STUB/bound" 2>/dev/null ;;
    esac ;;
  auth)
    shift 2; verb=$1; res=$2; shift 2; ns=""; sub=""; all=false
    while [ $# -gt 0 ]; do case "$1" in -n) ns=$2; shift ;; --subresource=*) sub=${1#*=} ;; --all-namespaces) all=true ;; --as | --as-group) shift ;; esac; shift; done
    echo "can-i $verb $res${sub:+/$sub} ns=${ns:-} all=$all" >> "$STUB/cani"
    ans=no
    case "$verb $res${sub:+/$sub}" in
      "get namespaces" | "list namespaces" | "get nodes" | "list nodes") ans=yes ;;
      "list secrets")
        if grep -qx "ClusterRoleBinding cluster" "$STUB/bound" 2>/dev/null; then ans=yes
        elif ! $all && { grep -qx "RoleBinding $ns" "$STUB/bound" 2>/dev/null || grep -qx "$ns" "$STUB/preexisting-bindings" 2>/dev/null; }; then ans=yes; fi ;;
    esac
    grep -qxF "$verb $res${sub:+/$sub}" "$STUB/over-grant" 2>/dev/null && ans=yes
    echo "$ans" ;;
esac
STUB
cp "$W/bin/kubectl" "$W/bin/kubectl-real"
cat > "$W/bin/curl" <<'STUB'
#!/usr/bin/env bash
# answers from $STUB/gh/<path with / as __>: first line = status, rest = body; default 404
out=/dev/null; hdr=/dev/null; url=""
while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift ;; -D) hdr=$2; shift ;; -H | -m | -w | -A) shift ;; -sS) ;; *) url=$1 ;; esac; shift; done
path=${url#http://stub}; echo "curl GET $path" >> "$STUB/calls"
f="$STUB/gh/${path//\//__}"
if [ -f "$f" ]; then head -n1 "$f" > "$STUB/code"; tail -n +2 "$f" > "$out"; else echo 404 > "$STUB/code"; echo '{}' > "$out"; fi
{ echo "HTTP/2 $(cat "$STUB/code")"; cat "$STUB/gh-headers" 2>/dev/null; } > "$hdr"
printf '%s' "$(cat "$STUB/code")"
STUB
chmod +x "$W/bin/"*

fresh() { # a clean stub state
  export STUB="$W/state.$RANDOM$RANDOM"; mkdir -p "$STUB/sm" "$STUB/gh" "$W/home/.kube"
  : > "$STUB/calls"; : > "$STUB/writes"; : > "$STUB/bound"; : > "$STUB/cani"
  printf 'argocd\nauth\ncert-manager\ningress-nginx\n' > "$STUB/helm-ns"
  touch "$W/home/.kube/twizz-nonprod.yaml" "$W/home/.kube/twizz-staging.yaml" "$W/home/.kube/twizz-prod.yaml"
}
run() { OUT=$(HOME="$W/home" PATH="$W/bin:$PATH" AWS_PROFILE=twizz PLO_GITHUB_API=http://stub "$@" 2>&1); RC=$?; }
access() { PLO_CLUSTERS=nonprod run bash "$HERE/scripts/nebula-plo-access.sh" "$@"; }

echo "── nebula-plo-access.sh"
fresh; access
check "a plain run opens no Secret access at all" test "$RC" = 0 -a ! -s "$STUB/bound"
check "a plain run lists the namespaces with Helm releases" grep -q "namespaces with Helm releases: argocd auth cert-manager ingress-nginx" <<<"$OUT"
check "it verifies that pod logs are denied in EVERY namespace" grep -q "can-i get pods/log ns= all=true" "$STUB/cani"
check "it verifies that ConfigMaps are denied" grep -q "can-i list configmaps ns= all=true" "$STUB/cani"
check "it verifies that every unopened Helm namespace is closed" grep -q "can-i list secrets ns=argocd" "$STUB/cani"

fresh; access --helm-namespaces nonprod=ingress-nginx
check "only the named namespace is bound" test "$RC" = 0 -a "$(cat "$STUB/bound")" = "RoleBinding ingress-nginx"
check "the bound namespace is verified as list-only" grep -q "can-i watch secrets ns=ingress-nginx" "$STUB/cani"

fresh; access --helm-namespaces nonprod=argocd,ingress-nginx
check "a sensitive namespace is refused and the run fails" test "$RC" != 0 -a "$(cat "$STUB/bound")" = "RoleBinding ingress-nginx"
check "the refusal says why" grep -q "REFUSED argocd: its Secrets are platform credentials" <<<"$OUT"

fresh; PLO_HELM_ALLOW_SENSITIVE=argocd access --helm-namespaces nonprod=argocd
check "a sensitive namespace opens only with PLO_HELM_ALLOW_SENSITIVE" test "$RC" = 0 -a "$(cat "$STUB/bound")" = "RoleBinding argocd"

fresh; PLO_HELM_EXCLUDE=ingress-nginx access --helm-namespaces nonprod=ingress-nginx
check "PLO_HELM_EXCLUDE still wins over a named namespace" test ! -s "$STUB/bound"

fresh; access --helm-namespaces nonprod=ingres-nginx
check "a namespace without a Helm release (typo) opens nothing and fails" test "$RC" != 0 -a ! -s "$STUB/bound"

fresh; access --helm-namespaces elsewhere=x
check "an unknown cluster name is a usage error" test "$RC" = 2

fresh; echo "arn:aws:eks::aws:cluster-access-policy/AmazonEKSViewPolicy" > "$STUB/policies"; access
check "an EKS access policy on the entry FAILS the run" test "$RC" != 0
check "and is named, not reported as ok" grep -q "UNEXPECTED: the entry has EKS access policies: .*AmazonEKSViewPolicy" <<<"$OUT"

fresh; touch "$STUB/policies-denied"; access
check "an unreadable policy list is not assumed empty" test "$RC" != 0

fresh; echo "get pods/log" > "$STUB/over-grant"; access
check "a grant of pod logs FAILS the run" test "$RC" != 0
check "and the line is marked" grep -Eq "get pods --subresource=log --all-namespaces +yes +UNEXPECTED" <<<"$OUT"

fresh; echo "list configmaps" > "$STUB/over-grant"; access
check "a grant of ConfigMaps FAILS the run" test "$RC" != 0

fresh; echo auth > "$STUB/preexisting-bindings"; access
check "a binding left by an earlier run is reported as stale" grep -q "stale binding in auth" <<<"$OUT"

fresh; access --dry-run --helm-namespaces nonprod=ingress-nginx
check "--dry-run binds nothing" test "$RC" = 0 -a ! -s "$STUB/bound"

echo "── nebula-set-plo-secrets.sh"
secrets() { run bash "$HERE/scripts/nebula-set-plo-secrets.sh" "$@"; }
fresh; echo '{"DATABASE_URL":"x"}' > "$STUB/sm/preview__nebula.json"; secrets
tok=$(jq -r .NEBULA_INGEST_TOKEN "$STUB/sm/nebula__plo.json" 2>/dev/null)
dtok=$(jq -r .NEBULA_DISPATCH_TOKEN "$STUB/sm/nebula__plo.json" 2>/dev/null)
check "the token is created in nebula/plo" test "$RC" = 0 -a "${#tok}" = 64
check "the dispatcher gets a token of its own, different from the publisher's" test "${#dtok}" = 64 -a "$dtok" != "$tok"
check "neither token is in the output or on a command line" bash -c '! grep -qF "$1" <<<"$3" && ! grep -qF "$2" <<<"$3" && ! grep -qF "$2" "$4"' _ "$tok" "$dtok" "$OUT" "$STUB/calls"
check "nothing is written under preview/*" test "$(cat "$STUB/writes")" = "write nebula/plo"
check "the token is not in the output" bash -c '! grep -qF "$1" <<<"$2"' _ "$tok" "$OUT"
check "the token is never on a command line" bash -c '! grep -qF "$1" "$2"' _ "$tok" "$STUB/calls"
check "the next steps restart the dashboard after the sync, with --kubeconfig" bash -c 'grep -n "wait --for=condition=Ready externalsecret/plo-env\|rollout restart deploy/dashboard" <<<"$1" | grep -c -- "--kubeconfig" | grep -qx 2' _ "$OUT"
check "the next steps wait for BOTH secrets before the restart" grep -q "wait --for=condition=Ready externalsecret/plo-env externalsecret/plo-dispatch-env" <<<"$OUT"
check "the next steps enable the parked ExternalSecrets before asking for a sync" bash -c '[ "$(grep -n "apps/nebula/disabled/plo-externalsecrets.yaml" <<<"$1" | head -n1 | cut -d: -f1)" -lt "$(grep -n "annotate externalsecret plo-env plo-dispatch-env force-sync" <<<"$1" | head -n1 | cut -d: -f1)" ]' _ "$OUT"
: > "$STUB/writes"; secrets
check "a second run writes nothing" test "$RC" = 0 -a ! -s "$STUB/writes"
secrets --rotate
check "--rotate mints a different token" test "$RC" = 0 -a "$(jq -r .NEBULA_INGEST_TOKEN "$STUB/sm/nebula__plo.json")" != "$tok"
check "--rotate mints a different dispatch token too" test "$(jq -r .NEBULA_DISPATCH_TOKEN "$STUB/sm/nebula__plo.json")" != "$dtok"
# a secret from before the dispatcher had its own token: the missing key is added, the existing one kept
fresh; echo '{"NEBULA_INGEST_TOKEN":"'"$(printf 'a%.0s' {1..64})"'"}' > "$STUB/sm/nebula__plo.json"; secrets
check "an existing ingest token is kept when the dispatch token is added" test "$RC" = 0 -a "$(jq -r .NEBULA_INGEST_TOKEN "$STUB/sm/nebula__plo.json")" = "$(printf 'a%.0s' {1..64})" -a "$(jq -r '.NEBULA_DISPATCH_TOKEN | length' "$STUB/sm/nebula__plo.json")" = 64

fresh; echo '{"DATABASE_URL":"x","LIFECYCLE_INGEST_TOKEN":"old"}' > "$STUB/sm/preview__nebula.json"; secrets
check "a legacy copy in preview/nebula stops the run before any write" test "$RC" != 0 -a ! -s "$STUB/writes"
secrets --remove-legacy-copy
check "--remove-legacy-copy removes that one key and keeps the others" test "$RC" = 0 -a "$(jq -c . "$STUB/sm/preview__nebula.json")" = '{"DATABASE_URL":"x"}'
fresh; echo '{}' > "$STUB/sm/preview__plo.json"; secrets
check "a legacy preview/plo stops the run before any write" test "$RC" != 0 -a ! -s "$STUB/writes"
# the dashboard takes LIFECYCLE_DISPATCH_TOKEN from nebula-env (SM preview/nebula, readable by preview
# pods) whenever Secret plo-dispatch-env is missing: a copy there is as bad as the ingest token's
fresh; echo '{"DATABASE_URL":"x","LIFECYCLE_DISPATCH_TOKEN":"old"}' > "$STUB/sm/preview__nebula.json"; secrets
check "a dispatch token in preview/nebula stops the run before any write" test "$RC" != 0 -a ! -s "$STUB/writes"
check "and the key is named" grep -q "LIFECYCLE_DISPATCH_TOKEN" <<<"$OUT"
fresh; echo '{"DATABASE_URL":"x","LIFECYCLE_DISPATCH_TOKEN":"old","LIFECYCLE_INGEST_TOKEN":"old2"}' > "$STUB/sm/preview__nebula.json"; secrets --remove-legacy-copy
check "--remove-legacy-copy removes both token keys and keeps the others" test "$RC" = 0 -a "$(jq -c . "$STUB/sm/preview__nebula.json")" = '{"DATABASE_URL":"x"}'
check "the old values are not printed" bash -c '! grep -q "old" <<<"$1"' _ "$(grep -v "falls back\|readable by preview pods" <<<"$OUT")"

# pass 3 #7: the script's own advice is `delete-secret --recovery-window-in-days 7`; for those seven days AWS still
# DESCRIBES the secret (with DeletedDate) while nobody can read it any more
fresh; echo '{"DATABASE_URL":"x"}' > "$STUB/sm/preview__nebula.json"; touch "$STUB/sm/preview__plo.json.deleting"; secrets
check "a legacy preview/plo that is scheduled for deletion does not block the run" test "$RC" = 0 -a "$(cat "$STUB/writes")" = "write nebula/plo"
check "and it is said" grep -q "preview/plo is scheduled for deletion" <<<"$OUT"
fresh; echo '{}' > "$STUB/sm/nebula__plo.json"; touch "$STUB/sm/nebula__plo.json.deleting"; secrets
check "nebula/plo itself scheduled for deletion is refused with what to do, before any write" bash -c '[ "$1" != 0 ] && [ ! -s "$3" ] && grep -q "nebula/plo is scheduled for deletion" <<<"$2" && grep -q "restore-secret" <<<"$2"' _ "$RC" "$OUT" "$STUB/writes"
# …and "could not check" is never "not there": a legacy copy that cannot be looked at stops the run
fresh; echo '{"DATABASE_URL":"x","LIFECYCLE_INGEST_TOKEN":"old"}' > "$STUB/sm/preview__nebula.json"; echo preview/nebula > "$STUB/describe-denied"; secrets
check "a legacy secret that cannot be described stops the run before any write" test "$RC" != 0 -a ! -s "$STUB/writes"
check "and the AWS error is named, not swallowed" grep -q "could not check whether preview/nebula exists.*AccessDeniedException" <<<"$OUT"
fresh; echo preview/plo > "$STUB/describe-denied"; secrets
check "the same for preview/plo" test "$RC" != 0 -a ! -s "$STUB/writes"

echo "── nebula-set-plo-source-token.sh"
GOOD=github_pat_$(printf 'A%.0s' {1..40})
gh_ok() { # the six repositories answer as a write collaborator
  echo -e '200\n{"login":"twizz-plo-bot"}' > "$STUB/gh/__user"
  for r in Moly-backend twizz-sentinel lolygram-discover front-admin frontend platform-lifecycle-orchestrator; do
    echo -e '200\n{"private":true,"permissions":{"push":true,"admin":false}}' > "$STUB/gh/__repos__twizz-app__$r"
  done
}
token() { run bash -c 'printf "%s\n" "$1" | bash "$2"' _ "$1" "$HERE/scripts/nebula-set-plo-source-token.sh"; }
fresh; gh_ok; token "$GOOD"
check "a narrow fine-grained token is stored in nebula/plo-source-github" test "$RC" = 0 -a "$(jq -r .token "$STUB/sm/nebula__plo-source-github.json" 2>/dev/null)" = "$GOOD"
check "the token is not in the output" bash -c '! grep -qF "$1" <<<"$2"' _ "$GOOD" "$OUT"
check "the token is never on a command line" bash -c '! grep -qF "$1" "$2"' _ "$GOOD" "$STUB/calls"
check "GitHub is only read" bash -c '! grep "^curl" "$1" | grep -qv "^curl GET "' _ "$STUB/calls"
fresh; gh_ok; token "ghp_$(printf 'A%.0s' {1..36})"
check "a classic token is refused before any call" test "$RC" != 0 -a ! -s "$STUB/writes" -a "$(grep -c '^curl' "$STUB/calls")" = 0
fresh; gh_ok; echo "x-oauth-scopes: repo, workflow" > "$STUB/gh-headers"; token "$GOOD"
check "a token that announces OAuth scopes is refused" test "$RC" != 0 -a ! -s "$STUB/writes"
fresh; gh_ok; echo -e '200\n{"private":true,"permissions":{"push":true}}' > "$STUB/gh/__repos__TwizzyNicky__twizz-gitops"; token "$GOOD"
check "a token that can see twizz-gitops is refused" test "$RC" != 0 -a ! -s "$STUB/writes"
fresh; gh_ok; echo -e '200\n{"private":false,"permissions":{"push":false,"pull":true}}' > "$STUB/gh/__repos__xenosnikos__First-IDP"; token "$GOOD"
check "a public repository the token cannot push to does not block the token" test "$RC" = 0 -a -s "$STUB/writes"
fresh; gh_ok; echo -e '200\n{"private":false,"permissions":{"push":true}}' > "$STUB/gh/__repos__xenosnikos__First-IDP"; token "$GOOD"
check "a public repository the token CAN push to is refused" test "$RC" != 0 -a ! -s "$STUB/writes"
fresh; gh_ok; echo -e '200\n{"permissions":{"push":false}}' > "$STUB/gh/__repos__xenosnikos__First-IDP"; token "$GOOD"
check "an answer that does not say the repository is public is refused" test "$RC" != 0 -a ! -s "$STUB/writes"
fresh; gh_ok; echo -e '500\n{}' > "$STUB/gh/__repos__TwizzyNicky__twizz-gitops"; token "$GOOD"
check "an unclear answer about twizz-gitops is refused (not assumed safe)" test "$RC" != 0 -a ! -s "$STUB/writes"
fresh; gh_ok; echo -e '200\n{"private":true,"permissions":{"push":true,"admin":true}}' > "$STUB/gh/__repos__twizz-app__frontend"; token "$GOOD"
check "a token of a repository admin is refused" test "$RC" != 0 -a ! -s "$STUB/writes"
fresh; gh_ok; rm "$STUB/gh/__repos__twizz-app__frontend"; token "$GOOD"
check "a token that lacks one of the six repositories is refused" test "$RC" != 0 -a ! -s "$STUB/writes"
fresh; gh_ok; touch "$STUB/sm/nebula__plo-source-github.json.deleting"; token "$GOOD"
check "a token secret that is scheduled for deletion is refused with what to do" bash -c '[ "$1" != 0 ] && [ ! -s "$3" ] && grep -q "nebula/plo-source-github is scheduled for deletion" <<<"$2"' _ "$RC" "$OUT" "$STUB/writes"
fresh; gh_ok; echo nebula/plo-source-github > "$STUB/describe-denied"; token "$GOOD"
check "a token secret that cannot be described is not assumed missing" bash -c '[ "$1" != 0 ] && [ ! -s "$3" ] && grep -q "could not check whether nebula/plo-source-github exists" <<<"$2"' _ "$RC" "$OUT" "$STUB/writes"
fresh; gh_ok; run bash "$HERE/scripts/nebula-set-plo-source-token.sh" "$GOOD"
check "a token on the command line is a usage error" test "$RC" = 2 -a ! -s "$STUB/writes"

echo "── infra reference"
IDX="$HERE/infra/addons/index.ts"; RBAC="$HERE/infra/k8s/nebula-plo-rbac.yaml"
code() { grep -v '^\s*//' "$1"; }   # the file without comment lines
check "addons attaches no EKS access policy to the PLO role" bash -c '! grep -q "AccessPolicyAssociation\|cluster-access-policy" <<<"$1"' _ "$(code "$IDX")"
check "addons keeps the PLO role trusted by exactly one ServiceAccount" grep -q '"system:serviceaccount:nebula:plo"' "$IDX"
check "External Secrets is granted the two PLO secrets by name, not a prefix" bash -c 'grep -q "PLO_SECRETS = \[\"nebula/plo\", \"nebula/plo-source-github\"\]" "$1" && grep -q "Resource: PLO_SECRETS.map(secretArn)" "$1"' _ "$IDX"
check "preview pods are denied the platform secrets and nebula/*" bash -c 'grep -q "role: \"twizz-nonprod-preview-pods\"" "$1" && grep -q "Effect: \"Deny\"" "$1" && grep -q "preview/nebula\", \"preview/github\"" "$1" && grep -q "secret:nebula/\*" "$1"' _ "$IDX"
check "no PLO secret is kept under preview/*" bash -c '! grep -h "preview/plo" "$@" | grep -v "^\s*\(#\|//\)" | grep -v "^LEGACY_PLO_SECRET=" | grep -q .' _ "$HERE/scripts/nebula-set-plo-secrets.sh" "$HERE/scripts/nebula-set-plo-source-token.sh" "$IDX" "$HERE/scripts/nebula-plo-access.sh"
check "the RBAC file grants no pods, logs, configmaps or write verb" bash -c '! grep -Eq "pods|configmaps|deployments|\b(create|update|patch|delete|watch|\*)\b" <<<"$1"' _ "$(grep -v '^\s*#' "$RBAC")"
check "the RBAC file binds no Secret access by itself" bash -c '[ "$(grep -c "^kind: ClusterRoleBinding" "$1")" = 1 ] && ! grep -q "^kind: RoleBinding" "$1" && grep -A4 "^kind: ClusterRoleBinding" "$1" | grep -q "name: nebula-plo-cluster-read"' _ "$RBAC"
for s in nebula-plo-access.sh nebula-set-plo-secrets.sh nebula-set-plo-source-token.sh; do check "bash -n $s" bash -n "$HERE/scripts/$s"; done

echo; echo "$PASS passed, $FAILED failed"
[ "$FAILED" = 0 ]
