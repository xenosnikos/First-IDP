#!/usr/bin/env bash
# One-time: create Secrets Manager `preview/nebula` for the in-cluster Nebula UI
# and its Postgres. Generates a fresh POSTGRES_PASSWORD and AUTH_SECRET; reuses
# the GitHub OAuth client secret from apps/dashboard/.env.local (client
# Ov23lirMDHUPPYwRkz5A). Prints key NAMES only, never values.
#
#   AWS_PROFILE=twizz bash scripts/create-nebula-secret.sh
#
# ONE-TIME bootstrap. Later user changes: scripts/nebula-allow-login.sh (see the
# twizz-nebula-users skill). Sign-in now uses the GitHub App twizz-nebula
# (client Iv23liulodACgG6rqlKr, STATE.md 2026-09-09); the values below are the seed.
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."

T=$(mktemp)
trap 'shred -u "$T" 2>/dev/null || rm -f "$T"' EXIT

PGPW=$(openssl rand -hex 24)
AUTHS=$(openssl rand -base64 48 | tr -d '\n')
GCS=$(grep -E '^GITHUB_CLIENT_SECRET=' apps/dashboard/.env.local | cut -d= -f2- | tr -d "\"'")
[ -n "$GCS" ] || { echo "GITHUB_CLIENT_SECRET not found in apps/dashboard/.env.local" >&2; exit 1; }

jq -n --arg pgpw "$PGPW" --arg auths "$AUTHS" --arg gcs "$GCS" '{
  POSTGRES_USER: "nebula",
  POSTGRES_DB: "nebula",
  POSTGRES_PASSWORD: $pgpw,
  DATABASE_URL: ("postgresql://nebula:" + $pgpw + "@postgres.nebula.svc.cluster.local:5432/nebula?schema=public"),
  AUTH_SECRET: $auths,
  NEXTAUTH_SECRET: $auths,
  AUTH_URL: "https://nebula.prv.twizz.com",
  NEXTAUTH_URL: "https://nebula.prv.twizz.com",
  AUTH_TRUST_HOST: "true",
  GITHUB_CLIENT_ID: "Ov23lirMDHUPPYwRkz5A",
  GITHUB_CLIENT_SECRET: $gcs,
  NEBULA_OPERATORS: "xenosnikos,TwizzyNicky",
  ALLOWED_GITHUB_LOGINS: "xenosnikos,TwizzyNicky,bright-nik,algoniko",
  AWS_REGION: "eu-west-1"
}' > "$T"
unset PGPW AUTHS GCS

aws secretsmanager create-secret --region eu-west-1 --name preview/nebula \
  --description "Nebula UI (in-cluster) + its Postgres: DATABASE_URL, Auth.js, GitHub OAuth client, operator allowlist" \
  --secret-string "file://$T" --tags Key=Project,Value=twizz-idp \
  --query Name --output text

echo "keys: $(aws secretsmanager get-secret-value --secret-id preview/nebula --region eu-west-1 --query SecretString --output text | jq -r 'keys|join(", ")')"
