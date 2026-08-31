# TWIZZ-IDP - Project State

Last updated: 2026-08-31

## Architecture stance (decided 2026-08-11)

GitOps-first. GitHub Actions is the only CI engine; Argo CD (ApplicationSets with the
PR generator) is the only CD engine. The dashboard is a **read-only** introspection
surface. Write actions flow through PRs and the (upcoming) MCP toolset. Argo
Workflows/Events were deleted — never wired, 3 of 5 templates were fakes.

## Phase status

| Phase | What | Status |
|-------|------|--------|
| 0 | Security hygiene (rotation checklist `docs/SECURITY-ROTATIONS.md`, kube-context split, doc fixes) | DONE (rotations pending user coordination) |
| 1 | Lean-down, build fix, minimal RBAC | DONE |
| 2 | EKS-Twizz-NonProd via Pulumi (Auto Mode), dashboard → Vercel + Neon | CLUSTER LIVE (2026-08-12); domain moved to `*.prv.twizz.com` (2026-08-21: Route53 zone delegated from Cloudflare, wildcard cert READY, https://argocd.prv.twizz.com → 200); dashboard→Vercel migration still TODO |
| 3 | Backend preview loop (PR → namespace-per-PR on NonProd) | SCAFFOLDED — gitops repo pushed to `TwizzyNicky/twizz-gitops` (2026-08-21); next: SM `preview/*` secrets, apply root-app, Moly-backend enablement PR |
| 4 | Vercel PR previews (frontend) + per-PR SAM stacks (Lambda) | TODO |
| 5 | Repo onboarding CLI + org watcher | BUILT — `packages/onboard` (detect/plan/pr/protect), `.github/workflows/org-watch.yml`; needs a GITHUB_TOKEN with org membership |
| 6 | Merge control + AI review + GitOps promotion | PARTIAL — `onboard protect` + ai-review template done; tag-bump promotion PRs TODO (needs gitops repo live) |
| 7 | MCP server + skill (tiered authz) | BUILT — `apps/mcp` (10 tools, stdio, policy+nonce+session-tagged roles+audit), `.mcp.json`, `.claude/skills/twizz-platform`; write tools unverified until cluster is up |
| 8 | Agentic sandboxes | PARKED |

## Phase 1 outcomes

- Deleted: argo/ (all workflow templates + eventsource), helm/platform, services
  argo/argocd/claude, release router + pages + 5 Release* Prisma models, deploy
  wizard, ECS/RDS/monitoring Pulumi modules. (vercel.ts and atlas.ts KEPT — used
  by introspection.)
- Build fixed: the "next-auth type bug" was actually `declaration: true` leaking
  from tsconfig.base.json into the app; dashboard now sets `declaration: false`.
  `pnpm build`, `pnpm typecheck`, `pnpm lint` are all green.
- RBAC: sign-in requires active membership of an allowed GitHub org
  (`ALLOWED_GITHUB_ORGS`, default twizz-app,MymTwo) or an explicit login
  allowlist. Split edge-safe auth config (`lib/auth.config.ts`) so middleware
  carries no Prisma. `/environments` added to the middleware matcher.
- Prisma: `User` + `AuditLog` models added; first real migration
  `packages/db/prisma/migrations/0001_init/`.

## Phase 2/3 progress (2026-08-11)

- Pulumi rewritten: `eks.ts` EKS Auto Mode (real outputs), `iam.ts` 7 roles
  (eso, preview-pods, cert-manager, dashboard-readonly via Vercel OIDC,
  gha-ecr-push via GitHub OIDC, mcp-readonly, mcp-operator), `bootstrap.ts`
  (ingress-nginx + cert-manager + wildcard cert + ESO + ClusterSecretStore +
  Argo CD + spot NodePool), `dns.ts` creates DELEGATED zone prv.twizz.com
  (twizz.app DNS is at OVH; add exported NS records there once — twizz.com/loly.app
  are on Cloudflare; the Route53 lolygram.com zone is orphaned).
- Local stack `nonprod` (local backend, empty passphrase); `pulumi preview` clean.
  **USER ACTION: run `pulumi up` (blocked for the agent by permissions), then add
  the `previewZoneNameservers` output as NS records for `preview` at OVH.**
- GitOps repo scaffolded at `/root/twizz-gitops` → push to `TwizzyNicky/twizz-gitops`.
  ApplicationSet PR generator (label `preview`), shared services (molyffmpeg,
  lolygramdiscovery, alertservice ECR repos), AppProject guardrails, github-token
  ExternalSecret (needs SM `preview/github`).
- Chart gained `serviceAccount` (IRSA), `externalServices` (ExternalName →
  shared ns), netpol `allowFromNamespaceLabels`.
- Moly-backend enablement drop-ins in `docs/enablement/moly-backend/`:
  preview.yml (OIDC build → ECR `pr-<n>-<sha>` → add label), multi-stage
  Dockerfile (node 22, single npm ci), PATCHES.md (CORS regex non-prod,
  Secrets-Manager client default-chain fix + env-wins merge + MONGO_DB_OVERRIDE
  rewrite).
- Dashboard pipelines UI now reads GitHub Actions (runs list, job DAG, job logs)
  via new `pipeline.listGithubRuns/getGithubRun/getGithubJobLogs`; Argo procs
  removed. AWS CLI v2 + Pulumi CLI installed on this machine.

## Phase 5/7 progress (2026-08-12)

- `packages/core` extracted: github/aws/vercel/atlas/introspect services now shared
  by dashboard + MCP (dashboard imports `@twizz-idp/core`; `server/services/` gone).
- `apps/mcp`: stdio MCP server "twizz-platform". Read tier (platform_status,
  list_previews, service_logs, pipeline_status, cluster_health, cost_report) runs
  as twizz-mcp-readonly (assumed at startup, env-swapped). Write tier
  (delete_preview, trigger_preview_refresh, rotate_preview_secret,
  scale_shared_service) gated: policy.yaml allowlist (global `*prod*` deny) →
  two-step confirm nonce → session-tagged twizz-mcp-operator → AuditLog (Neon or
  ~/.twizz-mcp-audit.jsonl). Smoke-tested: handshake + tools/list OK; readonly
  AssumeRole works; cost_report correctly denied until the rerun `pulumi up`
  attaches the CE policy.
- `packages/onboard`: detect/plan/pr/protect via GitHub API only (no git).
  Templates: preview.yml (OIDC→ECR→label), ai-review.yml (claude-code-action),
  twizz.yaml manifest, gitops values + ApplicationSet. Caveat: needs a
  GITHUB_TOKEN that can read the target org's private repos (active gh account
  bright-nik 404s on MymTwo/twizz-app contents).
