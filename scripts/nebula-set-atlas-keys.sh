#!/usr/bin/env bash
# Give Nebula read (and NonProd tier-change) access to MongoDB Atlas: merges
# ATLAS_PUBLIC_KEY / ATLAS_PRIVATE_KEY / ATLAS_PROJECT_ID into SM preview/nebula
# (ExternalSecret nebula-env extracts every key; docs/NEBULA.md §N5).
#
# The key pair is read from the environment, or from apps/dashboard/.env.local
# when unset. Atlas programmatic keys use HTTP Digest auth; the key needs
# Project Cluster Manager on the project to change the NonProd-Twizz tier.
#
#   AWS_PROFILE=twizz bash scripts/nebula-set-atlas-keys.sh
#
# Then resync + restart (the pod reads env at start):
#   kubectl --kubeconfig ~/.kube/twizz-nonprod.yaml -n nebula annotate externalsecret nebula-env force-sync=$(date +%s) --overwrite
#   kubectl --kubeconfig ~/.kube/twizz-nonprod.yaml -n nebula rollout restart deploy/dashboard
# Values are never printed; only the key names are echoed back.
set -euo pipefail
umask 077

REGION=eu-west-1
SECRET=preview/nebula
ENV_FILE="$(dirname "$0")/../apps/dashboard/.env.local"

if [ -z "${ATLAS_PUBLIC_KEY:-}" ] && [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  eval "$(grep -E '^(ATLAS_PUBLIC_KEY|ATLAS_PRIVATE_KEY|ATLAS_PROJECT_ID)=' "$ENV_FILE")"
  set +a
fi
: "${ATLAS_PUBLIC_KEY:?ATLAS_PUBLIC_KEY not set}" "${ATLAS_PRIVATE_KEY:?ATLAS_PRIVATE_KEY not set}" "${ATLAS_PROJECT_ID:?ATLAS_PROJECT_ID not set}"

# Prove the key works (Digest) before storing it.
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 --digest -u "$ATLAS_PUBLIC_KEY:$ATLAS_PRIVATE_KEY" \
  -H 'Accept: application/vnd.atlas.2023-11-15+json' "https://cloud.mongodb.com/api/atlas/v2/groups/$ATLAS_PROJECT_ID/clusters")
[ "$code" = "200" ] || { echo "Atlas rejected the key (HTTP $code) — not stored" >&2; exit 1; }

T=$(mktemp)
trap 'rm -f "$T"' EXIT
aws secretsmanager get-secret-value --secret-id "$SECRET" --region "$REGION" --query SecretString --output text \
  | jq --arg pub "$ATLAS_PUBLIC_KEY" --arg priv "$ATLAS_PRIVATE_KEY" --arg pid "$ATLAS_PROJECT_ID" \
      '.ATLAS_PUBLIC_KEY = $pub | .ATLAS_PRIVATE_KEY = $priv | .ATLAS_PROJECT_ID = $pid' > "$T"
aws secretsmanager put-secret-value --secret-id "$SECRET" --region "$REGION" \
  --secret-string "file://$T" --query VersionId --output text | xargs echo "$SECRET new version:"
aws secretsmanager get-secret-value --secret-id "$SECRET" --region "$REGION" --query SecretString --output text \
  | jq -r '[keys[] | select(startswith("ATLAS_"))] | "Atlas keys now in '"$SECRET"': \(join(", "))"'
