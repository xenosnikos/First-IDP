#!/usr/bin/env bash
# Grant Nebula scoped capacity control on EKS-Moly-staging and EKS-Moly-Prod
# (docs/NEBULA.md §N5; decided by the platform owner 2026-10-14).
#
#   1. prod API allowlist: ADD Nebula's NAT egress IP (keeps every existing CIDR)
#   2. RBAC (infra/k8s/nebula-capacity-rbac.yaml) on staging, then prod
#   3. verify: the nebula-capacity group can scale deployments + manage HPAs in
#      default/jobs and can NOT patch pod templates or read secrets/logs
#
# The access entries + node-group IAM are Pulumi (infra/src/capacity-access.ts):
# run `pulumi up` in infra/ first or after — an entry without RBAC grants nothing.
#
# Prereqs: AWS_PROFILE=twizz with EKS admin; the prod SOCKS tunnel up
#   bash ~/twizz_devops/scripts/ssh-rotation/tunnel.sh up
#
#   AWS_PROFILE=twizz bash scripts/nebula-capacity-access.sh [--dry-run]
set -euo pipefail
umask 077

REGION=eu-west-1
PROD=EKS-Moly-Prod
DRY=false
[ "${1:-}" = "--dry-run" ] && DRY=true
HERE="$(cd "$(dirname "$0")/.." && pwd)"
RBAC="$HERE/infra/k8s/nebula-capacity-rbac.yaml"
KUBECTL=$(command -v kubectl-real || command -v kubectl)
run() { if $DRY; then echo "DRY-RUN: $*"; else "$@"; fi; }

# Nebula's egress = the NAT gateway of the twizz-idp VPC (one NAT).
VPC=$(aws ec2 describe-vpcs --region $REGION --filters Name=tag:Name,Values=twizz-idp-vpc --query 'Vpcs[0].VpcId' --output text)
NAT_IPS=$(aws ec2 describe-nat-gateways --region $REGION --filter Name=vpc-id,Values="$VPC" Name=state,Values=available --query 'NatGateways[].NatGatewayAddresses[].PublicIp' --output text)
[ "$(wc -w <<<"$NAT_IPS")" -ge 1 ] || { echo "no NAT gateway found for $VPC" >&2; exit 1; }

# ── 1. prod API allowlist ────────────────────────────────────────────
CUR=$(aws eks describe-cluster --region $REGION --name $PROD --query 'cluster.resourcesVpcConfig.publicAccessCidrs' --output text | tr '\t' '\n' | sort -u)
WANT=$( (echo "$CUR"; for ip in $NAT_IPS; do echo "$ip/32"; done) | sort -u)
echo "prod publicAccessCidrs now:  $(echo $CUR)"
if [ "$CUR" = "$WANT" ]; then
  echo "  already allows Nebula ($NAT_IPS)"
else
  echo "  adding Nebula NAT:         $NAT_IPS"
  run aws eks update-cluster-config --region $REGION --name $PROD \
    --resources-vpc-config "publicAccessCidrs=$(echo $WANT | tr ' ' ',')" --query 'update.id' --output text
  $DRY || aws eks wait cluster-active --region $REGION --name $PROD
fi

# ── 2. RBAC ──────────────────────────────────────────────────────────
STG_KC=$(mktemp); trap 'rm -f "$STG_KC"' EXIT
grep -v "proxy-url" "$HOME/.kube/twizz-staging.yaml" > "$STG_KC"   # staging API is public; drop the stale SOCKS line
for target in "staging:$STG_KC" "prod:$HOME/.kube/twizz-prod.yaml"; do
  name=${target%%:*}; kc=${target#*:}
  echo "── RBAC on $name"
  if $DRY; then "$KUBECTL" --kubeconfig "$kc" apply --dry-run=server -f "$RBAC"
  else "$KUBECTL" --kubeconfig "$kc" apply -f "$RBAC"; fi
  # ── 3. verify the grant is exactly as narrow as intended
  as=(--as nebula-capacity-check --as-group nebula-capacity)
  for check in "patch deployments --subresource=scale -n default:yes" "patch deployments --subresource=scale -n jobs:yes" "create horizontalpodautoscalers -n default:yes" \
               "list nodes:yes" "list deployments -n default:yes" "patch deployments -n default:no" "get secrets -n default:no" \
               "patch deployments --subresource=scale -n kube-system:no" "delete deployments -n default:no" "get pods --subresource=log -n default:no"; do
    q=${check%%:*}; want=${check##*:}
    got=$("$KUBECTL" --kubeconfig "$kc" auth can-i $q "${as[@]}" 2>/dev/null || true)
    printf '   %-45s %-4s %s\n' "$q" "$got" "$([ "$got" = "$want" ] && echo ok || echo "UNEXPECTED (want $want)")"
  done
done
echo "done. Nebula's IRSA role must also have its access entries (pulumi up in infra/)."