- `org-watch.yml`: daily sweep for repos without twizz.yaml → tracking issue
  (needs ORG_WATCH_TOKEN secret once the repo is on GitHub).
- AWS quotas: VPC 5→10 and EIP →25 approved after the first `pulumi up` hit
  VpcLimitExceeded/AddressLimitExceeded. **Rerun `pulumi up`.**

## 2026-08-21 session

- Preview domain is now **`*.prv.twizz.com`** (twizz.com is on Cloudflare; NS records for `prv`
  delegate to the Route53 zone). Old `preview.twizz.app` / `preview.twizz.com` zones deleted.
- GitOps repo lives at `https://github.com/TwizzyNicky/twizz-gitops` (private) — all manifests,
  onboard templates and docs updated from `twizz-app/gitops`.
- Pulumi pinned to `AWS_PROFILE=twizz` (`aws:profile` stack config + `providerCredentialOpts` in
  eks.ts): the shell's default profile is a DIFFERENT account (187896044251); always run
  `AWS_PROFILE=twizz pulumi ...`.
- Secrets sprawl audit + 7-step consolidation plan: `docs/SECRETS-CONSOLIDATION.md` — **ON HOLD** (decided 2026-08-21): secrets management/access improves incrementally as the IDP takes over each service; no standalone migration now.
- Staging kubeconfig has a `proxy-url: socks5://127.0.0.1:1080` that isn't required (endpoint is public).
- **VPN + SSO gate (done 2026-08-21 evening)**: ingress NLB is now *internal*; `*.prv.twizz.com`
  resolves to private IPs reachable only via NetBird (self-hosted https://vpn.twizzbus.com,
  network `twizz-nonprod` → router peer `twizz-nonprod-router` = EC2 t4g.nano from `infra/src/netbird.ts`;
  policy `staff-to-twizz-nonprod`). Google Workspace SSO (twizz.com): oauth2-proxy at
  `auth.prv.twizz.com` as ingress-nginx *global* auth (opt-out annotation
  `nginx.ingress.kubernetes.io/enable-global-auth: "false"`), Argo CD via Dex Google connector
  (default role readonly; admins via Pulumi config `argocdAdmins`). Secrets: SM `preview/google-sso`
  (clientId/clientSecret/cookieSecret), `preview/netbird` (setupKey/managementUrl). NetBird admin
  runbook + owner PAT: `~/twizz_devops/docs/vpn-netbird.md`, SM `vpn/netbird/owner` (ca-central-1).

## 2026-08-31 session

- Argo CD admin is now `nick@twizz.com` (Pulumi config `argocdAdmins`, applied). Everyone else
  on twizz.com gets readonly via Dex Google login.
- SM `preview/moly-backend` created: verbatim clone of `staging/moly/backend` (previews share
  creds + mongo server with staging; per-PR isolation via `MONGO_DB_OVERRIDE` db rewrite).
  Staging pattern for reference: k8s `moly-secret` holds only static AWS keys + `AWS_SECRET_NAME`;
  the real 59-key blob lives in SM.
- Gotcha hit: `pulumi up` replaced the netbird router instance (now `i-030236bb83d3e0fc9`);
  had to re-point the NetBird network router/group at the new peer and delete the stale one
  (see note in `infra/src/netbird.ts`).
- Still blocked on the GitHub org token (SM `preview/github`, root-app apply, enablement PR,
  org-watch). NetBird setup key rotation still pending.

## Verification

```
pnpm typecheck   # 5/5 packages green
pnpm build       # next build passes (was broken since scaffold)
pnpm lint        # warnings only
```
