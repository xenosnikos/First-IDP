#!/usr/bin/env bash
# Grant a GitHub login access to Nebula (https://nebula.prv.twizz.com).
#
# Sign-in passes three gates: NetBird VPN (`staff` group), the global Google
# SSO gate (any twizz.com account), then Nebula's own allowlist of GitHub logins
# (ALLOWED_GITHUB_LOGINS in SM preview/nebula, consumed by the dashboard pod).
# This script edits only the last one. Add --operator to also grant write
# actions (NEBULA_OPERATORS; keep that list short).
#
#   AWS_PROFILE=twizz bash scripts/nebula-allow-login.sh <github-login> [--operator]
#
# The dashboard reads the secret as env at start: restart it afterwards
#   kubectl --kubeconfig ~/.kube/twizz-nonprod.yaml -n nebula rollout restart deploy/dashboard
# Secret values are never printed; only the two allowlists are echoed back.
set -euo pipefail
umask 077

LOGIN=$(echo "${1:?usage: nebula-allow-login.sh <github-login> [--operator]}" | tr '[:upper:]' '[:lower:]')
OPERATOR=false
[ "${2:-}" = "--operator" ] && OPERATOR=true
REGION=eu-west-1
SECRET=preview/nebula

T=$(mktemp)
trap 'rm -f "$T"' EXIT

add_login='def addto(k): .[k] = ((.[k] // "" | split(",") | map(select(length > 0))) + [$login] | unique | join(","));
  addto("ALLOWED_GITHUB_LOGINS") | (if $op then addto("NEBULA_OPERATORS") else . end)'

aws secretsmanager get-secret-value --secret-id "$SECRET" --region "$REGION" \
  --query SecretString --output text \
  | jq --arg login "$LOGIN" --argjson op "$OPERATOR" "$add_login" > "$T"

aws secretsmanager put-secret-value --secret-id "$SECRET" --region "$REGION" \
  --secret-string "file://$T" --query VersionId --output text | xargs echo "$SECRET new version:"

aws secretsmanager get-secret-value --secret-id "$SECRET" --region "$REGION" \
  --query SecretString --output text \
  | jq -r '"ALLOWED_GITHUB_LOGINS: \(.ALLOWED_GITHUB_LOGINS)\nNEBULA_OPERATORS:      \(.NEBULA_OPERATORS)"'
