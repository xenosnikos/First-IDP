#!/usr/bin/env bash
# One-time bootstrap of the STAGING tier for the release train (docs/NEBULA.md §N4):
# twizz-sentinel + twizz-admin on EKS-Moly-staging, namespace `sentinel`.
#
# What it writes (idempotent; re-running refreshes nothing secret unless asked):
#   SM  staging/twizz-sentinel   MONGO_URI, SHIFT_FOUR_MONGO_URI, REDIS_*, MAX_MIND_* copied from
#                                staging/moly/backend; ANTHROPIC_API_KEY/ANTHROPIC_WORKSPACE_ID
#                                (+ SENTINEL_SLACK_WEBHOOK_URL if set) copied from preview/twizz-sentinel;
#                                fresh SENTINEL_API_KEY + SENTINEL_ADMIN_API_KEY
#   SM  staging/twizz-admin      fresh NEXTAUTH_SECRET + the SAME two sentinel keys
#   k8s namespace sentinel       (labelled twizz-idp/tier=staging) on EKS-Moly-staging
#   k8s Secret twizz-admin-secrets in that namespace, mirrored from staging/twizz-admin
#       (no External Secrets operator on staging; the sentinel reads its own blob via IRSA)
#
#   AWS_PROFILE=twizz bash scripts/staging-sentinel-bootstrap.sh            # create what is missing
#   AWS_PROFILE=twizz bash scripts/staging-sentinel-bootstrap.sh --rotate   # also mint new sentinel keys + NEXTAUTH_SECRET
#
# Prereqs: `pulumi up` in infra/ (IAM roles, access entry, Argo cluster secret, DNS),
# then push twizz-gitops (bootstrap/apps-staging.yaml + values-staging files).
# Secret values are never printed; only key names are echoed back.
set -euo pipefail
umask 077

REGION=eu-west-1
NS=sentinel
SRC_BACKEND=staging/moly/backend
SRC_SENTINEL=preview/twizz-sentinel
SENTINEL_SECRET=staging/twizz-sentinel
ADMIN_SECRET=staging/twizz-admin
K8S_ADMIN_SECRET=twizz-admin-secrets
KUBECONFIG_SRC="${STAGING_KUBECONFIG:-$HOME/.kube/twizz-staging.yaml}"
ROTATE=false
[ "${1:-}" = "--rotate" ] && ROTATE=true

command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
command -v kubectl >/dev/null || { echo "kubectl is required" >&2; exit 1; }

T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT

# The stock staging kubeconfig carries a stale socks proxy-url; the endpoint is public.
grep -v 'proxy-url' "$KUBECONFIG_SRC" > "$T/kubeconfig"
export KUBECONFIG="$T/kubeconfig"

get_secret() { aws secretsmanager get-secret-value --region "$REGION" --secret-id "$1" --query SecretString --output text 2>/dev/null || true; }
put_secret() { # name file
  if aws secretsmanager describe-secret --region "$REGION" --secret-id "$1" >/dev/null 2>&1; then
    aws secretsmanager put-secret-value --region "$REGION" --secret-id "$1" --secret-string "file://$2" >/dev/null
  else
    aws secretsmanager create-secret --region "$REGION" --name "$1" --secret-string "file://$2" \
      --tags Key=Project,Value=twizz-idp Key=tier,Value=staging Key=managed-by,Value=staging-sentinel-bootstrap.sh >/dev/null
  fi
}
rand() { openssl rand -hex 32; }

