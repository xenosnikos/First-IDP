#!/usr/bin/env bash
# Store the DEDICATED GitHub token of the plo-source CronJob (docs/NEBULA.md §N9; twizz-gitops
# apps/nebula/plo.yaml, container `prepare`) in SM nebula/plo-source-github {"token": ...}.
#
# That container installs, builds and tests application repositories: untrusted code runs next
# to this token and can read it. So the token must be able to do only what the job does, and
# this script REFUSES anything broader before it writes:
#   - it must be a fine-grained personal access token (github_pat_...). A classic token (ghp_...)
#     is refused: its `repo` scope covers every repository its user can see.
#   - it must NOT see TwizzyNicky/twizz-gitops or xenosnikos/First-IDP. With write access to
#     twizz-gitops (unprotected main, auto-synced by Argo CD) a leaked token deploys to the clusters.
#   - it must be able to push to the six repositories below, and administer none of them.
# What it cannot check: the token's exact permission list and that the base branches are
# protected. Create it as the header of plo.yaml says (machine user; resource owner twizz-app;
# only these six repositories; Contents, Pull requests, Issues read/write; Metadata read).
#
#   AWS_PROFILE=twizz bash scripts/nebula-set-plo-source-token.sh        # asks for the token, hidden
#   AWS_PROFILE=twizz bash scripts/nebula-set-plo-source-token.sh < file # or reads one line from stdin
#
# The token is never printed, never passed on a command line (curl reads its header from a 0600
# temp file removed on exit). GitHub is called read-only (GET). Not under preview/*: the role of
# every preview pod can read that prefix.
set -euo pipefail
umask 077

ACCOUNT=848281935985
REGION=eu-west-1
SECRET=nebula/plo-source-github
API=${PLO_GITHUB_API:-https://api.github.com}
# keep in step with PLO config/inventory.yaml `repositories:` and `escalation.githubRepo`
REPOS="twizz-app/Moly-backend twizz-app/twizz-sentinel twizz-app/lolygram-discover twizz-app/front-admin twizz-app/frontend twizz-app/platform-lifecycle-orchestrator"
MUST_NOT_SEE="TwizzyNicky/twizz-gitops xenosnikos/First-IDP"
[ $# -eq 0 ] || { echo "no arguments: the token is read from the terminal or stdin, never from the command line" >&2; exit 2; }

[ -n "${AWS_PROFILE:-}" ] || { echo "refusing to run: AWS_PROFILE is not set. Use: AWS_PROFILE=twizz bash $0" >&2; exit 1; }
for bin in aws jq curl; do command -v "$bin" >/dev/null || { echo "$bin is required" >&2; exit 1; }; done
GOT=$(aws sts get-caller-identity --query Account --output text)
[ "$GOT" = "$ACCOUNT" ] || { echo "refusing to run: AWS_PROFILE=$AWS_PROFILE is account $GOT, expected $ACCOUNT" >&2; exit 1; }

D=$(mktemp -d)
trap 'rm -rf "$D"' EXIT
if [ -t 0 ]; then
  printf 'fine-grained token of the PLO machine user (input hidden): ' >&2
  IFS= read -rs TOKEN; echo >&2
else
  IFS= read -r TOKEN || true
fi
TOKEN=${TOKEN//$'\r'/}
refuse() { echo "REFUSED: $*. Nothing written." >&2; exit 1; }
case "$TOKEN" in
  github_pat_*) ;;
  ghp_* | gho_* | ghu_* | ghs_* | ghr_*) refuse "this is a classic or app token, not a fine-grained personal access token" ;;
  *) refuse "not a fine-grained personal access token (it must start with github_pat_)" ;;
esac
[[ "$TOKEN" =~ ^github_pat_[A-Za-z0-9_]{20,}$ ]] || refuse "the token has unexpected characters or is too short"
printf 'Authorization: Bearer %s\n' "$TOKEN" > "$D/hdr"
printf '%s' "$TOKEN" > "$D/token"
unset TOKEN

# gh_get <path> -> http status; body in $D/body, response headers in $D/headers
gh_get() {
  curl -sS -m 20 -o "$D/body" -D "$D/headers" -w '%{http_code}' -H @"$D/hdr" \
    -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28' -A 'plo-token-check' "$API$1"
}

code=$(gh_get /user) || refuse "GitHub could not be reached"
[ "$code" = 200 ] || refuse "GitHub does not accept the token (GET /user answered $code)"
login=$(jq -r '.login // ""' "$D/body")
# a classic token announces its scopes in this header; a fine-grained one never sends it
if grep -qi '^x-oauth-scopes:[[:space:]]*[^[:space:]]' "$D/headers"; then refuse "the token carries OAuth scopes: it is a classic token"; fi
echo "token belongs to: $login"

for repo in $MUST_NOT_SEE; do
  code=$(gh_get "/repos/$repo") || refuse "GitHub could not be reached"
  case "$code" in
    404 | 403) echo "  cannot see $repo: ok" ;;
    200)
      # a public repository answers 200 to anyone; what matters is that the token cannot write
      if [ "$(jq -r '.private // true' "$D/body")" != false ] || [ "$(jq -r '.permissions.push // false' "$D/body")" != false ]; then
        refuse "the token has access to $repo; the plo-source token must have none"
      fi
      echo "  $repo is public and the token cannot push to it: ok" ;;
    *) refuse "unexpected answer $code for $repo; not assuming the token cannot see it" ;;
  esac
done
for repo in $REPOS; do
  code=$(gh_get "/repos/$repo") || refuse "GitHub could not be reached"
  [ "$code" = 200 ] || refuse "the token cannot see $repo (answer $code)"
  [ "$(jq -r '.permissions.push // false' "$D/body")" = true ] || refuse "the token cannot push to $repo (Contents: read and write is needed)"
  [ "$(jq -r '.permissions.admin // false' "$D/body")" = false ] || refuse "the token's user ADMINISTERS $repo; use a machine user with write access only"
  echo "  can push to $repo, is not an admin: ok"
done

jq -n --rawfile t "$D/token" '{token: $t}' > "$D/secret.json"
if aws secretsmanager describe-secret --region "$REGION" --secret-id "$SECRET" >/dev/null 2>&1; then
  aws secretsmanager put-secret-value --region "$REGION" --secret-id "$SECRET" --secret-string "file://$D/secret.json" --query VersionId --output text | xargs echo "$SECRET new version:"
else
  aws secretsmanager create-secret --region "$REGION" --name "$SECRET" --secret-string "file://$D/secret.json" \
    --description "plo-source CronJob in Nebula: dedicated fine-grained GitHub token of the PLO machine user (scripts/nebula-set-plo-source-token.sh)" \
    --tags Key=Project,Value=twizz-idp Key=managed-by,Value=nebula-set-plo-source-token.sh --query Name --output text | xargs echo "created:"
fi
cat <<'NEXT'

Next (not run by this script):
  - External Secrets must be allowed to read nebula/plo-source-github: `pulumi up` in infra/addons (once).
  - Add the ExternalSecret plo-source-github from the header of twizz-gitops apps/nebula/plo.yaml,
    in the PR that un-suspends plo-source. Until then the job cannot start.
  - Protect the base branches of the five application repositories (pull request required).
NEXT
