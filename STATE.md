# TWIZZ-IDP - Project State

Last updated: 2026-09-09

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

## Security incident 2026-08-31: poisoned remote

- `xenosnikos/First-IDP` remote had a **force-pushed poisoned initial commit** (`d7d7406`,
  back-dated 2026-04-23; actually pushed 2026-06-07 by an unknown actor with repo write access).
  Two files tampered: `apps/dashboard/postcss.config.mjs` had obfuscated Node malware appended
  (runs on every `next build`/`dev`), and `.gitignore` had the `.env*` ignore rules stripped +
  `config.bat` added (to make secrets committable).
- **Local was never poisoned** — working tree + all local git objects scanned clean. The bad
  tree lived only on the remote; a `git pull`/merge would have imported it (that was the trap).
- Cleaned by force-pushing clean local `2fb1a84` over `d7d7406`
  (`--force-with-lease` pinned to the poisoned SHA). Remote verified clean afterward.
- FOLLOW-UPS (on user): audit who has push access + deploy keys/PATs on the repo; precautionary
  rotation of creds in `apps/dashboard/.env.local` (AWS static keys highest priority).

## 2026-09-06 session — Nebula Phase 0 + org token + org rename

- **Nebula** is the brand the dashboard grows into (product vision recovered from 3
  design artifacts, 2026-08-30 — see memory `nebula-product-vision`). The team's
  self-service ask (choose repo/branch → spin up pod+URL → attach frontend →
  clone-staging Mongo, never prod) IS Nebula's #1 designed moat. Full design:
  **`docs/NEBULA.md`** (Phase 0 = internal dogfood; both write paths PR + named-env;
  Mongo clone via db-rewrite on the shared staging server; agents stay STUB).
- **GitHub org token unblocked (N0):** SM `preview/github` holds a long-lived OAuth
  token (`gho_`) for user **TwizzyNicky**, scopes `repo, workflow, read:org, gist`.
  Sufficient for the Argo PR generator + onboard + MCP tools as a plain bearer — no
  app-auth code changes needed. (It's a *user* OAuth token, not an org-owned GitHub
  App; works, but durability is tied to that account.)
