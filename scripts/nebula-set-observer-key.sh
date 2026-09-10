#!/usr/bin/env bash
# Put the Anthropic API key (and optional Observer caps) into SM preview/nebula
# for the Nebula Observer (docs/NEBULA.md §N3.6). The dashboard's ExternalSecret
# extracts every key of the blob, so no gitops change is needed — restart the
# dashboard afterwards:
#   kubectl --kubeconfig ~/.kube/twizz-nonprod.yaml -n nebula rollout restart deploy/dashboard
#
#   AWS_PROFILE=twizz bash scripts/nebula-set-observer-key.sh            # prompts for the key
#   NEBULA_ANTHROPIC_KEY_FILE=/path AWS_PROFILE=twizz bash scripts/...   # non-interactive
#   OBSERVER_DAILY_RUNS=40 OBSERVER_DAILY_RUNS_PER_USER=15 ...           # optional caps
#   ANTHROPIC_WORKSPACE_ID=wrkspc_... ...   # only for keys not scoped to a workspace
# The key is never echoed or logged.
set -euo pipefail
umask 077

REGION=eu-west-1
SECRET=preview/nebula

if [ -n "${NEBULA_ANTHROPIC_KEY_FILE:-}" ]; then
  KEY=$(tr -d '\r\n' < "$NEBULA_ANTHROPIC_KEY_FILE")
  rm -f "$NEBULA_ANTHROPIC_KEY_FILE"
else
  read -rsp "Anthropic API key for Nebula Observer: " KEY; echo
fi
[ -n "$KEY" ] || { echo "empty key, aborting" >&2; exit 1; }

T=$(mktemp)
trap 'rm -f "$T"' EXIT

aws secretsmanager get-secret-value --secret-id "$SECRET" --region "$REGION" \
  --query SecretString --output text \
  | jq --arg key "$KEY" --arg ws "${ANTHROPIC_WORKSPACE_ID:-}" --arg daily "${OBSERVER_DAILY_RUNS:-}" --arg per "${OBSERVER_DAILY_RUNS_PER_USER:-}" '
      .ANTHROPIC_API_KEY = $key
      | (if $ws != "" then .ANTHROPIC_WORKSPACE_ID = $ws else . end)
      | (if $daily != "" then .OBSERVER_DAILY_RUNS = $daily else . end)
      | (if $per != "" then .OBSERVER_DAILY_RUNS_PER_USER = $per else . end)' > "$T"
unset KEY

aws secretsmanager put-secret-value --secret-id "$SECRET" --region "$REGION" \
  --secret-string "file://$T" --query VersionId --output text | xargs echo "$SECRET new version:"
aws secretsmanager get-secret-value --secret-id "$SECRET" --region "$REGION" \
  --query SecretString --output text \
  | jq -r '"ANTHROPIC_API_KEY: \(if .ANTHROPIC_API_KEY then "set (" + (.ANTHROPIC_API_KEY | length | tostring) + " chars)" else "missing" end)\nOBSERVER_DAILY_RUNS: \(.OBSERVER_DAILY_RUNS // "default 40")\nOBSERVER_DAILY_RUNS_PER_USER: \(.OBSERVER_DAILY_RUNS_PER_USER // "default 15")"'
