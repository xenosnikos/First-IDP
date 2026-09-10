# TWIZZ-IDP - Claude Instructions

## Project Overview

TWIZZ-IDP is an Internal Developer Platform for the Twizz organization. It provides
preview environments for org repos (backends → namespace-per-PR pods on
EKS-Twizz-NonProd, frontends → Vercel previews, Lambdas → per-PR SAM stacks),
GitOps promotion, AI-assisted PR review, and a read-only dashboard.

**Architecture stance (2026-08): GitOps-first.** GitHub Actions = CI. Argo CD
(ApplicationSets, PR generator) = CD. Git + PRs are the source of truth. The
dashboard only reads (introspection, pipelines, logs); writes flow through PRs
and the strictly-authorized MCP toolset. See STATE.md for phase status.

## Architecture

- **Monorepo**: pnpm workspaces + Turborepo
- **Dashboard**: Next.js 15 (App Router) + tRPC 11 + Prisma 6 + Tailwind 4 — read-only
- **Hosting**: Vercel + Neon Postgres (planned Phase 2; ECS/RDS modules deleted)
- **CI**: GitHub Actions in each service repo (immutable `pr-<n>-<sha>` image tags)
- **CD**: Argo CD on EKS-Twizz-NonProd, fed from the `TwizzyNicky/twizz-gitops` repo
- **IaC**: Pulumi (TypeScript) in `infra/`
- **Auth**: GitHub OAuth via Auth.js v5; sign-in restricted to org members (RBAC below)

## Dashboard Routes (all read-only)

| Route | Description |
|-------|-------------|
| `/projects` | GitHub org repo list |
| `/projects/[id]` | Project introspection (stack, environments, deployments) |
| `/projects/[id]/environments/[envId]` | Environment detail, pipeline history, service logs |
| `/environments` | Cross-project environment overview (diagram + table) |
| `/pipelines` | Recent pipeline runs |
| `/pipelines/[runId]` | Step timeline + log viewer (points at GitHub Actions from Phase 3) |
| `/clusters` | Pods + logs across all three clusters (observe-only for staging/prod); URL-addressable log queries; the Observer panel |

The deploy wizard and release board were removed (GitOps replaces both). The Nebula
surfaces (`/environments` grid + spin-up drawer, `/projects`, `/clusters`) are the
in-cluster dashboard at nebula.prv.twizz.com (docs/NEBULA.md).

## Service Layer

External-API wrappers live in `packages/core/src/` (`@twizz-idp/core`, shared by the
dashboard and the MCP server; no Prisma, no Next):
- `github.ts` - Octokit wrapper (listOrgRepos, listBranches, detectProjectType, getFileContent)
- `aws.ts` - AWS SDK: Secrets Manager keys, CloudWatch Container Insights (`getLivePods`,
  `getNodeMetrics`), EKS describe, `getPodLogs` → `{status: complete|timeout|failed, lines}`,
  `getLogHistogram`; all Logs Insights calls go through one `runInsightsQuery` poll helper
- `insights-query.ts` - pure Logs Insights query builders + escaping (`LOG_NAME_RE`)
- `vercel.ts`, `atlas.ts`, `introspect.ts` - Vercel / Atlas / multi-source introspection

Nebula-specific server code is in `apps/dashboard/src/server/nebula/` (`classify.ts`
origin/project classification, `kube.ts` cluster snapshot, `observer.ts` Observer audit +
budget, `deps.ts` gate wiring). Deleted (git history has them): the old
`apps/dashboard/src/server/services/*`, `argo.ts`, `argocd.ts`, `claude.ts`.

## tRPC Routers (all behind protectedProcedure)

- `project` - list, listGithubRepos, listBranches, get, detectType, create (registration only)
- `environment` - list, get (read-only; envs are created/destroyed by GitOps)
- `pipeline` - getStatus, getStepLogs, list, listAll (DB reads; GitHub Actions wiring lands in Phase 3)
- `secret` - list, listKeys (names only, never values)
- `logs` - getPodLogs (legacy per-environment log viewer)
- `clusters` - overview, logs, logHistogram (queries only, by construction)
- `nebula` - listEnvironments, listProjects (read-only Nebula views)
- `observer` - status (the Observer run itself streams over `POST /api/observer`, SSE)
- `actions` - the ONLY mutations: named-env create/teardown/extend/clone behind
  `operatorProcedure` + the `@twizz-idp/actions` gate (policy → nonce → AuditLog)

## Auth / RBAC

- `lib/auth.config.ts` — edge-safe config (providers + `authorized`); imported by middleware. NO Prisma here.
- `lib/auth.ts` — full config: `signIn` callback verifies **active GitHub org membership**
  (`ALLOWED_GITHUB_ORGS`, default `twizz-app`; unset in-cluster) with the user's own token,
  or the `ALLOWED_GITHUB_LOGINS` allowlist (what actually admits people today). Upserts
  `User`, writes an `AuditLog` row per attempt. In-cluster sign-in uses the GitHub App
  `twizz-nebula` (client `Iv23liulodACgG6rqlKr`); `NEBULA_OPERATORS` gates writes.
