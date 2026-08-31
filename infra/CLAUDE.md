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

## Constraints
- NEVER touches EKS-Moly-Prod or EKS-Moly-staging — separate VPC, separate IAM
- Keep it lean: spot nodes, scale-from-zero, no Karpenter/external-dns
