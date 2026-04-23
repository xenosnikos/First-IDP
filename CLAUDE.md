# TWIZZ-IDP - Claude Instructions

## Project Overview

TWIZZ-IDP is an Internal Developer Platform for the Twizz organization. It provides a self-service UI for developers to browse repos, configure builds, provision environments, manage secrets, handle databases, and plan releases.

## Architecture

- **Monorepo**: pnpm workspaces + Turborepo
- **Dashboard**: Next.js 15 (App Router) + tRPC 11 + Prisma 6 + Tailwind 4
- **Hosting**: ECS Fargate (standalone, NOT on EKS)
- **Database**: PostgreSQL 16 on RDS (IDP metadata)
- **Pipeline**: Argo Workflows 3.6 + Argo CD 2.12 (running on EKS-Twizz-NonProd)
- **IaC**: Pulumi (TypeScript)
- **Auth**: GitHub OAuth via Auth.js v5 (next-auth 5.0.0-beta.30)

## Dashboard Layout

- Collapsible sidebar navigation with: Projects, Environments, Pipelines, Release Board
- App shell wraps all authenticated pages via `(dashboard)` route group
- Root `/` is login page; authenticated users redirect to `/projects`
- tRPC React Query provider wraps all dashboard routes for client-side data fetching

## Key Routes

| Route | Status | Description |
|-------|--------|-------------|
| `/projects` | Done | GitHub org repo list |
| `/projects/[id]` | Done | Full project introspection (stack, environments, deployments) |
| `/projects/[id]/deploy` | Done | 4-step deploy wizard (branch -> tier -> resources -> review) |
| `/projects/[id]/environments/[envId]` | Done | Environment detail with config, pipeline history, service logs |
| `/environments` | Done | Cross-project environment overview (diagram + table views) |
| `/pipelines` | Done | Recent pipeline runs across all projects |
| `/pipelines/[runId]` | Done | DAG step timeline + per-step log viewer with polling |
| `/releases` | Stub | Kanban release board (TODO) |
| `/releases/[id]` | Stub | Release detail (TODO) |

## Service Layer

Services in `apps/dashboard/src/server/services/`:
- `github.ts` - Octokit wrapper (listOrgRepos, listBranches, detectProjectType, getFileContent)
- `argo.ts` - Argo Workflows API (submitWorkflow, getWorkflow, getStepLogs, listWorkflows)
- `argocd.ts` - Argo CD API (createApplication, syncApplication, getAppStatus)
- `aws.ts` - AWS SDK (Secrets Manager, CloudWatch Container Insights, EKS describe, **getPodLogs** for application logs)
- `vercel.ts` - Vercel API (listProjects, getProjectDetail with environments, listDeployments)
- `atlas.ts` - MongoDB Atlas Admin API (listClusters, createDatabaseUser)
- `claude.ts` - Anthropic API for release doc generation
- `introspect.ts` - Multi-source project introspection (EKS pods + secrets + Vercel + Atlas) and cross-project environment overview

## tRPC Routers

Routers in `apps/dashboard/src/server/routers/`:
- `project` - list, listGithubRepos, listBranches, get, detectType, create
- `environment` - list, get, create (submits Argo workflow + returns pipelineRunId), delete (stub)
- `pipeline` - trigger, getStatus (with polling), getStepLogs, getLogs, list, listAll
- `logs` - getPodLogs (CloudWatch application logs with pod/time/search filters)
- `secret` - list, listKeys
- `release` - list, get, create, promote, rollback

## Introspection System

The `introspect.ts` service queries multiple sources in parallel to build a complete picture:
1. **GitHub API** - repo metadata, package.json, project type detection
2. **EKS clusters** (both prod + staging) - live pods via CloudWatch Container Insights
3. **AWS Secrets Manager** - all secrets, parsed for MongoDB URIs
4. **Vercel API** - project environments (production/staging/preview)
5. **MongoDB Atlas** - cluster list for DB connection matching

Key details:
- Two EKS clusters: `EKS-Moly-Prod` (production), `EKS-Moly-staging` (staging + dev namespaces)
- `inferTierFromNamespaceAndCluster()` uses cluster context for tier assignment
- `matchPodToProject()` handles moly/loly naming alias (historical rename)
- `introspectAllEnvironments()` provides cross-project environment overview

## Conventions

- TypeScript strict mode everywhere
- Zod for runtime validation (shared between client and server via packages/shared)
- tRPC routers in `apps/dashboard/src/server/routers/`
- Service layer (external API wrappers) in `apps/dashboard/src/server/services/`
- All shared types in `packages/shared/src/types/`
- Prisma schema in `packages/db/prisma/schema.prisma`
- Helm values: `values.yaml` (defaults), `values-{dev,staging,prod}.yaml` (overrides)
- Argo templates use DAG structure for parallelism
- Pulumi modules are per-resource-group: networking.ts, eks.ts, ecs.ts, rds.ts, etc.

## Package Names

- `@twizz-idp/db` - Prisma client and schema
- `@twizz-idp/shared` - Types, validators, constants
- `@twizz-idp/config` - Shared ESLint, TS, Tailwind configs
- `@twizz-idp/dashboard` - Next.js dashboard app

## Key External Services

- **AWS Account**: 848281935985, region eu-west-1
- **ECR**: 848281935985.dkr.ecr.eu-west-1.amazonaws.com
- **EKS Prod**: EKS-Moly-Prod (DO NOT MODIFY until Phase 6)
- **EKS Staging**: EKS-Moly-staging (staging in default ns, dev in dev ns)
- **EKS Non-Prod**: EKS-Twizz-NonProd (new, managed by this platform -- not yet provisioned)
- **Secrets Manager**: AWS SM in eu-west-1
- **GitHub Org**: twizz-app (OAuth client: Ov23lirMDHUPPYwRkz5A)
- **Vercel Team**: Loly (team_ocn3vwvvs3VDxcjxNcY7l8Mu)
- **MongoDB Atlas**: Project 684296275fe8cc27d7b99d9b (public key: iydvdumt)
- **CloudWatch Logs**: `/aws/containerinsights/{cluster}/application` for pod logs, `/performance` for metrics

## Known Issues

- `next-auth 5.0.0-beta.30` has a type inference issue that fails `next build` typecheck but works fine in dev mode
- The `databases-section.tsx` component was refactored (databases now shown inside environment tabs, not as standalone section)

## Do NOT

- Modify EKS-Moly-Prod cluster or its workloads
- Store secrets in code or env files
- Add dependencies without checking if they exist in workspace first
- Run git commands unless explicitly asked