- Middleware matcher covers `/projects`, `/environments`, `/pipelines`.
- Every write anywhere (dashboard or MCP) must create an `AuditLog` row. Observer runs
  (an LLM call is cost-bearing) write one too: `nebula.observer.<kind>`.
- User management (Nebula sign-in allowlist, operators, VPN, SSO gates): see the
  `twizz-nebula-users` skill in `.claude/skills/`; scripts in `scripts/nebula-*.sh`.

## Prisma (packages/db)

Models: `User`, `AuditLog`, `Project`, `Environment`, `DeployConfig`, `DatabaseConfig`,
`PipelineRun`. Migrations live in `packages/db/prisma/migrations/` (started 0001_init);
use `pnpm db:migrate`, not `db push`, from now on.

## Introspection System

`introspect.ts` queries in parallel: GitHub API, EKS clusters via CloudWatch Container
Insights, AWS Secrets Manager (keys), Vercel API, MongoDB Atlas. Helpers:
`inferTierFromNamespaceAndCluster()`, `matchPodToProject()` (handles the moly/loly
naming alias). Phase 3 adds EKS-Twizz-NonProd `pr-*` namespaces + Argo CD app health.

## Conventions

- TypeScript strict mode everywhere; Zod for runtime validation via `@twizz-idp/shared`
- Routers in `apps/dashboard/src/server/routers/`, services in `.../server/services/`
- Prisma schema in `packages/db/prisma/schema.prisma`
- Helm chart: `helm/twizz-service` (generic; `values.yaml` defaults + tier overrides)
- Dashboard tsconfig sets `declaration: false` — do not re-enable (declaration emit
  from tsconfig.base.json was the cause of the historical TS2742 "next-auth type bug")
- ESLint: `apps/dashboard/.eslintrc.json` extends next/core-web-vitals + next/typescript

## Package Names

- `@twizz-idp/db` - Prisma client and schema
- `@twizz-idp/shared` - Types, constants
- `@twizz-idp/core` - External-API service layer (GitHub, AWS/CloudWatch, Vercel, Atlas)
- `@twizz-idp/actions` - The write gate + named-env actions + service registry (dashboard and MCP)
- `@twizz-idp/observer` - Observer log assistant: pure `./logs` (normalize/redact/compact),
  scope-locked tools, prompt, Claude harness (`@anthropic-ai/sdk`)
- `@twizz-idp/onboard` - Repo onboarding CLI (twizz.yaml, workflows, gitops values/appset)
- `@twizz-idp/reaper` - Named-env TTL reaper CronJob
- `@twizz-idp/config` - Shared configs
- `@twizz-idp/dashboard` - Next.js dashboard app; `@twizz-idp/mcp` - stdio MCP server

## Key External Services

- **AWS Account**: 848281935985, region eu-west-1 (profile `twizz`)
- **ECR**: 848281935985.dkr.ecr.eu-west-1.amazonaws.com
- **EKS Prod**: EKS-Moly-Prod — **DO NOT MODIFY, EVER** (private API, SOCKS tunnel via bastion)
- **EKS Staging**: EKS-Moly-staging (staging in default ns, dev in dev ns) — leave as-is
- **EKS Non-Prod**: EKS-Twizz-NonProd — owned by this platform (Pulumi, Phase 2)
- **GitHub orgs**: `twizz-app` (canonical, new repos), `MymTwo` (Moly-backend, frontend)
- **GitHub sign-in**: GitHub App `twizz-nebula` (client `Iv23liulodACgG6rqlKr`) in-cluster; legacy OAuth app `Ov23lirMDHUPPYwRkz5A` for local dev
- **Vercel Team**: Loly (`team_ocn3vwvvs3VDxcjxNcY7l8Mu`) — owns `frontend` project `prj_3Op05Dm743j4qscD37c6hpfHRnfD`
- **MongoDB Atlas**: Project 684296275fe8cc27d7b99d9b (public key iydvdumt); nonprod cluster `nonprod-twizz`
- **CloudWatch Logs**: `/aws/containerinsights/{cluster}/application` (pod logs), `/performance` (metrics)
- **Kubeconfigs**: per-cluster files `~/.kube/twizz-*.yaml` (aliases `ktw-staging`, `ktw-prod`);
  never merge Twizz contexts into the default kubeconfig

## Do NOT

- Modify EKS-Moly-Prod cluster or its workloads
- Store secrets in code, env files, ConfigMaps, or Notion (see docs/SECURITY-ROTATIONS.md)
- Add dependencies without checking if they exist in workspace first
- Run git commands unless explicitly asked
- Add write mutations to the dashboard — writes go through PRs or the MCP toolset with audit logging
