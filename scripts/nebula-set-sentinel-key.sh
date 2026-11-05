#!/usr/bin/env bash
# Give Nebula's MCP endpoint read access to the STAGING twizz-sentinel API
# (docs/NEBULA.md §N7): copies the READ key (SENTINEL_API_KEY, never the admin
# key) from SM staging/twizz-sentinel into SM preview/nebula as
# SENTINEL_STAGING_API_KEY (ExternalSecret nebula-env extracts every key).
#
#   AWS_PROFILE=twizz bash scripts/nebula-set-sentinel-key.sh
#   # production (once twizz-sentinel runs on EKS-Moly-Prod AND has an endpoint
#   # Nebula can reach — values-prod.yaml has no ingress today):
#   NEBULA_SENTINEL_PROD_URL=https://… AWS_PROFILE=twizz bash scripts/nebula-set-sentinel-key.sh --prod
#
# Then resync + restart (the pod reads env at start):
#   kubectl --kubeconfig ~/.kube/twizz-nonprod.yaml -n nebula annotate externalsecret nebula-env force-sync=$(date +%s) --overwrite
#   kubectl --kubeconfig ~/.kube/twizz-nonprod.yaml -n nebula rollout restart deploy/dashboard
# Values are never printed; only key names are echoed back.
set -euo pipefail
umask 077

REGION=eu-west-1
SRC=staging/twizz-sentinel
DST=preview/nebula
KEY=SENTINEL_STAGING_API_KEY
URL_KEY=""
if [ "${1:-}" = "--prod" ]; then
  SRC=prod/twizz-sentinel
  KEY=SENTINEL_PROD_API_KEY
  URL_KEY=NEBULA_SENTINEL_PROD_URL
  : "${NEBULA_SENTINEL_PROD_URL:?--prod needs NEBULA_SENTINEL_PROD_URL (the endpoint Nebula reaches prod sentinel on)}"
fi

T=$(mktemp)
K=$(mktemp)
trap 'rm -f "$T" "$K"' EXIT

# first key of the (comma-separated, rotatable) read-key list
aws secretsmanager get-secret-value --secret-id "$SRC" --region "$REGION" --query SecretString --output text \
  | jq -r '.SENTINEL_API_KEY // empty | split(",")[0] | gsub("^\\s+|\\s+$"; "")' > "$K"
[ -s "$K" ] || { echo "$SRC has no SENTINEL_API_KEY — nothing stored" >&2; exit 1; }

aws secretsmanager get-secret-value --secret-id "$DST" --region "$REGION" --query SecretString --output text \
  | jq --rawfile key "$K" --arg k "$KEY" --arg uk "$URL_KEY" --arg url "${NEBULA_SENTINEL_PROD_URL:-}" \
      '.[$k] = ($key | rtrimstr("\n")) | (if $uk != "" then .[$uk] = $url else . end)' > "$T"
aws secretsmanager put-secret-value --secret-id "$DST" --region "$REGION" \
  --secret-string "file://$T" --query VersionId --output text | xargs echo "$DST new version:"
aws secretsmanager get-secret-value --secret-id "$DST" --region "$REGION" --query SecretString --output text \
  | jq -r '[keys[] | select(startswith("SENTINEL_") or startswith("NEBULA_SENTINEL_"))] | "sentinel keys now in '"$DST"': \(join(", "))"'
