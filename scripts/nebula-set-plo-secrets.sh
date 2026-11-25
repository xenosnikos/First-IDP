#!/usr/bin/env bash
# The shared bearer token between the PLO CronJobs and Nebula's lifecycle ingest routes
# (docs/NEBULA.md §N9). One random value, stored twice:
#   SM preview/plo     NEBULA_INGEST_TOKEN      -> ExternalSecret plo-env (twizz-gitops apps/nebula/plo.yaml)
#   SM preview/nebula  LIFECYCLE_INGEST_TOKEN   -> ExternalSecret nebula-env (the dashboard; every other key is kept)
# The dashboard answers 503 on every lifecycle ingest call while its copy is unset or shorter
# than 32 characters, and 401 while the two copies differ.
#
#   AWS_PROFILE=twizz bash scripts/nebula-set-plo-secrets.sh            # create what is missing, repair a mismatch
#   AWS_PROFILE=twizz bash scripts/nebula-set-plo-secrets.sh --rotate   # mint a new token
#
# Idempotent: with a valid token already in preview/plo it mints nothing and writes preview/nebula
# only if its copy differs. preview/plo is the source of truth; preview/nebula follows it.
# The token is 32 bytes from the system CSPRNG (openssl rand), hex encoded (64 characters).
# It is never printed, never passed on a command line and never leaves a 0600 temp file that is
# removed on exit. Only key names are echoed back.
#
# Then (the script prints these; it does not run them):
#   kubectl --kubeconfig ~/.kube/twizz-nonprod.yaml -n nebula annotate externalsecret nebula-env force-sync=$(date +%s) --overwrite
#   kubectl --kubeconfig ~/.kube/twizz-nonprod.yaml -n nebula annotate externalsecret plo-env force-sync=$(date +%s) --overwrite
#   kubectl --kubeconfig ~/.kube/twizz-nonprod.yaml -n nebula rollout restart deploy/dashboard
# After --rotate, PLO jobs get 401 until both ExternalSecrets have synced and the dashboard has
# restarted: rotate outside the job windows (UTC: daily 05:30, Mondays 06:00, the 2nd 07:00).
set -euo pipefail
umask 077

ACCOUNT=848281935985
REGION=eu-west-1
PLO_SECRET=preview/plo
PLO_KEY=NEBULA_INGEST_TOKEN
NEBULA_SECRET=preview/nebula
NEBULA_KEY=LIFECYCLE_INGEST_TOKEN
MIN_LEN=32
ROTATE=false
case "${1:-}" in
  "") ;;
  --rotate) ROTATE=true ;;
  *) echo "unknown argument: $1 (only --rotate)" >&2; exit 2 ;;
esac

# ── refuse to run against the wrong account ──────────────────────────
[ -n "${AWS_PROFILE:-}" ] || { echo "refusing to run: AWS_PROFILE is not set. Use: AWS_PROFILE=twizz bash $0" >&2; exit 1; }
for bin in aws jq openssl; do command -v "$bin" >/dev/null || { echo "$bin is required" >&2; exit 1; }; done
GOT=$(aws sts get-caller-identity --query Account --output text)
[ "$GOT" = "$ACCOUNT" ] || { echo "refusing to run: AWS_PROFILE=$AWS_PROFILE is account $GOT, expected $ACCOUNT" >&2; exit 1; }

D=$(mktemp -d)
trap 'rm -rf "$D"' EXIT
exists() { aws secretsmanager describe-secret --region "$REGION" --secret-id "$1" >/dev/null 2>&1; }
get() { aws secretsmanager get-secret-value --region "$REGION" --secret-id "$1" --query SecretString --output text; }

# The dashboard's blob must already exist: this script only adds one key to it.
exists "$NEBULA_SECRET" || { echo "$NEBULA_SECRET does not exist (scripts/create-nebula-secret.sh); nothing written" >&2; exit 1; }
get "$NEBULA_SECRET" > "$D/nebula.json"
jq -e 'type == "object"' "$D/nebula.json" >/dev/null || { echo "$NEBULA_SECRET is not a JSON object; nothing written" >&2; exit 1; }

# ── preview/plo: keep a valid token unless --rotate ──────────────────
PLO_EXISTS=false
echo '{}' > "$D/plo.json"
if exists "$PLO_SECRET"; then
  PLO_EXISTS=true
  get "$PLO_SECRET" > "$D/plo.json"
  jq -e 'type == "object"' "$D/plo.json" >/dev/null || { echo "$PLO_SECRET is not a JSON object; nothing written" >&2; exit 1; }
