#!/bin/sh
# headersHelper for the Nebula MCP server: prints the Authorization header as
# JSON on stdout. Nebula authenticates you by your OWN GitHub token and applies
# the same allowlist as the browser sign-in. Nothing is stored by the plugin.
#
# Token source, first match wins:
#   1. $NEBULA_GITHUB_TOKEN
#   2. `gh auth token` for $NEBULA_GH_USER (when you have several gh accounts)
#   3. `gh auth token` (the active gh account)
# The token needs read:org (gh's default scopes include it).
set -eu
tok="${NEBULA_GITHUB_TOKEN:-}"
if [ -z "$tok" ] && command -v gh >/dev/null 2>&1; then
  if [ -n "${NEBULA_GH_USER:-}" ]; then
    tok=$(gh auth token --user "$NEBULA_GH_USER" 2>/dev/null || true)
  fi
  [ -n "$tok" ] || tok=$(gh auth token 2>/dev/null || true)
fi
if [ -z "$tok" ]; then
  echo "nebula: no GitHub token — run 'gh auth login' or set NEBULA_GITHUB_TOKEN" >&2
  exit 1
fi
case "$tok" in *[!A-Za-z0-9_.-]*) echo "nebula: unexpected characters in the GitHub token" >&2; exit 1 ;; esac
printf '{"Authorization":"Bearer %s"}\n' "$tok"
