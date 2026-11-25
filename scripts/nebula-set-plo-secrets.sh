#!/usr/bin/env bash
# The bearer token between the PLO CronJobs and Nebula's lifecycle ingest routes
# (docs/NEBULA.md §N9). TWO tokens, ONE copy of each, both in SM nebula/plo:
#   NEBULA_INGEST_TOKEN     -> ExternalSecret plo-env (twizz-gitops apps/nebula/plo.yaml)
#       the PUBLISHER's: plo-plan, plo-cve and the `publish` container of plo-source present it;
#       the dashboard reads the same Kubernetes Secret as LIFECYCLE_INGEST_TOKEN.
#   NEBULA_DISPATCH_TOKEN   -> ExternalSecret plo-dispatch-env (same file)
#       the DISPATCHER's: only plo-dispatch presents it (as its NEBULA_INGEST_TOKEN); the dashboard
#       reads the same Secret as LIFECYCLE_DISPATCH_TOKEN. With it set, claiming and completing
#       requests and posting a SMOKE result (the one piece of gate evidence that is the caller's
#       own word) need this token, and the publisher token is refused for them — so the pod that
#       publishes next to untrusted repository code cannot answer a smoke request.
# Each side reads the same Kubernetes Secret as its peer, so the two can never hold different
# values. The dashboard answers 503 on every lifecycle ingest call while the ingest token is
# unset or shorter than 32 characters, or while the dispatch token is set but short or equal to
# the ingest token.
#
# Why NOT under preview/*: the role of every preview pod (twizz-nonprod-preview-pods) may
# GetSecretValue on preview/*, and those pods include the previews of the very upgrades this
# token gates. Nothing under nebula/* is readable by that role. External Secrets can read
# nebula/plo only after `pulumi up` in infra/addons (it adds exactly that secret to twizz-eso).
#
#   AWS_PROFILE=twizz bash scripts/nebula-set-plo-secrets.sh                        # create it if missing
#   AWS_PROFILE=twizz bash scripts/nebula-set-plo-secrets.sh --rotate               # mint a new token
#   AWS_PROFILE=twizz bash scripts/nebula-set-plo-secrets.sh --remove-legacy-copy   # see below
#
# Idempotent: with both tokens valid in nebula/plo it writes nothing; a missing one is added and
# the other is kept. --rotate replaces both.
# Each token is 32 bytes from the system CSPRNG (openssl rand), hex encoded (64 characters).
# It is never printed, never passed on a command line and never leaves a 0600 temp file that is
# removed on exit. Only key names are echoed back.
#
# Legacy copies. An earlier design kept the token in preview/plo and as LIFECYCLE_INGEST_TOKEN in
# preview/nebula. If either is found the script STOPS before writing anything: a copy there is
# readable by preview pods, and the dashboard would fall back to it whenever Secret plo-env is
# missing. --remove-legacy-copy deletes that one key from preview/nebula (every other key is
# kept, verified before writing) and tells you how to delete preview/plo.
#
# After --rotate, PLO jobs get 401 until plo-env has synced and the dashboard has restarted:
# rotate outside the job windows (UTC: daily 05:30, Mondays 06:00, the 2nd 07:00).
set -euo pipefail
umask 077

ACCOUNT=848281935985
REGION=eu-west-1
PLO_SECRET=nebula/plo
PLO_KEY=NEBULA_INGEST_TOKEN
DISPATCH_KEY=NEBULA_DISPATCH_TOKEN
LEGACY_PLO_SECRET=preview/plo
LEGACY_NEBULA_SECRET=preview/nebula
LEGACY_NEBULA_KEY=LIFECYCLE_INGEST_TOKEN
MIN_LEN=32
ROTATE=false
REMOVE_LEGACY=false
for arg in "$@"; do
  case "$arg" in
    --rotate) ROTATE=true ;;
    --remove-legacy-copy) REMOVE_LEGACY=true ;;
    *) echo "unknown argument: $arg (--rotate, --remove-legacy-copy)" >&2; exit 2 ;;
  esac
