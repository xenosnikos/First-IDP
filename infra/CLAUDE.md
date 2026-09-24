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
- staging.ts: the release train's staging tier (docs/NEBULA.md §N4) — Argo deployer IRSA role,
  a NAMESPACE-scoped EKS access entry on EKS-Moly-staging (ns `sentinel`), the sentinel pod's
  IRSA role on that cluster's OIDC, the Argo cluster secret (namespaced mode), `*.stg.prv.twizz.com`

## Constraints
- NEVER touches EKS-Moly-Prod. EKS-Moly-staging stays unmanaged too, with ONE exception:
  account-level resources in staging.ts that grant Argo CD namespace `sentinel` there (no
  cluster-wide grant, no cluster resources). IAM role descriptions must be ASCII (IAM rejects `→`).
- Keep it lean: spot nodes, scale-from-zero, no Karpenter/external-dns
