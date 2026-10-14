# TWIZZ-IDP Infrastructure (Pulumi)

Pulumi TypeScript IaC for the platform's own infra: networking, EKS-Twizz-NonProd,
ECR, IAM, DNS. (ECS/RDS/monitoring modules were deleted — dashboard runs on
Vercel + Neon; cluster addons get installed via a Phase 2 `bootstrap.ts`.)

## Usage
- `pulumi preview` / `pulumi up` from `infra/`

## Modules
- networking.ts: VPC, subnets, NAT, IGW
- eks.ts: EKS-Twizz-NonProd (Phase 2 rewrite: EKS Auto Mode + spot NodePool, real outputs)
- ecr.ts: image repos
- iam.ts: platform roles (Phase 2: preview-pods, eso, dashboard-readonly, mcp-readonly, mcp-operator)
- dns.ts: Route53 tier wildcards (`*.prv.twizz.com` et al) → ingress NLB
- capacity-access.ts: Nebula capacity control on EKS-Moly-Prod + staging (access entries, node-group IAM)
- staging.ts: the release train's staging tier (docs/NEBULA.md §N4) — Argo deployer IRSA role,
  a NAMESPACE-scoped EKS access entry on EKS-Moly-staging (ns `sentinel`), the sentinel pod's
  IRSA role on that cluster's OIDC, the Argo cluster secret (namespaced mode), `*-stg.prv.twizz.com`

## Constraints
- Never manages EKS-Moly-Prod / EKS-Moly-staging themselves. Account-level exceptions only:
  staging.ts (Argo CD → ns `sentinel` on staging) and capacity-access.ts (Nebula's role → group
  `nebula-capacity` on both, + node-group scaling IAM; the RBAC itself is infra/k8s/, applied by
  scripts/nebula-capacity-access.sh; platform-owner decision 2026-10-14, docs/NEBULA.md §N5.2). IAM role descriptions must be ASCII (IAM rejects `→`).
- Keep it lean: spot nodes, scale-from-zero, no Karpenter/external-dns