echo "== $SENTINEL_SECRET"
backend=$(get_secret "$SRC_BACKEND"); [ -n "$backend" ] || { echo "cannot read $SRC_BACKEND" >&2; exit 1; }
preview=$(get_secret "$SRC_SENTINEL")
existing=$(get_secret "$SENTINEL_SECRET"); [ -n "$existing" ] || existing='{}'
api_key=$(jq -r '.SENTINEL_API_KEY // empty' <<<"$existing"); [ "$ROTATE" = true ] || [ -z "$api_key" ] && api_key=$(rand)
admin_key=$(jq -r '.SENTINEL_ADMIN_API_KEY // empty' <<<"$existing"); [ "$ROTATE" = true ] || [ -z "$admin_key" ] && admin_key=$(rand)
jq -n \
  --argjson b "$backend" --argjson p "${preview:-{\}}" --argjson e "$existing" \
  --arg api "$api_key" --arg admin "$admin_key" '
  ($b | { MONGO_URI, SHIFT_FOUR_MONGO_URI, REDIS_HOST, REDIS_PORT, REDIS_PASSWORD, MAX_MIND_ACCOUNT_ID, MAX_MIND_LICENSE_KEY } | with_entries(select(.value != null)))
  + ($p | { ANTHROPIC_API_KEY, ANTHROPIC_WORKSPACE_ID, SENTINEL_SLACK_WEBHOOK_URL, VOYAGE_API_KEY } | with_entries(select(.value != null)))
  + ($e | del(.SENTINEL_API_KEY, .SENTINEL_ADMIN_API_KEY))   # hand-added keys survive
  + { SENTINEL_API_KEY: $api, SENTINEL_ADMIN_API_KEY: $admin, REDIS_TLS: ($b.REDIS_TLS // "false") }
' > "$T/sentinel.json"
put_secret "$SENTINEL_SECRET" "$T/sentinel.json"
echo "   keys: $(jq -r 'keys | join(", ")' "$T/sentinel.json")"

echo "== $ADMIN_SECRET"
existing_admin=$(get_secret "$ADMIN_SECRET"); [ -n "$existing_admin" ] || existing_admin='{}'
nextauth=$(jq -r '.NEXTAUTH_SECRET // empty' <<<"$existing_admin"); [ "$ROTATE" = true ] || [ -z "$nextauth" ] && nextauth=$(rand)
jq -n --argjson e "$existing_admin" --arg n "$nextauth" --arg api "$api_key" --arg admin "$admin_key" \
  '$e + { NEXTAUTH_SECRET: $n, SENTINEL_API_KEY: $api, SENTINEL_ADMIN_API_KEY: $admin }' > "$T/admin.json"
put_secret "$ADMIN_SECRET" "$T/admin.json"
echo "   keys: $(jq -r 'keys | join(", ")' "$T/admin.json")"

echo "== EKS-Moly-staging namespace $NS"
kubectl get ns "$NS" >/dev/null 2>&1 || kubectl create ns "$NS" >/dev/null
kubectl label ns "$NS" twizz-idp/tier=staging twizz-idp/managed-by=nebula-release-train --overwrite >/dev/null
echo "   ok"

echo "== Secret $NS/$K8S_ADMIN_SECRET (mirror of $ADMIN_SECRET)"
# build --from-literal args without ever echoing values
args=()
while IFS= read -r k; do
  args+=("--from-literal=$k=$(jq -r --arg k "$k" '.[$k]' "$T/admin.json")")
done < <(jq -r 'keys[]' "$T/admin.json")
kubectl -n "$NS" create secret generic "$K8S_ADMIN_SECRET" "${args[@]}" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl -n "$NS" label secret "$K8S_ADMIN_SECRET" twizz-idp/source="$(tr '/' '_' <<<"$ADMIN_SECRET")" --overwrite >/dev/null
echo "   keys: $(kubectl -n "$NS" get secret "$K8S_ADMIN_SECRET" -o json | jq -r '.data | keys | join(", ")')"

echo
echo "Done. Next: push twizz-gitops (bootstrap/apps-staging.yaml, apps/*/values-staging.yaml);"
echo "Argo app staging-twizz-sentinel / staging-twizz-admin appear at https://argocd.prv.twizz.com."
echo "Rotate keys later with --rotate, then restart both Deployments in ns $NS (they read at boot)."