done
case "$PLO_SECRET" in preview/*) echo "refusing: $PLO_SECRET is under preview/*, which preview pods can read" >&2; exit 1 ;; esac

# ── refuse to run against the wrong account ──────────────────────────
[ -n "${AWS_PROFILE:-}" ] || { echo "refusing to run: AWS_PROFILE is not set. Use: AWS_PROFILE=twizz bash $0" >&2; exit 1; }
for bin in aws jq openssl; do command -v "$bin" >/dev/null || { echo "$bin is required" >&2; exit 1; }; done
GOT=$(aws sts get-caller-identity --query Account --output text)
[ "$GOT" = "$ACCOUNT" ] || { echo "refusing to run: AWS_PROFILE=$AWS_PROFILE is account $GOT, expected $ACCOUNT" >&2; exit 1; }

D=$(mktemp -d)
trap 'rm -rf "$D"' EXIT
exists() { aws secretsmanager describe-secret --region "$REGION" --secret-id "$1" >/dev/null 2>&1; }
get() { aws secretsmanager get-secret-value --region "$REGION" --secret-id "$1" --query SecretString --output text; }

# ── legacy copies under preview/*: stop, or remove on request ────────
LEGACY=0
if exists "$LEGACY_PLO_SECRET"; then
  echo "LEGACY: $LEGACY_PLO_SECRET exists. Preview pods can read it. Delete it (nothing uses it any more):" >&2
  echo "  aws secretsmanager delete-secret --region $REGION --secret-id $LEGACY_PLO_SECRET --recovery-window-in-days 7" >&2
  LEGACY=1
fi
if exists "$LEGACY_NEBULA_SECRET"; then
  get "$LEGACY_NEBULA_SECRET" > "$D/nebula.json"
  jq -e 'type == "object"' "$D/nebula.json" >/dev/null || { echo "$LEGACY_NEBULA_SECRET is not a JSON object; nothing written" >&2; exit 1; }
  if jq -e --arg k "$LEGACY_NEBULA_KEY" 'has($k)' "$D/nebula.json" >/dev/null; then
    if $REMOVE_LEGACY; then
      jq --arg k "$LEGACY_NEBULA_KEY" 'del(.[$k])' "$D/nebula.json" > "$D/nebula.new.json"
      # the only difference allowed is that one key
      [ "$(jq -S --arg k "$LEGACY_NEBULA_KEY" 'del(.[$k])' "$D/nebula.json" | openssl dgst -sha256)" = "$(jq -S . "$D/nebula.new.json" | openssl dgst -sha256)" ] \
        || { echo "refusing to write $LEGACY_NEBULA_SECRET: removing the key would change its other keys" >&2; exit 1; }
      aws secretsmanager put-secret-value --region "$REGION" --secret-id "$LEGACY_NEBULA_SECRET" --secret-string "file://$D/nebula.new.json" --query VersionId --output text | xargs echo "$LEGACY_NEBULA_SECRET: $LEGACY_NEBULA_KEY removed, new version:"
      echo "  that value was readable by preview pods: run this script with --rotate once the dashboard reads plo-env"
    else
      echo "LEGACY: $LEGACY_NEBULA_SECRET still has the key $LEGACY_NEBULA_KEY. Preview pods can read it, and the dashboard" >&2
      echo "  falls back to it when Secret plo-env is missing. Remove it: bash $0 --remove-legacy-copy" >&2
      LEGACY=1
    fi
  fi
fi
[ "$LEGACY" = 0 ] || { echo "nothing written: clear the legacy copies above first" >&2; exit 1; }

# ── nebula/plo: keep valid tokens unless --rotate ────────────────────
PLO_EXISTS=false
echo '{}' > "$D/plo.json"
if exists "$PLO_SECRET"; then
  PLO_EXISTS=true
  get "$PLO_SECRET" > "$D/plo.json"
  jq -e 'type == "object"' "$D/plo.json" >/dev/null || { echo "$PLO_SECRET is not a JSON object; nothing written" >&2; exit 1; }
fi
cp "$D/plo.json" "$D/plo.new.json"
CHANGED=""
for key in "$PLO_KEY" "$DISPATCH_KEY"; do
  jq -r --arg k "$key" '.[$k] // "" | tostring' "$D/plo.json" | tr -d '\r\n' > "$D/token"
  if $ROTATE || [ "$(wc -c < "$D/token")" -lt "$MIN_LEN" ]; then
    openssl rand -hex 32 | tr -d '\r\n' > "$D/token"
    [ "$(wc -c < "$D/token")" -eq 64 ] || { echo "token generation failed; nothing written" >&2; exit 1; }
    jq --rawfile t "$D/token" --arg k "$key" '.[$k] = $t' "$D/plo.new.json" > "$D/plo.next.json"
    mv "$D/plo.next.json" "$D/plo.new.json"
    CHANGED="$CHANGED $key"
  fi
done
# the dashboard treats two equal tokens as a misconfiguration (503 for everyone): never write that
jq -e --arg a "$PLO_KEY" --arg b "$DISPATCH_KEY" '.[$a] != .[$b]' "$D/plo.new.json" >/dev/null || { echo "the two tokens came out equal; nothing written, run again" >&2; exit 1; }
if [ -n "$CHANGED" ]; then
  if $PLO_EXISTS; then
    aws secretsmanager put-secret-value --region "$REGION" --secret-id "$PLO_SECRET" --secret-string "file://$D/plo.new.json" --query VersionId --output text | xargs echo "$PLO_SECRET new version:"
  else
    aws secretsmanager create-secret --region "$REGION" --name "$PLO_SECRET" --secret-string "file://$D/plo.new.json" \
      --description "PLO CronJobs in Nebula: bearer tokens for the lifecycle ingest routes (scripts/nebula-set-plo-secrets.sh)" \
      --tags Key=Project,Value=twizz-idp Key=managed-by,Value=nebula-set-plo-secrets.sh --query Name --output text | xargs echo "created:"
  fi
  if $ROTATE; then echo "$PLO_SECRET: rotated:$CHANGED"; else echo "$PLO_SECRET: generated:$CHANGED"; fi
else
  echo "$PLO_SECRET: $PLO_KEY and $DISPATCH_KEY already set, kept (use --rotate for new ones)"
fi

# ── read back: key names and a verdict, never a value ────────────────
get "$PLO_SECRET" > "$D/plo.check.json"
echo "keys now in $PLO_SECRET: $(jq -r 'keys | join(", ")' "$D/plo.check.json")"
for key in "$PLO_KEY" "$DISPATCH_KEY"; do
  if jq -e --arg k "$key" --argjson min "$MIN_LEN" '(.[$k] // "") as $a | ($a | type) == "string" and ($a | length) >= $min' "$D/plo.check.json" >/dev/null; then
    echo "ok: $key is set and at least $MIN_LEN characters"
  else
    echo "FAILED: $key is missing or short after writing" >&2
    exit 1
  fi
done
jq -e --arg a "$PLO_KEY" --arg b "$DISPATCH_KEY" '.[$a] != .[$b]' "$D/plo.check.json" >/dev/null || { echo "FAILED: the two tokens are equal" >&2; exit 1; }
echo "ok: the two tokens differ"

cat <<'NEXT'

Next (not run by this script), in this order:
  1. External Secrets must be allowed to read nebula/plo: `pulumi up` in infra/addons (once).
  2. twizz-gitops apps/nebula/plo.yaml and the dashboard.yaml change must be merged (once).
  3. kubectl --kubeconfig ~/.kube/twizz-nonprod.yaml -n nebula annotate externalsecret plo-env plo-dispatch-env force-sync=$(date +%s) --overwrite
  4. kubectl --kubeconfig ~/.kube/twizz-nonprod.yaml -n nebula wait --for=condition=Ready externalsecret/plo-env externalsecret/plo-dispatch-env --timeout=10m
  5. kubectl --kubeconfig ~/.kube/twizz-nonprod.yaml -n nebula rollout restart deploy/dashboard
     (the dashboard reads both tokens at start only; restart AFTER both have synced, not before.
      A dashboard that started with only one of them answers plo-dispatch 401.)
NEXT
