#!/usr/bin/env bash
# Fill the Nebula runtime config that was missing (audit 2026-11-05) into SM
# preview/nebula (ExternalSecret nebula-env extracts every key):
#   SENTINEL_STAGING_API_KEY   READ key of the staging twizz-sentinel (from SM staging/twizz-sentinel)
#   NEBULA_STAGING_API_URL     https://apistg.twizz.com — lets frontend previews attach to the staging API
#   VERCEL_TOKEN/VERCEL_TEAM_ID from apps/dashboard/.env.local (verified against the Vercel API first)
# Existing keys are kept; values are never printed (key names only).
#
#   AWS_PROFILE=twizz bash scripts/nebula-fill-secrets.sh
# then resync + restart:
#   kubectl --kubeconfig ~/.kube/twizz-nonprod.yaml -n nebula annotate externalsecret nebula-env force-sync=$(date +%s) --overwrite
#   kubectl --kubeconfig ~/.kube/twizz-nonprod.yaml -n nebula rollout restart deploy/dashboard
set -euo pipefail
umask 077

REGION=eu-west-1
DST=preview/nebula
ENV_FILE="$(dirname "$0")/../apps/dashboard/.env.local"
STAGING_API_URL=${NEBULA_STAGING_API_URL:-https://apistg.twizz.com}

D=$(mktemp -d)
trap 'rm -rf "$D"' EXIT
get() { aws secretsmanager get-secret-value --region "$REGION" --secret-id "$1" --query SecretString --output text; }

# staging sentinel READ key (first of the comma-separated rotation list)
get staging/twizz-sentinel | jq -r '.SENTINEL_API_KEY // empty | split(",")[0] | gsub("^\\s+|\\s+$"; "")' > "$D/sentinel"
[ -s "$D/sentinel" ] || { echo "staging/twizz-sentinel has no SENTINEL_API_KEY" >&2; exit 1; }

# Vercel token from .env.local, proven before storing
: > "$D/vtok"; : > "$D/vteam"
if [ -f "$ENV_FILE" ]; then
  sed -n 's/^VERCEL_TOKEN=//p' "$ENV_FILE" | tr -d '"'"'"'\r' | head -1 > "$D/vtok"
  sed -n 's/^VERCEL_TEAM_ID=//p' "$ENV_FILE" | tr -d '"'"'"'\r' | head -1 > "$D/vteam"
fi
if [ -s "$D/vtok" ]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -H "Authorization: Bearer $(cat "$D/vtok")" "https://api.vercel.com/v2/user")
  if [ "$code" != "200" ]; then echo "VERCEL_TOKEN from .env.local is rejected by Vercel (HTTP $code) — not stored" >&2; : > "$D/vtok"; : > "$D/vteam"; fi
else
  echo "no VERCEL_TOKEN in $ENV_FILE — skipped" >&2
fi

get "$DST" | jq --rawfile sk "$D/sentinel" --rawfile vt "$D/vtok" --rawfile vteam "$D/vteam" --arg url "$STAGING_API_URL" '
  .SENTINEL_STAGING_API_KEY = ($sk | rtrimstr("\n"))
  | .NEBULA_STAGING_API_URL = $url
  | (if ($vt | rtrimstr("\n")) != "" then .VERCEL_TOKEN = ($vt | rtrimstr("\n")) | .VERCEL_TEAM_ID = ($vteam | rtrimstr("\n")) else . end)
' > "$D/blob"
aws secretsmanager put-secret-value --region "$REGION" --secret-id "$DST" --secret-string "file://$D/blob" --query VersionId --output text | xargs echo "$DST new version:"
get "$DST" | jq -r 'keys | "keys now in '"$DST"': \(join(", "))"'
