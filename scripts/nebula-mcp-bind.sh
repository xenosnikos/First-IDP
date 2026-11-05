#!/usr/bin/env bash
# Bind a person's three identities for the Nebula MCP (docs/NEBULA.md §N7.1):
# NEBULA_MCP_IDENTITIES in SM preview/nebula = {"<github login>": {"google": …, "aws": …}}.
# A binding IS the MCP access list: no binding, no MCP (operators included).
#
#   AWS_PROFILE=twizz bash scripts/nebula-mcp-bind.sh <github-login> <google-email> <aws-iam-user-name>
#   AWS_PROFILE=twizz bash scripts/nebula-mcp-bind.sh <github-login> --remove
#
# The AWS user must be /nebula-mcp/<name> (scripts/nebula-mcp-iam.sh user <name>), the
# Google account a verified @twizz.com one, and the GitHub login already allowed on
# Nebula (scripts/nebula-allow-login.sh). Restart the dashboard after (env at start).
set -euo pipefail
umask 077

REGION=eu-west-1
SECRET=preview/nebula
ACCOUNT=848281935985
LOGIN=$(echo "${1:?usage: nebula-mcp-bind.sh <github-login> <google-email> <aws-iam-user> | --remove}" | tr '[:upper:]' '[:lower:]')
T=$(mktemp)
trap 'rm -f "$T"' EXIT

if [ "${2:-}" = "--remove" ]; then
  prog='.NEBULA_MCP_IDENTITIES = ((.NEBULA_MCP_IDENTITIES // "{}" | fromjson) | del(.[$login]) | tojson)'
  args=(--arg login "$LOGIN")
else
  GOOGLE=$(echo "${2:?google email}" | tr '[:upper:]' '[:lower:]')
  AWSUSER=$(echo "${3:?aws iam user name}" | tr '[:upper:]' '[:lower:]')
  [[ "$GOOGLE" =~ ^[a-z0-9._%+-]+@twizz\.com$ ]] || { echo "google must be a @twizz.com address" >&2; exit 2; }
  path=$(aws iam get-user --user-name "$AWSUSER" --query User.Path --output text 2>/dev/null || true)
  [ "$path" = "/nebula-mcp/" ] || { echo "IAM user $AWSUSER not found under /nebula-mcp/ (run scripts/nebula-mcp-iam.sh user $AWSUSER)" >&2; exit 1; }
  allowed=$(aws secretsmanager get-secret-value --region "$REGION" --secret-id "$SECRET" --query SecretString --output text | jq -r '.ALLOWED_GITHUB_LOGINS // "" | ascii_downcase')
  [[ ",$allowed," == *",$LOGIN,"* ]] || echo "note: $LOGIN is not in ALLOWED_GITHUB_LOGINS (fine only if they are an active twizz-app member)" >&2
  prog='.NEBULA_MCP_IDENTITIES = ((.NEBULA_MCP_IDENTITIES // "{}" | fromjson) + {($login): {google: $google, aws: $arn}} | tojson)'
  args=(--arg login "$LOGIN" --arg google "$GOOGLE" --arg arn "arn:aws:iam::$ACCOUNT:user/nebula-mcp/$AWSUSER")
fi

aws secretsmanager get-secret-value --region "$REGION" --secret-id "$SECRET" --query SecretString --output text | jq "${args[@]}" "$prog" > "$T"
aws secretsmanager put-secret-value --region "$REGION" --secret-id "$SECRET" --secret-string "file://$T" --query VersionId --output text | xargs echo "$SECRET new version:"
# bindings are identities, not secrets: safe to show
aws secretsmanager get-secret-value --region "$REGION" --secret-id "$SECRET" --query SecretString --output text | jq -r '.NEBULA_MCP_IDENTITIES | fromjson'
