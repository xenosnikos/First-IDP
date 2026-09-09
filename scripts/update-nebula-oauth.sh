#!/usr/bin/env bash
# Switch Nebula's sign-in to the GitHub App (client Iv23liulodACgG6rqlKr) and add
# igormoly to the operator + login allowlists. Prompts for the App's client secret
# (generate it on the GitHub App settings page); value is never echoed or logged.
#
#   AWS_PROFILE=twizz bash scripts/update-nebula-oauth.sh
set -euo pipefail
umask 077

CLIENT_ID="Iv23liulodACgG6rqlKr"
# Non-interactive: NEBULA_GH_SECRET_FILE=/path (file is shredded after use).
# Interactive: prompted, never echoed.
if [ -n "${NEBULA_GH_SECRET_FILE:-}" ]; then
  GCS=$(tr -d '\r\n' < "$NEBULA_GH_SECRET_FILE")
  shred -u "$NEBULA_GH_SECRET_FILE" 2>/dev/null || rm -f "$NEBULA_GH_SECRET_FILE"
else
  read -rsp "GitHub App client secret for ${CLIENT_ID}: " GCS; echo
fi
[ -n "$GCS" ] || { echo "empty secret, aborting" >&2; exit 1; }

T=$(mktemp)
trap 'shred -u "$T" 2>/dev/null || rm -f "$T"' EXIT

aws secretsmanager get-secret-value --secret-id preview/nebula --region eu-west-1 \
  --query SecretString --output text \
| jq --arg id "$CLIENT_ID" --arg gcs "$GCS" '
    .GITHUB_CLIENT_ID = $id
  | .GITHUB_CLIENT_SECRET = $gcs
  | .NEBULA_OPERATORS = "xenosnikos,TwizzyNicky,igormoly"
  | .ALLOWED_GITHUB_LOGINS = "xenosnikos,TwizzyNicky,bright-nik,algoniko,igormoly"' > "$T"
unset GCS

aws secretsmanager put-secret-value --secret-id preview/nebula --region eu-west-1 \
  --secret-string "file://$T" --query VersionId --output text | xargs echo "preview/nebula new version:"
echo "client id now: $(aws secretsmanager get-secret-value --secret-id preview/nebula --region eu-west-1 --query SecretString --output text | jq -r .GITHUB_CLIENT_ID)"
echo "operators now: $(aws secretsmanager get-secret-value --secret-id preview/nebula --region eu-west-1 --query SecretString --output text | jq -r .NEBULA_OPERATORS)"