fi
jq -r --arg k "$PLO_KEY" '.[$k] // "" | tostring' "$D/plo.json" | tr -d '\r\n' > "$D/token"
if $ROTATE || [ "$(wc -c < "$D/token")" -lt "$MIN_LEN" ]; then
  openssl rand -hex 32 | tr -d '\r\n' > "$D/token"
  [ "$(wc -c < "$D/token")" -eq 64 ] || { echo "token generation failed; nothing written" >&2; exit 1; }
  jq --rawfile t "$D/token" --arg k "$PLO_KEY" '.[$k] = $t' "$D/plo.json" > "$D/plo.new.json"
  if $PLO_EXISTS; then
    aws secretsmanager put-secret-value --region "$REGION" --secret-id "$PLO_SECRET" --secret-string "file://$D/plo.new.json" --query VersionId --output text | xargs echo "$PLO_SECRET new version:"
  else
    aws secretsmanager create-secret --region "$REGION" --name "$PLO_SECRET" --secret-string "file://$D/plo.new.json" \
      --description "PLO CronJobs in Nebula: bearer token for the lifecycle ingest routes (scripts/nebula-set-plo-secrets.sh)" \
      --tags Key=Project,Value=twizz-idp Key=managed-by,Value=nebula-set-plo-secrets.sh --query Name --output text | xargs echo "created:"
  fi
  if $ROTATE; then echo "$PLO_SECRET: $PLO_KEY rotated"; else echo "$PLO_SECRET: $PLO_KEY generated"; fi
else
  echo "$PLO_SECRET: $PLO_KEY already set, kept (use --rotate for a new one)"
fi

# ── preview/nebula: follow preview/plo, touch no other key ───────────
jq --rawfile t "$D/token" --arg k "$NEBULA_KEY" '.[$k] = $t' "$D/nebula.json" > "$D/nebula.new.json"
if [ "$(jq -S . "$D/nebula.json" | openssl dgst -sha256)" = "$(jq -S . "$D/nebula.new.json" | openssl dgst -sha256)" ]; then
  echo "$NEBULA_SECRET: $NEBULA_KEY already matches, not written"
else
  [ "$(jq -S --arg k "$NEBULA_KEY" 'del(.[$k])' "$D/nebula.json" | openssl dgst -sha256)" = "$(jq -S --arg k "$NEBULA_KEY" 'del(.[$k])' "$D/nebula.new.json" | openssl dgst -sha256)" ] \
    || { echo "refusing to write $NEBULA_SECRET: the merge would change its other keys" >&2; exit 1; }
  aws secretsmanager put-secret-value --region "$REGION" --secret-id "$NEBULA_SECRET" --secret-string "file://$D/nebula.new.json" --query VersionId --output text | xargs echo "$NEBULA_SECRET new version:"
fi

# ── read back: key names and a match verdict, never a value ──────────
get "$PLO_SECRET" > "$D/plo.check.json"
get "$NEBULA_SECRET" > "$D/nebula.check.json"
echo "keys now in $PLO_SECRET: $(jq -r 'keys | join(", ")' "$D/plo.check.json")"
echo "$NEBULA_SECRET has $(jq -r 'keys | length' "$D/nebula.check.json") keys, including: $(jq -r --arg k "$NEBULA_KEY" '[keys[] | select(. == $k)] | join(", ")' "$D/nebula.check.json")"
if jq -e -n --slurpfile p "$D/plo.check.json" --slurpfile n "$D/nebula.check.json" --arg pk "$PLO_KEY" --arg nk "$NEBULA_KEY" --argjson min "$MIN_LEN" \
     '($p[0][$pk] // "") as $a | ($n[0][$nk] // "") as $b | ($a | type) == "string" and ($a | length) >= $min and $a == $b' >/dev/null; then
  echo "ok: both copies are set, equal and at least $MIN_LEN characters"
else
  echo "FAILED: the two copies are missing, short or different after writing" >&2
  exit 1
fi

cat <<'EOF'

Next (not run by this script):
  kubectl --kubeconfig ~/.kube/twizz-nonprod.yaml -n nebula annotate externalsecret nebula-env force-sync=$(date +%s) --overwrite
  kubectl --kubeconfig ~/.kube/twizz-nonprod.yaml -n nebula annotate externalsecret plo-env force-sync=$(date +%s) --overwrite   # once apps/nebula/plo.yaml is merged
  kubectl --kubeconfig ~/.kube/twizz-nonprod.yaml -n nebula rollout restart deploy/dashboard
EOF