- **ORG RENAME: `MymTwo` → `twizz-app`.** Old `MymTwo/*` paths 301-redirect; the
  token sees only `twizz-app`; all repos (Moly-backend, frontend, moly_admin,
  twizz-admin, service repos) now live under `twizz-app`. Reconciled in code:
  gitops appset `owner: twizz-app`; dropped dead `MymTwo` entries from `policy.yaml`,
  `iam.ts` OIDC subjects (twizz-app/* already covered both), `read.ts` default owner,
  `auth.ts` ALLOWED_ORGS default. **Still stale (doc sweep pending):** CLAUDE.md,
  docs/enablement/*, docs/SECURITY-ROTATIONS.md, .github/workflows/org-watch.yml,
  .env.local.example, twizz-gitops/README.md.
- **Remaining to light up the loop (user-run):** push twizz-gitops; apply the gitops
  root-app; (optional) `pulumi up` to drop the dead OIDC subjects; open a PR on
  `twizz-app/Moly-backend` with label `preview` to prove PR→pod. GITHUB_TOKEN env must
  be wired for the MCP server + onboard from SM `preview/github`.

## 2026-09-06 — Fable landscape review corrections

- **Platform is more live than docs said:** root-app is **Synced/Healthy** (the
  "apply root-app" TODO was stale), and the **PR→pod loop is PROVEN** —
  `twizz-admin-pr-139` runs at `pr-139-twizz-admin.prv.twizz.com` with a per-PR ESO
  secret. Chart + PR generator + ESO + wildcard cert + SSO gate all work end-to-end.
  Only Moly-backend specifically is unproven.
- **Local `/root/twizz-gitops` is STALE vs remote** (remote has twizz-admin/sentinel
  appsets not in local; my `owner: twizz-app` edit is unpushed). MUST sync before any
  gitops commit or it clobbers remote. `shared-*` apps are broken (probe merge:
  `httpGet` vs `tcpSocket` — fix `httpGet: null` in `apps/shared/*.yaml`).
- **Nebula Phase 0 model resolved** (`docs/NEBULA.md` updated): manual named-envs
  from existing `build-*` release images; isolation via **one SM secret per env**
  named by `AWS_SECRET_NAME` (URI→`nebula_<name>`, fresh `TOKEN_SECRET`); boot creds
  = scoped `twizz-nebula-boot` IAM user **and** IRSA patch on DeployStaging; DB clone
  runs **in-cluster** as an Argo PreSync `mongo:8.0` hook (Atlas allowlists the NAT,
  not the workstation); CORS at the **ingress**; frontend under `.prv.twizz.com`
  (Vercel proxy or EKS static); Nebula UI **hosted in-cluster** at
  `nebula.prv.twizz.com`; gate extracted to `packages/actions` (nonces in Prisma).
- **Honesty:** Phase 0 is DB-isolated, NOT side-effect-isolated (Redis/SQS/S3/3rd-party
  shared with staging). Named-envs appset lives in **`bootstrap/`** (root-app syncs
  `bootstrap` only). Decisions closed: TTL 7d extendable; operators nick+igor; Moly only.
- **Step 1 APPLIED (2026-09-06, `pulumi up`: +5/~3/95 unchanged):** IAM user
  `twizz-nebula-boot` (ONLY `secretsmanager:GetSecretValue` on `preview/moly-backend*`),
  its access key → SM **`preview/moly-backend-boot`** (keys `AWS_ACCES_KEY_ID` [app's typo,
  deliberate] + `AWS_SECRET_ACCESS_KEY`); preview-pods IRSA trust now includes `env-*`;
  mcp-operator gained `DeleteSecret` on `preview/*`; dead MymTwo OIDC subjects dropped.
  **Trap fixed for good:** `netbird.ts` instance now has `ignoreChanges: ["ami"]` — the
  "latest AL2023" SSM lookup was forcing a router REPLACE (= the 08-31 VPN outage) on any
  unrelated apply. Router stayed `i-030236bb83d3e0fc9`. To refresh the AMI deliberately,
  drop that option for one apply and re-point NetBird afterwards.
- **Caveat:** boot keys sit in local Pulumi state encrypted with the stack's EMPTY passphrase
  (= readable by anyone with the state file). Blast radius = read of `preview/moly-backend*`
  only. Rotate via `aws iam create-access-key`; consider a real passphrase / S3+KMS backend.

## 2026-09-07 — SMOKE ENV LIVE: Nebula Phase 0 thesis PROVEN

`env-smoke` (Application `env-smoke`, ns `env-smoke`, `smoke.prv.twizz.com`) runs the
STOCK release image `molybackend:build-75b95f51-a1de-432d-8132-33a2802f622c` (= what
`:prod` runs) with **zero code changes**: `/health` → `{"status":"ok"}`, pod 1/1 Ready.
Proven end to end: static boot keys → `AWS_SECRET_NAME=preview/moly-backend/smoke` →
in-cluster staging-db clone (PreSync hook, **3,150,050 docs → `nebula_smoke`**, 0 failed;
re-syncs no-op via the generation marker) → per-env Redis → BullMQ queues all `smoke_*`.
gitops commits: `6202480` (appset+chart+smoke) `459d9f4` `8660dc5` `a5b18e4` `a3fb84e`.

**Three findings a stock image needs (all now in the chart/appset/README):**
1. **Two config layers, not one.** Besides the SM blob, staging injects ~45 non-secret
   env keys via ConfigMap `moly-cm` (`molyb-staging-cm.yml`). `TEMPLATE_DIR` is read at
   *module load* (`mailer.service.ts:15`) → crash before bootstrap. Mirrored into
   `apps/moly-backend/values.yaml` (39 keys); `BASE_URL`/`USER_URL` per-env via appset.
   `ADMIN_PASSWORD` sits in that upstream ConfigMap in plaintext (a secret in a CM —
   flag to fix upstream); we put it in the SM blobs instead, never a ConfigMap.
2. **Redis cannot be shared with staging** — the blob's `REDIS_HOST` is a public IP
   security-grouped to staging's network (ETIMEDOUT from this VPC), and sharing it would
   cross-talk BullMQ queues anyway. Chart `redis.enabled` → per-env no-auth,
   no-persistence, **noeviction** Redis; blob sets `REDIS_HOST=redis`,
   `REDIS_PASSWORD=""` (ioredis skips AUTH on falsy). Tooling must set these per env.
3. `tracing.ts` exports to staging's `cloudwatch-agent.amazon-cloudwatch` (ENOTFOUND
   here, non-fatal) → `OTEL_SDK_DISABLED=true` in the ConfigMap.
Also fixed on the way: PreSync hook Jobs must NOT use the app ServiceAccount (it does
not exist yet at PreSync) → hooks run on the ns default SA.

**Gotchas hit:** git push to `twizz-gitops` needs auth — no credential helper on this
box and the `gh` credential lapses; Basic auth with the SM `preview/github` token as a
transient `http.extraHeader` works (user-run when the classifier blocks). The EKS API
intermittently throws `TLS handshake timeout` — just retry.

**Verify from a NetBird-connected device:** `https://smoke.prv.twizz.com/health` →
Google SSO → JSON. Teardown = delete `named-envs/smoke.yaml` (PostDelete drops
`nebula_smoke`; the `env-smoke` namespace must be deleted by hand/reaper).

## 2026-09-07 — N1 DONE: `packages/actions` + named-env tools, proven live

- **`packages/actions`** (`@twizz-idp/actions`): the write gate extracted from the MCP
  server — `loadPolicyFile/evaluatePolicy`, `NonceStore` (`MemoryNonceStore` for stdio,
  `PrismaNonceStore` + `ActionNonce` model, migration `0002_action_nonce`, not yet
  `db:migrate`d), `createAudit`, `createGate` (policy → nonce → action → audit) — and the
  named-env actions over injected ports (`GitopsRepo`/`SecretStore`/`ImageRegistry`; real
  adapters: GitHub Contents API, Secrets Manager, ECR). No kube API anywhere. Same code
  will back the in-cluster Nebula UI. 36 unit tests (vitest), `pnpm typecheck` 9/9.
- **MCP tools** (16 total now): write `create_named_env` / `teardown_named_env` /
  `clone_staging_db` / `extend_named_env`; read `list_named_envs` / `list_release_images`
  (runs on the operator role — `ViewOnlyAccess` lacks `ecr:DescribeImages`). `policy.yaml`
  entries added; secret names/ECR repos derived from `service` in code, never from input.
- **Proven against the live cluster via stdio JSON-RPC** (driver:
  scratchpad `mcp-call.mjs`, env `GITHUB_TOKEN` from SM `preview/github` + `AWS_PROFILE=twizz`
  + `TWIZZ_MCP_ACTOR`): reads returned `smoke` + the ECR release list; `extend_named_env
  smoke` (2-step nonce) → commit `638e0a6` + AuditLog row; **full lifecycle**
  `create_named_env n1test` (isolated, 2h) → derived secret exactly right (60 keys,
  `nebula_n1test`, `REDIS_HOST=redis`, fresh `TOKEN_SECRET`) → commit `b3fae22` → Argo
  Synced/Healthy in **45 s** → `teardown_named_env` → secret deleted, commit `74a0f3e`,
  Argo pruned in ~105 s. A mid-teardown DNS outage proved the gate **fails closed**
  (nothing deleted until the retry). Every action = one readable gitops commit `(actor)`.
- Leftovers by design: `env-<name>` namespaces linger after prune (deleted `env-n1test` by
  hand) → the **reaper** (N4) must delete them + expired manifests.
- **twizz-idp working tree is UNCOMMITTED** (packages/actions, mcp rewire, iam.ts,
  netbird.ts, prisma, docs/NEBULA.md, STATE.md) — needs a commit/push to the idp repo.

## 2026-09-08 — NEBULA IS LIVE IN-CLUSTER: https://nebula.prv.twizz.com

Argo Application `nebula` (project `nebula`, ns `nebula`) **Synced/Healthy**. Stack:
`gp3` StorageClass (`ebs.csi.eks.amazonaws.com` — legacy `gp2` in-tree does NOT provision
on EKS Auto Mode) → ExternalSecret `nebula-env` ← SM **`preview/nebula`** (14 keys: Postgres
creds, `DATABASE_URL`, Auth.js secrets, GitHub OAuth client `Ov23lirMDHUPPYwRkz5A`,
`NEBULA_OPERATORS`, `ALLOWED_GITHUB_LOGINS`; made by `scripts/create-nebula-secret.sh`) →
Postgres 16 StatefulSet (10Gi gp3, uid 70) → `nebula-migrate` Sync-hook Job (`prisma migrate
deploy`; both migrations applied) → **dashboard** Deployment 1/1 (`/api/health` ok, IRSA
`twizz-nebula-dashboard`, reads Argo Applications via Role in `argocd`) + Ingress
`nebula.prv.twizz.com` (global VPN+SSO gate) → **reaper** CronJob hourly (`REAPER_DRY_RUN=true`,
audits to Postgres). Images from GHA `build-images.yml` (OIDC → ECR `twizz-idp`, targets
reaper/dashboard/migrate, pinned `-10364894…`). twizz-idp pushed: `d2e4be4`, `b0709f8`,
`1036489`; gitops `af64c8a`..`8774b69`.

Gotchas: migrate's `pg_isready` needs `-U` (pod runs as uid 1000 → no passwd entry → libpq
"no attempt"); Argo `nebula` sync had to be un-stuck after the fix. Reaper decisions verified
(keep smoke / env-smoke / pr-twizz-admin-139). GHA `CI` + `org-watch` workflows FAIL on
First-IDP (pre-existing, unrelated to images) — triage.

**Open:** flip `REAPER_DRY_RUN` → `"false"` after reviewing a few hourly logs; add igor's
GitHub login to `NEBULA_OPERATORS`/`ALLOWED_GITHUB_LOGINS` in `preview/nebula`; Postgres PVC
has no backups (audit trail also lives in gitops history); Vercel/Atlas keys not in the blob
(introspection rows degrade gracefully); external check from a NetBird device pending.

## 2026-09-09 — Sign-in fixed; N3 (1/2) shipped: Clusters, Environments=all of non-prod, Projects auto, registry, multi-origin CORS

- **Sign-in:** Nebula uses the **GitHub App `twizz-nebula`** (App ID 4849677, client
  `Iv23liulodACgG6rqlKr`; secret in `preview/nebula`; App private key stored as
  `preview/github-app` for future app-auth tokens). GitHub App callbacks carry
  `iss=https://github.com/login/oauth` → `@auth/core` 0.37 needed
  `issuer: "https://github.com/login/oauth"` on the provider (`dab20f0`). Operators:
  `xenosnikos,TwizzyNicky,igormoly` (later changes: `scripts/nebula-allow-login.sh`).
- **N3 decisions:** frontends **build on provision** (workflow_dispatch → ECR, never on
  push); staging/QA + prod are **observe-only** (structural: dashboard IAM = CloudWatch/EKS
  read, no kube path). Shipped (`af25cc5`, gitops `c533f81`): `/clusters` (3 clusters, pods +
  aggregated Container Insights logs), `/environments` = every Argo app on non-prod with origin
  pill NAMED / PR PREVIEW / GITOPS APP (actions on NAMED only), `/projects` = twizz-app org ∪
  gitops-deployed repos (catches `xenosnikos/twizz-support`), TS service registry
  (`packages/actions/src/registry.ts`: moly-backend SHIPPED; frontend/business/moly_admin/
  twizz-admin PLANNED with verified frameworks + API env vars), manifest v2
  (`kind`, `frontendOrigins[]`, v1 compat), chart/appset multi-origin CORS. Design: NEBULA.md §N3.
- **Next (N3 2/2): frontend envs** — `nebula-build.yml` PRs into the 4 frontend repos, per-FE
  ECR repos, chart `serve: static|next-standalone|node-server`, `trigger_build` + watcher,
  attach-to-backend. Note moly_admin is Next 9 (no standalone) → node-server mode.
- **shared-* Degraded root cause:** `alertservice:dev` + `molyffmpeg:dev` **don't exist in ECR**
  (only latest/prod) → ImagePullBackOff; `lolygram-discovery:dev` crash-loops — needs
  `AWS_REGION`/`AWS_SECRET_NAME` + a `preview/lolygram-discovery` blob + boot keys (same stock-
  image pattern as Moly). USER DECISION: which tags/blobs for the Moly siblings.
- Gotcha: gitops remote can advance under you (Nick's twizz-support commits) → fetch+inspect+
  rebase before push. Box network flakes: EKS API "no route to host" / pulumi chart-index
  timeouts — retry.

## 2026-09-10 — Observer phase 1, Clusters/logs tweaks, org-confined Projects/Environments

- **Access:** `rohitagrohia` added to `ALLOWED_GITHUB_LOGINS` (SM `preview/nebula`, new
  `scripts/nebula-allow-login.sh`). Prod `jobs/email-service` logs verified readable from the
  dashboard path.
- **Core:** `getPodLogs` → `{status: complete|timeout|failed, lines}` (one `runInsightsQuery`
  poll helper), `getLogHistogram` (`stats count(*) by bin`), `insights-query.ts` builders with
  real escaping (`"`, `\`, `/`); filter regex matches log text **or** pod name. MCP
  `service_logs` ms→seconds bug fixed. Core now has vitest.
- **Clusters page:** split into `clusters-view` / `logs-panel` / `log-histogram` /
  `observer-panel`; URL state `?c=&ns=&pod=&w=&q=&err=`; pod picker grouped by deployment
  ("all replicas of X"); level word + colour per line (ANSI stripped, continuation lines
  inherit); errors-only; load older (cursor `to = oldest`, dedup `ts|pod|msg`); histogram;
  timeout shown as `UNKNOWN · timed out`.
- **`packages/observer` (new):** pure `./logs` (ansi, level, signature, redact, normalize,
  compact/LogGroup/embedText), scope-locked tools, frozen prompt, `runObserver` over the SDK
  tool runner (streaming), `MemoryBudget`/`budgetVerdict`; 29 tests. Dashboard: `POST
  /api/observer` (SSE), `observer.status`, AuditLog as the run ledger (`nebula.observer.<kind>`).
  Design: NEBULA.md §N3.6.
- **Org confinement:** `shared-*` (namespace `shared`) hidden via `isPlatformApp`; Projects
  filtered to `twizz-app/*` ∪ `PROJECT_EXCEPTIONS` (`xenosnikos/twizz-support`); registry gains
  `twizz-sentinel` + `twizz-support` (`PLANNED`, not provisionable).
- **Deployed 2026-09-10 (`c0857c5` → gitops `f6ed373`, Argo Synced/Healthy):** first build
  failed because the root `.gitignore` `logs/` rule had swallowed `packages/observer/src/logs`
  (negation added). `preview/nebula` now holds `ANTHROPIC_API_KEY` + `ANTHROPIC_WORKSPACE_ID`
  — the shared **Twizz R&D** Anthropic key (same one as twizz-sentinel; labelled as such in
  the Anthropic console; rotate with `scripts/nebula-set-observer-key.sh`). Ingress has no
  explicit read timeout (nginx default 60 s); the SSE stream pings every 15 s. Pushes:
  twizz-idp as `xenosnikos` (gh account switch), twizz-gitops with the TwizzyNicky platform
  token from SM `preview/github` (no local gh account can see that repo).
- `scripts/update-nebula-oauth.sh` deleted (it hardcoded the allowlist and would have dropped
  users); user management is documented in the `twizz-nebula-users` skill.
- **Known:** prod `jobs/email-service` logs its api.twizz.com bearer token on every Apple Pay
  cron failure (Observer redacts it; Nick raising with Rohit).
- **Next:** spin up a preview from any org repo/branch with config set in the dashboard
  (Nebula dispatches `nebula-build.yml` on the ref), AI-authored `twizz.yaml`/values + PR.

## 2026-09-10 (evening) — Build-on-provision Phase A (platform) built

- Plan: `/root/.claude/plans/i-want-to-tweak-bubbly-book.md` (Phase A = platform, Phase B = UI).
  Design: NEBULA.md §N3.7. Decisions: central builder, self-service gate, config PR into the
  chosen branch, `twizz.yaml` stays.
- **Code (all tests green: actions 65, shared 6, reaper 14, dashboard 32, observer 29, core 8):**
  manifest v3 + `named-envs/pending/`, `listNamedEnvs → {envs,pending,broken}`, `findEnv`,
  `resolveService`, `nebulaTag`, `GithubGitops.commit` (Git Data API, atomic), `GithubBuilds`,
  `SecretsManagerStore.putJson`; `packages/shared/twizz-yaml.ts` (v2 schema, `fromLegacy`,
  `substituteBuildArgs`); `packages/actions/{twizz-yaml,values,env-from-repo}.ts`
  (`createEnvFromRepo`, `rebuildEnv`, `setEnvVars`, `createBranch`, `openConfigPr`,
  `configPrBody`); `.github/workflows/nebula-build.yml`; `apps/reaper/src/{builds,watch-builds}.ts`
  + pending-aware expiry; policy entries + gate tests; consumers updated (nebula router now
  returns `pending`/`broken`).
- **Gitops (uncommitted until the image builds):** appset per-env `envs/<name>.yaml` +
  `ignoreMissingValueFiles`, `externalSecret.remoteRef` conditional on service,
  `redis.enabled` by kind, `env.NEBULA_CONFIG_REV`, `twizz-idp/source-ref` annotation; chart
  `checksum/config` pod annotation; `build-watcher` CronJob (`command: tsx`, `args:
  src/watch-builds.ts`).
- **Infra/setup done:** `NEBULA_GH_TOKEN` Actions secret on First-IDP; SM `preview/_defaults`
  (nonprod Atlas host); IAM edits in `infra/src/iam.ts` (EcrEnsureRepo on the GHA role,
  dashboard `preview/*/*` writes + ECR describe on `*`, reaper ECR describe) — `pulumi up`
  running/applied (check `scratchpad/pulumi-up.log` / `pulumi stack`).
- **Next:** push twizz-idp → images; bump reaper tag in gitops + push gitops (appset/chart/
  watcher); verify: dispatch `nebula-build.yml` by hand for twizz-sentinel@main, hand-drop a
  pending manifest, watch promotion; then Phase B (dashboard flow + Configurator).

## Verification

```
pnpm typecheck   # 5/5 packages green
pnpm build       # next build passes (was broken since scaffold)
pnpm lint        # warnings only
```
