#!/usr/bin/env bash
# Least-privilege AWS identities for the Nebula MCP (docs/NEBULA.md §N7.1).
#
# An MCP user's AWS credentials exist ONLY to prove who they are: the plugin
# presigns sts:GetCallerIdentity (which needs no permission) and Nebula checks
# the ARN. So the IAM users (path /nebula-mcp/, group nebula-mcp-users) may do
# nothing except manage their OWN password, MFA and access keys — key creation
# requires MFA — and explicit Denies (everything else; any credential action on
# another user; key changes without MFA) mean even a policy attached by mistake
# can't be used to escalate. Idempotent.
#
#   AWS_PROFILE=twizz bash scripts/nebula-mcp-iam.sh                 # group + policy
#   AWS_PROFILE=twizz bash scripts/nebula-mcp-iam.sh user <name>     # + IAM user /nebula-mcp/<name> with a
#                                                                    #   one-time console password (printed once)
# The person then signs in, sets MFA, and mints their own access key
# (docs in TwizzyNicky/nebula-mcp: ONBOARDING.md).
set -euo pipefail
umask 077

ACCOUNT=848281935985
GROUP=nebula-mcp-users
IAM_PATH=/nebula-mcp/
POLICY_NAME=NebulaMcpSelfServiceOnly
SELF="arn:aws:iam::$ACCOUNT:user${IAM_PATH}\${aws:username}"
MFA="arn:aws:iam::$ACCOUNT:mfa/\${aws:username}*"

T=$(mktemp)
trap 'rm -f "$T"' EXIT
cat > "$T" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "AccountLevelReads", "Effect": "Allow", "Action": ["iam:GetAccountPasswordPolicy", "iam:GetAccountSummary", "iam:ListVirtualMFADevices"], "Resource": "*" },
    { "Sid": "OwnUserSelfService", "Effect": "Allow",
      "Action": ["iam:GetUser", "iam:GetLoginProfile", "iam:ChangePassword", "iam:ListAccessKeys", "iam:GetAccessKeyLastUsed", "iam:ListMFADevices",
                 "iam:EnableMFADevice", "iam:ResyncMFADevice", "iam:ListSigningCertificates", "iam:ListSSHPublicKeys", "iam:ListServiceSpecificCredentials"],
      "Resource": "$SELF" },
    { "Sid": "OwnVirtualMfa", "Effect": "Allow", "Action": ["iam:CreateVirtualMFADevice", "iam:DeleteVirtualMFADevice"], "Resource": "$MFA" },
    { "Sid": "OwnAccessKeysWithMfa", "Effect": "Allow", "Action": ["iam:CreateAccessKey", "iam:UpdateAccessKey", "iam:DeleteAccessKey"],
      "Resource": "$SELF", "Condition": { "Bool": { "aws:MultiFactorAuthPresent": "true" } } },
    { "Sid": "DenyEverythingElse", "Effect": "Deny",
      "NotAction": ["iam:GetAccountPasswordPolicy", "iam:GetAccountSummary", "iam:ListVirtualMFADevices", "iam:GetUser", "iam:GetLoginProfile", "iam:ChangePassword",
                    "iam:ListAccessKeys", "iam:GetAccessKeyLastUsed", "iam:CreateAccessKey", "iam:UpdateAccessKey", "iam:DeleteAccessKey",
                    "iam:ListMFADevices", "iam:CreateVirtualMFADevice", "iam:DeleteVirtualMFADevice", "iam:EnableMFADevice", "iam:ResyncMFADevice",
                    "iam:ListSigningCertificates", "iam:ListSSHPublicKeys", "iam:ListServiceSpecificCredentials", "sts:GetCallerIdentity", "sts:GetSessionToken"],
      "Resource": "*" },
    { "Sid": "DenyCredentialActionsOnAnyoneElse", "Effect": "Deny",
      "Action": ["iam:GetUser", "iam:GetLoginProfile", "iam:ChangePassword", "iam:ListAccessKeys", "iam:GetAccessKeyLastUsed", "iam:CreateAccessKey",
                 "iam:UpdateAccessKey", "iam:DeleteAccessKey", "iam:ListMFADevices", "iam:EnableMFADevice", "iam:ResyncMFADevice",
                 "iam:CreateVirtualMFADevice", "iam:DeleteVirtualMFADevice", "iam:ListSigningCertificates", "iam:ListSSHPublicKeys", "iam:ListServiceSpecificCredentials"],
      "NotResource": ["$SELF", "$MFA"] },
    { "Sid": "DenyKeyChangesWithoutMfa", "Effect": "Deny", "Action": ["iam:CreateAccessKey", "iam:UpdateAccessKey"], "Resource": "*",
      "Condition": { "BoolIfExists": { "aws:MultiFactorAuthPresent": "false" } } }
  ]
}
EOF
jq -e . "$T" >/dev/null

echo "== group $GROUP (path $IAM_PATH)"
aws iam get-group --group-name "$GROUP" >/dev/null 2>&1 || aws iam create-group --group-name "$GROUP" --path "$IAM_PATH" >/dev/null
aws iam put-group-policy --group-name "$GROUP" --policy-name "$POLICY_NAME" --policy-document "file://$T"
attached=$(aws iam list-attached-group-policies --group-name "$GROUP" --query 'AttachedPolicies[].PolicyName' --output text)
[ -z "$attached" ] || echo "   WARNING: managed policies attached to $GROUP: $attached (the Deny still neutralises them)" >&2
echo "   ok: inline $POLICY_NAME only"

if [ "${1:-}" = "user" ]; then
  NAME=$(echo "${2:?usage: nebula-mcp-iam.sh user <name>}" | tr '[:upper:]' '[:lower:]')
  [[ "$NAME" =~ ^[a-z][a-z0-9.-]{1,40}$ ]] || { echo "bad name: $NAME" >&2; exit 2; }
  echo "== user ${IAM_PATH}$NAME"
  if ! aws iam get-user --user-name "$NAME" >/dev/null 2>&1; then
    aws iam create-user --user-name "$NAME" --path "$IAM_PATH" --tags Key=Project,Value=nebula-mcp >/dev/null
  fi
  path=$(aws iam get-user --user-name "$NAME" --query User.Path --output text)
  [ "$path" = "$IAM_PATH" ] || { echo "user $NAME exists with path $path (not $IAM_PATH) — refusing to reuse it" >&2; exit 1; }
  aws iam add-user-to-group --user-name "$NAME" --group-name "$GROUP"
  others=$(aws iam list-groups-for-user --user-name "$NAME" --query "Groups[?GroupName!='$GROUP'].GroupName" --output text)
  pols=$(aws iam list-attached-user-policies --user-name "$NAME" --query 'AttachedPolicies[].PolicyName' --output text)
  [ -z "$others$pols" ] || echo "   WARNING: $NAME has other groups/policies: $others $pols" >&2
  if ! aws iam get-login-profile --user-name "$NAME" >/dev/null 2>&1; then
    pw="Nb-$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 20)-9!"
    aws iam create-login-profile --user-name "$NAME" --password "$pw" --password-reset-required >/dev/null
    echo "   one-time console password (send it privately; they must change it at first sign-in):"
    echo "   $pw"
  else
    echo "   console login already exists"
  fi
  echo "   ARN: arn:aws:iam::$ACCOUNT:user${IAM_PATH}$NAME"
  echo "   sign-in: https://$ACCOUNT.signin.aws.amazon.com/console"
fi
