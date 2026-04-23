# TWIZZ-IDP - Project State

## Current Phase: Scaffolding COMPLETE - Ready for Phase 1 Infrastructure

## Module Status

| Module | Status | Files | Notes |
|--------|--------|-------|-------|
| Root monorepo | DONE | 5 | package.json, pnpm-workspace, turbo, tsconfig, .gitignore |
| packages/db | DONE | 4 | Prisma schema (13 models, 10 enums), client singleton |
| packages/shared | DONE | 7 | Zod schemas, types, constants (CHECK_IDS, URL_PATTERNS, etc.) |
| packages/config | DONE | 3 | ESLint preset, Tailwind preset |
| apps/dashboard | DONE | 30 | Next.js 15, tRPC (5 routers), Auth.js, 7 services, 7 pages, Dockerfile |
| infra/ | DONE | 13 | Pulumi IaC (networking, EKS, ECS, RDS, ECR, IAM, DNS, monitoring) |
| helm/ | DONE | 17 | twizz-service chart (10 templates), platform chart, 3 tier values |
| argo/ | DONE | 8 | 5 WorkflowTemplates, EventSource, ArgoCD Application |
| .github/workflows | DONE | 3 | CI, deploy-dashboard (ECR->ECS), deploy-argo (kubectl apply) |
| scripts/ | DONE | 3 | bootstrap, seed-secrets, migrate-prod (stub) |
| docs/ | DONE | 4 | architecture.md, 3 ADRs |
| CLAUDE.md files | DONE | 9 | Root + one per module |

## Total Files Created: ~100+

## Next Steps (Implementation)

1. **Initialize repo**: `cd /root/twizz-idp && git init && pnpm install`
2. **Push to GitHub**: Create `Twizz/twizz-idp` repo, push scaffold
3. **Phase 1A**: Run `cd infra && pulumi up` to provision VPC, EKS, ECS, RDS, ECR, DNS
4. **Phase 1B**: Pulumi installs cluster components (Argo, ESO, Ingress, cert-manager)
5. **Phase 1C**: Build dashboard image, push to ECR, deploy ECS service
6. **Phase 2**: Test Argo WorkflowTemplate with manual `argo submit`
7. **Phase 3**: Implement service layer TODOs (GitHub, Argo, Vercel, Atlas API integrations)

## Architecture

- **IDP Dashboard**: ECS Fargate at `idp.twizz.app`
- **Non-Prod Cluster**: `EKS-Twizz-NonProd` (Spot t3.xlarge, Karpenter, 4 env tiers)
- **Prod Cluster**: `EKS-Moly-Prod` (existing, untouched until Phase 6)
- **IDP Database**: RDS PostgreSQL 16 (db.t4g.micro)
- **Pipeline Engine**: Argo Workflows + Argo CD
- **Secrets**: ESO -> AWS Secrets Manager

## Last Updated: 2026-04-07
