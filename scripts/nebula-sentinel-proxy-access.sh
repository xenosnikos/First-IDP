#!/usr/bin/env bash
# Let Nebula read prod twizz-sentinel through the EKS-Moly-Prod API server's service
# proxy (docs/NEBULA.md §N8): RBAC infra/k8s/nebula-sentinel-proxy-rbac.yaml, then
# verify the grant is exactly GET services/proxy on twizz-sentinel:http in ns sentinel.
#
# Prereqs: AWS_PROFILE=twizz with EKS admin; the prod SOCKS tunnel up
#   ssh -N -D 1080 prod-bastion
#
#   AWS_PROFILE=twizz bash scripts/nebula-sentinel-proxy-access.sh [--dry-run]
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
RBAC="$HERE/infra/k8s/nebula-sentinel-proxy-rbac.yaml"
KC="$HOME/.kube/twizz-prod.yaml"
KUBECTL=$(command -v kubectl-real || command -v kubectl)
if [ "${1:-}" = "--dry-run" ]; then "$KUBECTL" --kubeconfig "$KC" apply --dry-run=server -f "$RBAC"; exit 0; fi
"$KUBECTL" --kubeconfig "$KC" apply -f "$RBAC"
as=(--as nebula-sentinel-check --as-group nebula-capacity)
fail=0
for check in "get services/twizz-sentinel:http --subresource=proxy -n sentinel:yes" \
             "get services/twizz-admin:http --subresource=proxy -n sentinel:no" \
             "create services/twizz-sentinel:http --subresource=proxy -n sentinel:no" \
             "get secrets -n sentinel:no" "get pods -n sentinel:no" "get pods --subresource=log -n sentinel:no"; do
  q=${check%:*}; want=${check##*:}   # strip only the trailing :yes/:no (the resource has a colon)
  # kubectl auth can-i takes RESOURCE[/NAME]; the proxy subresource is separate
  got=$("$KUBECTL" --kubeconfig "$KC" auth can-i $q "${as[@]}" 2>/dev/null || true)
  printf '  %-75s %s (want %s)\n' "$q" "$got" "$want"
  [ "$got" = "$want" ] || fail=1
done
[ $fail = 0 ] && echo "ok: Nebula may only GET the twizz-sentinel service proxy" || { echo "RBAC check FAILED" >&2; exit 1; }
