#!/usr/bin/env bash
# Grant a GitHub login access to Nebula (https://nebula.prv.twizz.com).
#
# Sign-in passes three gates: NetBird VPN (`staff` group), the global Google
# SSO gate (any twizz.com account), then Nebula's own allowlist of GitHub logins
# (ALLOWED_GITHUB_LOGINS in SM preview/nebula, consumed by the dashboard pod).
# This script edits only the last one. Add --operator to also grant write
# actions (NEBULA_OPERATORS; keep that list short). Add --mcp to also let them
# use the Nebula MCP endpoint / twizz-nebula plugin (NEBULA_MCP_USERS, §N7: a
# separate, explicit list; operators always have it). --revoke-mcp removes MCP only.
#
#   AWS_PROFILE=twizz bash scripts/nebula-allow-login.sh <github-login> [--operator] [--mcp]
#   AWS_PROFILE=twizz bash scripts/nebula-allow-login.sh <github-login> --revoke-mcp
#
# The dashboard reads the secret as env at start: restart it afterwards
#   kubectl --kubeconfig ~/.kube/twizz-nonprod.yaml -n nebula rollout restart deploy/dashboard
# Secret values are never printed; only the two allowlists are echoed back.
set -euo pipefail
umask 077

LOGIN=$(echo "${1:?usage: nebula-allow-login.sh <github-login> [--operator] [--mcp] | --revoke-mcp}" | tr '[:upper:]' '[:lower:]')
shift
OPERATOR=false
MCP=false
REVOKE_MCP=false
for a in "$@"; do
  case "$a" in
    --operator) OPERATOR=true ;;
    --mcp) MCP=true ;;
    --revoke-mcp) REVOKE_MCP=true ;;
    *) echo "unknown flag: $a" >&2; exit 2 ;;
  esac
done
REGION=eu-west-1
SECRET=preview/nebula

T=$(mktemp)
trap 'rm -f "$T"' EXIT

add_login='def items(k): (.[k] // "" | split(",") | map(select(length > 0)));
  def addto(k): .[k] = ((items(k) + [$login]) | unique | join(","));
  def delfrom(k): .[k] = (items(k) | map(select(. != $login)) | join(","));
  if $revoke then delfrom("NEBULA_MCP_USERS")
  else addto("ALLOWED_GITHUB_LOGINS") | (if $op then addto("NEBULA_OPERATORS") else . end) | (if $mcp then addto("NEBULA_MCP_USERS") else . end)
  end'

aws secretsmanager get-secret-value --secret-id "$SECRET" --region "$REGION" \
  --query SecretString --output text \
  | jq --arg login "$LOGIN" --argjson op "$OPERATOR" --argjson mcp "$MCP" --argjson revoke "$REVOKE_MCP" "$add_login" > "$T"

aws secretsmanager put-secret-value --secret-id "$SECRET" --region "$REGION" \
  --secret-string "file://$T" --query VersionId --output text | xargs echo "$SECRET new version:"

aws secretsmanager get-secret-value --secret-id "$SECRET" --region "$REGION" \
  --query SecretString --output text \
  | jq -r '"ALLOWED_GITHUB_LOGINS: \(.ALLOWED_GITHUB_LOGINS)\nNEBULA_OPERATORS:      \(.NEBULA_OPERATORS)\nNEBULA_MCP_USERS:      \(.NEBULA_MCP_USERS // "(unset: operators only)")"'
