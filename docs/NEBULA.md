# Nebula — Phase 0 (internal self-service previews)

_Design doc. Status: proposed 2026-09-06. Scope confirmed with user: build the
self-service preview UI for **Twizz staff on Twizz repos**, conforming to the
Nebula brand + product architecture, as the first real slice ("dogfood") of the
Nebula product. The product vision stays the north star; this doc ships its
spine._

Source of truth for brand + architecture: the three Nebula design artifacts
(2026-08-30), since no source repo exists on this machine —
- Product + status board: https://claude.ai/code/artifact/8006fcb5-90b6-4a02-8acd-dc9e137d48c9
- Market research: https://claude.ai/code/artifact/aa15ed1d-7599-41b9-842f-8252fd59783d
- Landing: https://claude.ai/code/artifact/a92549e9-cc56-407b-a035-ddb99015d0df

---

## 1. What Nebula is (and what Phase 0 delivers)

Nebula is "the management layer for software in the agentic age": tracker ticket
→ per-ticket preview environment with an isolated DB → multi-agent review/QA →
**human-gated** release, tool-agnostically. The market research ranks its #1 moat
as _"per-ticket preview env + isolated, seeded DB, bound to a work item"_ and #2
as _"human-gated release train"_.

**That #1 moat is exactly what the team asked for**: choose repo/branch → spin up
a pod with a URL → attach a frontend → use existing or clone-staging DB (never
prod). So Phase 0 is not a feature bolted onto the read-only IDP dashboard — it
is Nebula's environment + DB + gate spine, built internally first.

**In scope (Phase 0):** repo/branch/PR picker · spin up backend pod + VPN-gated
URL · attach a frontend · attach-or-clone a **Mongo** staging DB (never prod) ·
teardown · the Nebula-branded dashboard surface · every write audited.

**Out of scope (kept STUB / north-star):** the 6 agents (Planner, Coder,
Reviewer, QA, Release, Observer) · commercial pricing/billing · external
customers · non-Mongo DB engines · non-GitHub/Jira adapters. These stay visible
as `STUB` / `PLANNED` per the brand's honesty rule, not hidden.

---

## 2. Brand contract (reconstructed from the artifacts)

Any Nebula surface MUST follow this — it is the product's identity, not decoration.

- **Type:** Gloock (display/headlines) + Azeret Mono (everything else). No
  sans-serif anywhere.
- **Palette:** dark-first "catalogue plate." Ion `#7C6CFF` / `#C9B8FF` = primary.
  **Ember `#FF8A5C` / `#AD421A` = the human gate ONLY** — never a general accent.
  Pass `#4ADE9A` · Fail `#FF5C7A` · Pending `#E7C86A`. Light theme is the paper
  print of the same plate (tokens in the artifacts).
- **Status honesty (the core rule):** _a colour never appears without its word._
  Pills: `SHIPPED` · `STUB` · `PLANNED` · `PASS` · `FAIL` · `RUNNING` ·
  `AWAITING HUMAN`. Never dress a stub as shipped.
- **Signature object:** the **preview card** — `<env>.<host>` with rows for
  checks / preview / cost / DB / gate, each a coloured word + value.
- **The human gate is Ember and is never auto-clicked.** "The one step Nebula
  never takes for you."

---

## 3. How Phase 0 maps to what already exists

| Nebula concept | Underlying primitive (today) | Status |
|---|---|---|
| Repo / branch / PR picker | GitHub API via `@twizz-idp/core` introspect | needs org token |
| Spin up pod + URL | labeled PR → Argo CD PR generator, **or** a named-env | PR path SCAFFOLDED; named-env NEW |
| Env list · status · URL · logs | dashboard introspection + CloudWatch | SHIPPED (read-only) |
| Attach frontend | Vercel preview env, or EKS static preview (Vercel→AWS plan, Phase A) | PLANNED |
| Attach / clone DB (Mongo) | `MONGO_DB_OVERRIDE` db-rewrite / mongodump-restore | PARTIAL |
| Human gate + audit | admin-gate + GitOps promotion + `AuditLog` | PARTIAL |
| Adapter contract | `packages/onboard` + introspect (GitHub only) | PARTIAL |
| 6 agents | — | STUB (north-star) |

---

## 4. Architecture

### 4.1 Provisioning model — manual release envs (decided 2026-09-06)

**Primary path: manual, existing release versions.** Nothing spins automatically
and nothing is built on demand. A staff member picks a repo + an **existing
release version** (a release tag / already-built image in ECR) in the UI and
clicks provision; Nebula writes a named-env manifest to `twizz-gitops` pointing at
that image tag, which a **named-envs ApplicationSet** (git generator over a
`named-envs/` dir Nebula manages) reconciles into `<name>.prv.twizz.com`, VPN+SSO
gated. Envs live until torn down or TTL-reaped. Least-wasteful: reuse images that
already exist, capacity used only when someone asks. **No per-PR envs, no
per-branch builds.**

**Deferred path: PR previews.** The label-triggered auto loop (a `preview` label
on a PR → Argo PR generator → `pr-<n>-…`) is designed and scaffolded
(`bootstrap/appset-moly-backend-preview.yaml`) but **not enabled in Phase 0**. It
can be switched on later, per-repo, without rework.

### 4.1a No build step; how a stock image gets isolated (resolved 2026-09-06, Fable review)

Phase 0 provisions **existing** release images (`build-*` tags in ECR); Nebula
never builds. Verified against the release line (`AwsSecretsManager.ts` +
`mongodb.provider.ts`): the app loads config from an SM secret named by
`AWS_SECRET_NAME`, the secret **overwrites** env, and Mongo connects from
`global.secret.MONGO_URI`, never env. So the only lever a stock image exposes is
`AWS_SECRET_NAME`. Isolation therefore =

- **One SM secret per env** — `preview/<service>/<name>`, a copy of
  `preview/<service>` with `MONGO_URI`/`SHIFT_FOUR_MONGO_URI` rewritten to
  `nebula_<name>`, `BUSINESS_URL` → the env's frontend host, and a **fresh
  `TOKEN_SECRET`** (else envs accept each other's JWTs — the cookie domain resolves
  to `.twizz.com` and clones share users). The env's ConfigMap sets
  `AWS_SECRET_NAME=preview/<service>/<name>` + `QUEUE_ENV`, `APP_URL`, `NODE_ENV`,
  `HTTP_PORT` (all absent from the secret, so they survive the merge).
- **Boot credentials (decided: both).** A stock image with no static keys throws
  before IRSA is consulted. (a) A scoped **`twizz-nebula-boot`** IAM user
  (GetSecretValue on `preview/moly-backend*` only), keys in SM
  `preview/moly-backend-boot`, `envFrom` — the pattern `apps/twizz-admin` already
  uses — unblocks **existing** images now; (b) the conditional-creds/IRSA patch
  lands on `DeployStaging` so **future** images need no boot user.
- **CORS at the ingress** — ingress-nginx `enable-cors` + `cors-allow-origin` (the
  env's frontend host) + credentials + the app's custom allow-headers. The
  preflight `204` runs before `auth_request`, so the SSO gate doesn't block
  OPTIONS. Keep the nginx origin list disjoint from the app's `ALLOWED_ORIGINS`.

**Proven live 2026-09-07 (`env-smoke`).** Two corrections the smoke env taught us,
both now in the chart/appset: (1) a stock image needs the **non-secret ConfigMap
layer** staging injects (~45 keys, mirrored in `apps/<service>/values.yaml`;
`TEMPLATE_DIR` is read at module load) in addition to the SM blob; (2) **Redis is
per-env in-cluster** (`redis.enabled`, noeviction) — staging's Redis is unreachable
from this VPC and must not be shared. The per-env blob therefore also sets
`REDIS_HOST=redis`, `REDIS_PASSWORD=""`. Redis is thus *removed* from the
shared-with-staging list below.

**Isolation honesty (goes on the preview card):** Phase 0 is **DB-isolated, not
side-effect-isolated.** Per-env: Mongo db, BullMQ queue names, cache prefix
(`QUEUE_ENV`), `APP_URL`, Redis. **Still shared with staging:** SQS queues,
S3 buckets, third-party keys/webhooks. Two envs on the same SQS FIFO queue steal
each other's messages — say so, don't hide it.

### 4.2 The write contract (guardrails, non-negotiable)

- **The dashboard stays read-only.** Nebula's write actions do NOT mutate the
  cluster from the web app. Every write either (a) opens a **git PR/commit** to
  `twizz-gitops`, or (b) calls the **MCP toolset** server-side, which enforces
  `policy.yaml` allowlist → global `*prod*` deny → two-step confirm nonce →
  session-tagged operator role → `AuditLog`.
- **Every action writes an `AuditLog` row** (actor, action, target, timestamp) —
  this is the Phase-0 form of Nebula's "evidence envelope."
- **Prod is untouchable, twice over:** EKS-Moly-Prod is never a target; the DB
  clone source is allowlisted to `staging/*` AND the global `*prod*` deny in
  `policy.yaml` rejects any prod-shaped id regardless of tool.

### 4.3 New MCP write tools (`apps/mcp/src/tools/write.ts` + `policy.yaml`)

- `create_preview` — `{ repo, ref, mode: "pr"|"named", name?, tier, frontend?, db }`.
  Gated. Effect: commit an env manifest to `twizz-gitops` (chart values +
  either the `preview` label wiring or a `named-envs/<name>.yaml` entry).
- `clone_staging_db` — `{ service: "moly"|"loly", targetEnv }`. **Source secret
  hard-pinned to `staging/*`; prod-shaped ids denied by `global_deny`.** Effect:
  allocate a per-env Mongo db name; for `clone` mode, `mongodump` the staging db
  → `mongorestore` into the target db; set `MONGO_DB_OVERRIDE`.
- `teardown_env` — extends `delete_preview` to named envs.

`policy.yaml` additions:
```yaml
create_preview:
  allow:
    repo: ["twizz-app/*"]                  # all Twizz repos (MymTwo merged into twizz-app)
clone_staging_db:
  allow:
    source: ["staging/*"]                  # never prod (also caught by global_deny)
# replicas 0..3 and clone target-size caps enforced in code
```

### 4.4 DB clone — Mongo only (per decision)

Three modes surfaced in the wizard:

- **Attach staging (shared)** — point at the staging Mongo, staging db directly.
  Fast, zero isolation. UI warns: writes hit staging data. Not the default for
  write-heavy work.
- **Isolated empty** — `MONGO_DB_OVERRIDE=<env>`, a fresh empty db on the shared
  staging server. Cheapest real isolation.
- **Clone staging** — `mongodump` the staging db → `mongorestore` into `<env>`.
  A real per-env copy of staging data. **Source pinned to the staging secret;
  cloning from prod is impossible by construction.**

**Clone target (decided 2026-09-06):** clone via **db-rewrite on the shared
staging Mongo server** — `mongodump` the staging db → `mongorestore` into a new
`<env>` db on the *same* server, then `MONGO_DB_OVERRIDE=<env>`. No separate
cluster. Per-env clones share the staging server's capacity, so the TTL
auto-reap (N4) and a per-env db-count cap matter for hygiene.

### 4.5 Frontend attach

- The backend env publishes `<env>.prv.twizz.com` (VPN + SSO gated).
- The frontend **must also live under `.prv.twizz.com`** — a `*.vercel.app` page
  making a credentialed call to the gated backend is cross-site, so the
  `SameSite=Lax` SSO cookie won't ride and it 401s. Two ways: proxy the Vercel
  preview from EKS the way `admin-gate.ts` does (ExternalName → `vercel.app` +
  `upstream-vhost` + bypass header) at `<env>-frontend.prv.twizz.com`, or the EKS
  static preview. Point its `REACT_APP_API_ENDPOINT` at `https://<env>.prv.twizz.com`.

### 4.6 Auth / who can do what

- **Read** (env list, status, logs): any `twizz.com` Google SSO user — already
  enforced by the ingress-nginx global oauth2-proxy gate.
- **Write** (spin up / clone / teardown): gated. Reuse the MCP tiered roles;
  start with a **Nebula-operator allowlist** (seed: `nick@twizz.com`,
  `igor@twizz.com`, matching the admin-gate) and widen later. Each write =
  confirm nonce + `AuditLog`.

### 4.7 The Nebula dashboard (UI)

- **Host in-cluster** at `nebula.prv.twizz.com` (decided 2026-09-06) — behind the
  same VPN+SSO gate, so it reads Argo `Application` CRs directly for honest
  PASS/FAIL/RUNNING pills a Vercel host can't reach. ECR repo `twizz-idp` already
  exists for the image.
- **The gate is a shared lib** (`packages/actions`): policy + nonce + operator
  role + AuditLog, extracted from the MCP server so the UI's tRPC `actions` router
  and the MCP server run the identical gate (nonces persisted in Prisma, not
  in-memory). Named-env writes need only GitHub API + Secrets Manager — no kube API.
- Rebrand `apps/dashboard` → **Nebula**: Gloock + Azeret Mono, plate ground,
  Ion/Ember, status pills.
- New **Environments** surface = a grid of **preview cards** (the signature
  object): url · release image · checks · db mode · gate state, all honest pills,
  with the DB-isolated-not-side-effect-isolated caveat visible.
- **Spin-up wizard** (drawer): service → release image (from ECR `build-*` list) →
  DB mode → TTL → **Ember confirm**.
- Teardown from the card. Reads come from introspection; writes go through
  `packages/actions`. No direct dashboard mutations.

---

## 5. Phasing

| Phase | What | Notes |
|---|---|---|
| **N0** | Foundations: token ✓ (landed 2026-09-06). Apply gitops root-app; add named-envs ApplicationSet; repo enablement into `twizz-app/Moly-backend` (`DeployStaging`): `nebula-build.yml` (`workflow_dispatch`) + CORS/IRSA/Mongo code patches | token done; **manual model — no auto-PR loop** |
| **N1** | New MCP `create_preview` (mode=named) / `clone_staging_db` / `teardown_env` + a `trigger_build` (workflow_dispatch). Verify via MCP CLI, no UI. Full gating + AuditLog | |
| **N2** | Nebula UI: rebrand + Environments preview-card grid + spin-up wizard (repo→branch→build→provision) + teardown | reads introspection, writes via MCP |
| **N3** | Frontend attach (Vercel / EKS static) + backend-link injection + the three DB modes wired | |
| **N4** | Operator RBAC group · TTL auto-reap (cost control) · AuditLog viewer (evidence envelope surfaced) | |

---

## 6. Files to create / modify

- `apps/mcp/src/tools/write.ts` — `create_preview`, `clone_staging_db`, `teardown_env`
- `apps/mcp/policy.yaml` — new tool allowlists (§4.3)
- `twizz-gitops/appsets/appset-named-envs.yaml` + `named-envs/` dir; reuse
  `bootstrap/appset-moly-backend-preview.yaml` for the PR path
- `apps/dashboard` → Nebula: brand tokens, `Environments` route + preview-card
  component, spin-up wizard, an actions router (server-side MCP client), an
  `AuditLog` write per action
- `packages/core` — a Mongo dump/restore clone helper (if not living in MCP)
- `docs/enablement/*` — DB-clone + named-env flow
- `STATE.md` — add Nebula Phase 0

---

## 7. Guardrails (restated)

- **Prod never touched.** EKS-Moly-Prod off-limits; DB clone source `staging/*`
  only, prod denied twice.
- **Dashboard read-only.** Writes via MCP (policy + nonce + audit) or git PRs.
- **Secrets never in UI, code, or logs.** Nebula shows keys, never values.
- **VPN + SSO in front of everything.**

---

## 8. Open decisions

1. ~~Clone target~~ — DECIDED 2026-09-06: db-rewrite on the shared staging Mongo
   server (see §4.4).
2. **TTL** for ad-hoc named envs before auto-reap (recommend 7 days, extendable).
3. **Operator set** at launch: `nick@` + `igor@` only, or all staff for spin-up
   with clone/teardown restricted?
4. **Loly as well as Moly** for DB clone in Phase 0, or Moly first?
5. **The N0 blocker** — the GitHub org token is still on hold; nothing spins real
   pods until it lands.

---

## N3 — frontends, service registry, multi-origin CORS, clusters (design, 2026-09-09)

_User review of the live Phase 0: "only moly-backend is offered; frontends must be
environments too; a backend has several browser clients; I want to see non-prod,
staging/QA and prod, with logs in one place; support/sentinel are invisible; what
are projects vs environments vs pipelines?" Decisions with the user: frontends
**build on provision**; backends stay **no-build**; staging/QA + prod are
**observe-only, structurally** (read-only IAM, no kube-API path from Nebula)._

### N3.1 Manifest schema v2 (`named-envs/<name>.yaml`)

```yaml
name: smoke                     # unchanged
kind: backend                   # NEW: backend | frontend   (absent ⇒ backend, for v1 files)
service: moly-backend           # registry key (N3.2)
owner: nick
imageTag: build-75b95f51-…      # backend: existing ECR build-*; frontend: fe-<repo>-<sha>, written by the build
expiresAt: "2026-09-17T09:22:54.836Z"
db: { mode: clone, generation: 1 }          # backend only (frontend: { mode: none, generation: 0 })
frontendOrigins:                # NEW (replaces frontendOrigin): every browser origin the backend must accept
  - https://smoke-fe.prv.twizz.com
  - https://smoke-business.prv.twizz.com
# frontend-only keys:
attachTo: smoke                 # the backend named env this frontend calls (its API endpoint is baked in at build)
source: { repo: twizz-app/frontend, ref: feature/x }   # what was built
build: { runId: 1234567, status: PASS|RUNNING|FAIL, sha: 1a2b3c… }   # status honesty on the card
```

Backward compat: readers accept `frontendOrigin` (string) and map it to a
one-element list; the ApplicationSet template uses `hasKey` so v1 and v2 files
coexist under `missingkey=error`. All writers emit v2. `attachTo` is validated
against existing backend manifests at provision time; tearing down a backend
that still has attached frontends is refused (`teardown_named_env` lists them).

Host convention: **one host per env, `<name>.prv.twizz.com`**, for both kinds.
A frontend attached to backend `smoke` is its own env with its own name — by
convention `<backend>-<fe>` (`smoke-fe`, `smoke-business`), which is what the
wizard proposes — and its origin is appended to the backend's `frontendOrigins`
(one commit on the backend manifest, wave-safe: Argo re-renders only the
ingress annotation). No `<backend>-fe.` magic hostnames: names stay
first-class and the reaper/appset need no special cases.

### N3.2 Service registry — `packages/actions/src/registry.ts` (TypeScript, not a gitops YAML)

Why TS: the registry is consumed at **build time** by things that must be
static — the Zod/`policy.yaml` enums, the MCP tool schemas, the wizard — and
every entry ships with a unit test; a `services.yaml` in twizz-gitops would
have to be fetched over the GitHub API on every request, could not type-check
the tool inputs, and would put a *provisioning* decision (what is deployable)
in the repo that Argo *executes* from. Chart values (`apps/<service>/values.yaml`)
stay in gitops — the registry only points at them.

```ts
type ServiceEntry = {
  name: "moly-backend" | …;      kind: "backend" | "frontend";
  repo: "twizz-app/Moly-backend"; // GitHub source (Projects page links, PR appset match)
  ecrRepo: "molybackend";         // where images live (backend: build-*; frontend: fe-<repo>-<sha>)
  sourceSecret?: "preview/moly-backend"; // backend: blob copied per env (kept out of frontends)
  valuesFile: "apps/moly-backend/values.yaml"; // in twizz-gitops
  status: "SHIPPED" | "PLANNED"; // PLANNED entries are shown, never offered
  build?: { workflow: "nebula-build.yml"; framework: "cra" | "vite" | "next"; apiEnvVar: string; socketEnvVar?: string; serve: "static" | "next-standalone" };
  detect: { labels: { "twizz-idp/service"?: string; "twizz-idp/repo"?: string } }; // how live Argo apps map back to this entry
};
```

Adding a backend = one entry **plus** three things outside the registry:
an ECR repo with `build-*` tags, a `preview/<service>` blob (and the boot user
policy widened to `preview/<service>*` in `infra/src/iam.ts`), and
`apps/<service>/values.yaml` in twizz-gitops (+ `policy.yaml` allow-list). The
registry test asserts every SHIPPED entry names all of them. Today's SHIPPED
backend: `moly-backend`. The four frontends are PLANNED entries with their
verified framework facts (below) so the wizard can list them honestly as
`PLANNED` until chunk 3 lands.

### N3.3 Frontend build-on-provision (chunk 3)

Verified via the GitHub API (2026-09-09), default branches:

| repo | framework | API endpoint var | notes |
|---|---|---|---|
| `twizz-app/frontend` | CRA 5 + craco | `REACT_APP_API_ENDPOINT` (+ `REACT_APP_SOCKET_ENDPOINT` per `docs/enablement/frontend`) | static build → nginx |
| `twizz-app/business` | Vite 6 + React 19 | `VITE_BACKEND_URL` | static build → nginx |
| `twizz-app/moly_admin` | Next **9.4.4** + custom Node server | `NEXT_PUBLIC_API_ENDPOINT` (browser) + `API_ENDPOINT` (server) | oldest; standalone output unsupported on Next 9 → `next build` + `node server` image |
| `twizz-app/twizz-admin` | Next 15 | `NEXT_PUBLIC_API_URL` (+ `NEXT_PUBLIC_APP_URL`, `NEXTAUTH_URL`) | already previewed by the joint PR appset; standalone |

None of the four has a `nebula-build.yml` yet; each has only `deploy.yml`
(Vercel). The endpoint is a **build-time** value in all four, which is exactly
why frontends must build on provision.

Flow (all through the gate, one tool `create_named_env kind=frontend`):
1. `trigger_build` — `workflow_dispatch` `nebula-build.yml` in the frontend
   repo with inputs `{ref, envName, apiEndpoint, socketEndpoint?}`; the
   workflow builds with the env var(s) set, pushes `ECR <ecrRepo>:fe-<repo>-<sha>`
   via OIDC (`repo:twizz-app/*` is already in the `twizz-gha-ecr-push` trust),
   and writes the tag to the job summary. Nebula records `build.runId` in the
   manifest immediately (card shows `RUNNING`).
2. The reaper's sibling **build-watcher** (or the dashboard on refresh) polls
   the run; on success it writes `imageTag` + `build.status: PASS` (one commit)
   → Argo deploys. On failure the card shows `FAIL` with the run link; nothing
   is deployed. No polling loop inside a request handler.
3. Chart frontend mode (`kind: frontend` in `apps/<service>/values.yaml`):
   `serve: static` = nginx image serving `/usr/share/nginx/html` with SPA
   fallback; `serve: next-standalone` = the app's own server on :3000. Both
   behind the same ingress/SSO gate; `cors` unset (the *backend* carries CORS).
4. Attach = `attachTo` in the frontend manifest + the origin appended to the
   backend's `frontendOrigins` in the same gated action (two commits, one
   nonce). A frontend with no `attachTo` targets the staging API (today's Vercel
   default) — allowed, observe-only staging is a valid *upstream to read from*,
   never a deploy target.

Contradictions with §4: §4.1a's "no build step" now holds for **backends only**;
§4.5's Vercel option (a) is dropped (SameSite cookie, N-review §1); §4.3's
`create_preview` `mode: pr` stays dropped; `trigger_build` returns, but only as
a frontend `workflow_dispatch`, never for backends.

### N3.4 Clusters + observability

Three clusters, one page (`/clusters`): **EKS-Twizz-NonProd `DEPLOYABLE`**,
**EKS-Moly-staging `OBSERVE ONLY`**, **EKS-Moly-Prod `OBSERVE ONLY`**. Pods per
namespace with status words (Container Insights `/performance`), and one logs
panel (cluster → namespace → pod? → window → filter) over
`/aws/containerinsights/<cluster>/application` — both via `@twizz-idp/core`
`awsService`, which already spans all three. Structural guarantees: the
`twizz-nebula-dashboard` role gets only `logs:*Query/Get/Describe/Filter`,
`cloudwatch:GetMetricData/ListMetrics`, `eks:DescribeCluster/ListClusters`
(no `eks:AccessKubernetesApi`, no kubeconfig for staging/prod exists in the
image); the `clusters` tRPC router has only queries; every non-prod deploy
action stays in `actions` with the gate. A cluster that cannot be read shows
`UNKNOWN`, never an empty panel.

Three pages, one line each: **Projects** = repos & what the platform knows about
them; **Environments** = what is running on non-prod; **Pipelines** = CI runs;
**Clusters** = pods + logs across all three clusters (observe-only for
staging/prod). Environments lists the Argo Applications on non-prod with an
origin word — `NAMED` (Nebula actions), `PR PREVIEW` (read-only, PR link),
`GITOPS APP` (read-only: twizz-support) — so support and sentinel are visible.
**Nebula is confined to the GitHub org** (2026-09-10): the `shared-*`
singletons (Moly siblings in namespace `shared`) are platform infrastructure
and are hidden (`isPlatformApp` in `classify.ts`); support/sentinel are
visible because they have registry entries (`PLANNED`, never provisionable)
and `xenosnikos/twizz-support` is an explicit `PROJECT_EXCEPTIONS` entry until
the repo moves into the org. Projects = repos in `twizz-app` (∪ the exception)
with `DEPLOYED` / `PREVIEWABLE` / `REGISTERED` / `UNONBOARDED`.

The Clusters logs panel (2026-09-10): the filter regex matches log text **or**
pod name; ANSI is stripped and lines carry their level word in colour;
"errors only" keeps ERROR/FATAL/WARN records and their frames; "load older"
pages by `to = oldest loaded`; a per-15-min histogram (`clusters.logHistogram`)
shows bursts; the applied query lives in the URL (`?c=&ns=&pod=&w=&q=&err=`);
a Logs Insights timeout is reported as `UNKNOWN · timed out`, never as "nothing
matched" (`getPodLogs` now returns `{status, lines}`).

### N3.6 Observer (phase 1) — the read-only log assistant

The first real incarnation of the "Observer" agent from §1. `packages/observer`
is pure and SDK-independent at its core: `./logs` (browser-safe) normalizes →
redacts → groups lines into `LogGroup` records (signature, level, ×count,
first→last, pods, redacted sample) and renders a budgeted, honest compact view;
`LogGroup` + `embedText()` is the unit a phase-2 embedding index will store.
Tools (`fetch_logs`, `log_histogram`, `list_pods`, `get_group_samples`,
`node_metrics`) are plain objects `{name, description, input: zod, run(input,
ctx)}` whose schemas carry **no cluster/namespace**: scope is fixed server-side
from the human's applied query and the model can only narrow it. The same
objects are wrapped for the Anthropic tool runner now and for `apps/mcp`
`server.tool` later (`toMcpTools`, phase 2).

Dashboard wiring: `POST /api/observer` streams server-sent events (the first
streaming surface in Nebula; tRPC's batch link cannot stream tokens), auth via
`auth()`, body validated with zod, window ≤ 24 h. `trpc.observer.status` gives
the word: `STUB` (no `ANTHROPIC_API_KEY`), `DENIED` (daily cap), `PASS`. Every
run — allowed, denied, failed, aborted — writes one `AuditLog` row
(`nebula.observer.<kind>`, resource `cluster/ns[/pod]`, detail = model, usage,
tool calls, iterations, redaction counts; never prompts or log text). That row
is also the budget ledger (`OBSERVER_DAILY_RUNS` = 40, `OBSERVER_DAILY_RUNS_PER_USER`
= 15) — no new table. Model `claude-opus-5`, adaptive thinking, effort medium,
cached frozen system prompt, server-side refusal fallback, ≤ 8 tool iterations.
Secrets: the key lives in SM `preview/nebula` (`scripts/nebula-set-observer-key.sh`);
the ExternalSecret extracts every key, so no gitops change.

Phase 2 seams (not built): `toMcpTools` + an `observer_ask` MCP tool with the
MCP actor/audit; a `propose_action` tool that returns a proposal the UI binds
to the existing gate (EmberButton → `actions` router → nonce → AuditLog; the
agent never holds the operator role); an `ObserverGroup` table with in-process
cosine first, pgvector later, and a `similar_past_incidents` tool.

### N3.5 Chunks

1. Clusters view + read-only IAM (this round). 2. Registry + `frontendOrigins`
+ multi-origin ingress CORS + Environments-shows-everything + Projects
auto-populate (this round). 3. Frontend envs: `nebula-build.yml` template in
`packages/onboard`, `trigger_build`, chart frontend mode, build-watcher,
`attachTo` (next round).


### N3.7 Build-on-provision: a preview from any org repo/branch (Phase A shipped 2026-09-10, Phase B built 2026-09-15)

The loop inside "confined to the org": pick a `twizz-app` repo at a commit,
Nebula builds it and brings the env up. Decisions: a **central builder**
(`.github/workflows/nebula-build.yml` in twizz-idp, `workflow_dispatch`,
checks out `twizz-app/<repo>@<sha>` with `NEBULA_GH_TOKEN`, OIDC →
`twizz-gha-ecr-push`, creates ECR repo `<service>` on first use, pushes
`<service>:nb-<env>-<sha12>`; `run-name` carries env/service/sha so Nebula
correlates the run); **self-service** through the human gate; the repo config
is `twizz.yaml` v2 (`@twizz-idp/shared` zod schema; secrets are NAMES, build
args public-prefix only, placeholders `${NEBULA_API_URL}` etc.).

Platform mechanics (`packages/actions`):
- **Manifest v3** (`source`, `build{status,expectedTag,runId,runUrl,reason}`,
  `config{port,healthPath,rev,envVarNames,dockerfile,context,buildArgs}`,
  `attachTo`, `db.mode none`, `kind worker`); `imageTag` optional while
  building. **Building envs live in `named-envs/pending/`** — outside the
  ApplicationSet's non-recursive glob, so `missingkey=error` never sees an
  image-less file. `listNamedEnvs → {envs, pending, broken}` isolates a bad
  file instead of breaking the page or the reaper.
- `createEnvFromRepo`: secret `preview/<service>/<name>` (generic blob:
  PORT/APP_URL/REDIS_*/TOKEN_SECRET, `MONGO_URI` from `preview/_defaults`
  when `needs.mongo`, plus the human's env vars — SM only, never git) → ONE
  Git-Data-API commit (`apps/<service>/values.yaml` once, `apps/<service>/envs/<name>.yaml`
  from twizz.yaml, `named-envs/pending/<name>.yaml`, backend `frontendOrigins`
  append on attach) → dispatch. `rebuildEnv`, `setEnvVars` (SM merge +
  `config.rev++` → chart `checksum/config` rolls pods), `createBranch`,
  `openConfigPr` (PR into the CHOSEN branch), `teardown` for both dirs.
- **Secrets without app code**: the appset points `externalSecret.remoteRef`
  at `preview/<service>/<name>` for every service except moly-backend (boot
  keys), so each blob key becomes a pod env var via `envFrom`.
- **build-watcher** (`apps/reaper/src/watch-builds.ts`, 1-min CronJob, same
  image): attach run → wait → promote (one commit: delete pending + write
  deployable with `imageTag`, PASS) or FAIL (run link, expiry shortened to
  24 h). Reaper keeps in-flight builds < 2 h even when expired.
- Policy: `create_env_from_repo` (`repo: twizz-app/*`), `open_config_pr`
  (`branch: nebula/*`), `create_branch`, `set_env_vars`, `rebuild_env`. No
  `trigger_build` tool — dispatch happens inside the actions. `global_deny
  *prod*` rejects prod-shaped repos/refs (intended).
- IAM: builder role can create ECR repos; dashboard writes only
  `preview/*/*`; reaper reads ECR. `NEBULA_GH_TOKEN` (Actions secret on
  First-IDP) = the platform token; `preview/_defaults` holds the nonprod
  Atlas host.

**Phase B (built 2026-09-15): the developer flow.**
- **GitHub reads with the human's token** (`packages/core github.ts`): `listOrgRepos`
  paginated (archived dropped, `pushedAt`), `listBranches({q, limit})`, `getBranchHead`,
  `listTree` (vendored dirs + binaries dropped, 3000-entry cap), `getFileContent` 256 KB cap.
  Router `project`: `listGithubRepos({q})` (60 s cache per login), `listBranches`,
  `getBranchHead`, `repoConfig({repo, sha})` (twizz.yaml text + Dockerfile presence at the
  pinned commit), `twizzConfigs` (kind column, 10 min cache). Everything is confined to
  `GITHUB_ORG` by `orgRepo()`.
- **Generic agent loop** `packages/observer/src/agent.ts` (`runAgentLoop`, `AgentTool`,
  `AgentEvent`, terminal tools) — the Observer is now a thin caller; existing tests unchanged.
- **Configurator** (`packages/observer/src/configurator/`): tools `detect_stack`,
  `read_existing_config`, `list_files`, `read_file` (credential-looking values masked, `.env*`
  keys only, 12 reads/run), terminal `propose_config` validated by `checkProposal` (strict
  twizz.yaml v2 + Dockerfile cross-checks: path = context+dockerfile, `FROM`, no baked
  credentials, every build arg declared with `ARG`). Frozen system prompt; one nudge turn if
  the model stops without a proposal, then an honest FAIL. Dashboard: `POST /api/configurator`
  (SSE; re-reads the branch head and refuses if it moved), ledger `nebula.configurator`
  (caps `CONFIGURATOR_DAILY_RUNS_PER_USER=3`, `CONFIGURATOR_DAILY_RUNS=20`; audit rows carry
  tool names/paths/timings, never file contents), status in `observer.configuratorStatus`.
- **Gated actions** (`routers/actions.ts`): `createEnvFromRepo` folds branch creation, the
  config PR(s) and the build into ONE human confirm. `fields` = name/repo/ref/sha/newBranch/
  kind/service/db/ttl/attach/`files`+`filesHash`/`secretNames`/`envHash`/`prTarget`; secret
  VALUES are refused on the request call and accepted only with the nonce (keys must equal
  the declared names; blank = set later), and reach the SM blob only. The action re-reads the
  pinned branch head and refuses if it moved; `files: []` builds the branch as is (no PR);
  `prTarget: chosen+default` opens a second PR into the default branch. `rebuildFromRef`
  (head sha resolved on both calls and bound by the nonce), `setEnvVars` (names + hash in
  fields), and **owner-or-operator** teardown/extend (denials audited before the gate).
  `cloneStagingDb` and the release-image path stay operator-only.
- **UI**: "Spin up from a repo" drawer (`components/environments/repo-spin-up-drawer.tsx` +
  `repo-spin-up/{pickers,config-section}.tsx`, hooks `use-configurator.ts`, pure helpers in
  `lib/nebula/repo-spin-up.ts`): repo → branch (existing/new, DENIED preview for names policy
  would refuse) → config (Configurator / by-hand templates / the repo's own twizz.yaml, edited
  as text and validated live with the shared zod schema; proposed Dockerfile use/skip) →
  env name (slug), TTL, db, attach (NAMED backend env, staging API via
  `NEBULA_STAGING_API_URL`, or a twizz.com origin) with the resolved build-arg preview,
  secrets (masked inputs, blank = later), env overrides, PR target → inline gate → result
  (URL, PR links, tag). Opened from Environments (everyone) and from a Projects row.
  Cards: `PendingCard` (RUNNING/FAIL with run link + reason), `PreviewCard` gains source/build
  rows, "Rebuild from ref", "Env vars"; broken manifests show as UNKNOWN rows. Projects: kind
  column from `twizz.yaml`, "Spin up" per org repo.
- Known limits: `global_deny *prod*` also hits SECRET NAMES containing "prod" (e.g.
  `PRODUCT_KEY`) — rename or ask an operator; the Configurator reads with the human's grant,
  so a repo the App installation cannot see shows FAIL with GitHub's message.

---

## N4 — Release train: previews → staging (built 2026-09-24)

_User ask: "we should be able to control the full release train for the service, in
both the b-e cluster and the frontend (admin)". Decided: **staging only**, prod stays
structurally out (no target, `global_deny *prod*`, no IAM path). Both halves of the
feature — `twizz-sentinel` and the `twizz-admin` frontend — deploy in-cluster on
EKS-Moly-staging by the same chart the joint preview uses; production admin stays on Vercel._

**Shape.** A promotion is a **gitops pull request**, so Git stays the record and Argo CD
stays the only deployer:

1. `promote_release` (gate 1, operators) — opens PR `promote/<service>/staging/<tag>` on
   `TwizzyNicky/twizz-gitops` bumping `apps/<service>/values-staging.yaml` `image.tag` to an
   **existing immutable** ECR tag (`main-<sha>` / `pr-<n>-<sha>` from the repo's CI,
   `nb-*` from Nebula's builder, `build-*`). Aliases (`main`/`dev`/`latest`) are refused in
   policy and in code; the image must exist in ECR; the current tag is refused; an
   identical open PR is returned instead of a duplicate. Comments in the values file survive
   (YAML document surgery, one line changes).
2. `merge_promotion` (gate 2, operators) — squash-merges that PR **pinned to its head sha**;
   the confirmed `(pr, service, target, imageTag)` must equal what the branch name says, so a
   PR edited or swapped between confirm and merge is refused. Argo syncs in ≤3 min.
   Rollback = promote the previous tag.

**Where it runs.** The non-prod Argo CD gets the staging cluster as an external destination
in **namespaced mode** (`namespaces: sentinel`, `clusterResources: false`): IRSA role
`twizz-argocd-staging-deployer` on the Argo controller/server/applicationset service
accounts, an EKS **access entry** on EKS-Moly-staging scoped to namespace `sentinel`
(`AmazonEKSAdminPolicy`, type namespace), cluster secret `cluster-eks-moly-staging`, all in
`infra/src/staging.ts`. AppProject `staging` (`bootstrap/appproject-staging.yaml`) allows
exactly that destination, no cluster-scoped kinds, no RBAC. Applications
`staging-twizz-sentinel` / `staging-twizz-admin` (`bootstrap/apps-staging.yaml`, label
`twizz-idp/tier=staging`) render `charts/twizz-service` with `values-staging.yaml`. Hosts
`sentinel-stg.prv.twizz.com` / `admin-stg.prv.twizz.com` are **VPN-only**: they stay on the
`*.prv.twizz.com` wildcard (non-prod NLB, SSO gate, wildcard cert) and
`apps/nebula/staging-edge.yaml` proxies them to the staging classic ELB with the original
Host. That ELB terminates TLS itself with a single-name ACM cert (`apistg.twizz.com`) and
has no port 80, so no certificate for these names can be served from staging, and the
staging ingresses carry no tls block (a tls block there only 308-loops). The sentinel edge
skips the SSO gate (`enable-global-auth: "false"`) because the API is key-gated and Slack
links/scripts hit it. The sentinel pod's IRSA role `twizz-staging-sentinel`
(staging OIDC) reads the staging log group, `staging/twizz-sentinel`, and Bedrock Titan; WAF
and S3 are absent because `SENTINEL_ACTIONS_ENABLED` / `ARCHIVE_ENABLED` are `"false"` on
staging until asked. Admin secrets: no External Secrets on staging, so
`scripts/staging-sentinel-bootstrap.sh` mirrors SM `staging/twizz-admin` into k8s Secret
`sentinel/twizz-admin-secrets` (chart value `existingSecret`); the sentinel reads its own blob
at boot. The staging cluster itself stays unmanaged by Pulumi; nothing outside `sentinel` is
touched, and nothing in `default`/`dev` changes.

**Code.** `packages/actions/src/promote.ts` (pure helpers + the two actions over an
`ImageRegistry` and a `PromotionRepo` port; `adapters.ts GithubPromotions`), registry
entries carry `releaseTrain.staging` (values file, Argo app, host — DERIVED from the
service, never inputs), `policy.yaml promote_release` / `merge_promotion`. Dashboard:
`actions.listReleaseTrain` (candidates from ECR, current tag from gitops, live Argo status via
label `twizz-idp/tier=staging`, open promotion PRs), `actions.promoteRelease` /
`actions.mergePromotion`, page **/releases** (`components/releases/release-train.tsx`), and
the Environments grid now shows non-prod only (`tierOf()` in `classify.ts`). MCP:
`release_train` (read), `promote_release`, `merge_promotion`. Tests: `promote.test.ts` (14),
classify tier, 81 actions / 57 dashboard green.

**GitHub grant fix (same day).** In-cluster sign-in is a GitHub App whose user tokens expire
after 8 h; the JWT stored the token once, so every session-token read returned "Bad
credentials" the next morning. `lib/github-token.ts` refreshes with the refresh token in the
jwt callback (drops the token on failure, never keeps it dead); `server/nebula/github-session.ts`
`withGithub()` runs reads on the session token and retries ONCE on the org-scoped platform
token on a 401. Writes still use the platform token only.

**Argo on the staging cluster — two gotchas.** (1) IAM refuses non-ASCII role
descriptions. (2) Argo's cluster cache lists every namespaced kind it discovers and fails
closed on the first forbidden one; the namespace-scoped `AmazonEKSAdminPolicy` does not
cover third-party CRDs (CloudWatch/Dynatrace/OTel operators) nor `PodTemplate`, so
`argocd-cm resource.inclusions` names the exact kinds tracked on that cluster (with a
catch-all entry for non-prod — an inclusion list applies to every cluster once present).
Both live in `infra/src/bootstrap.ts`. After `pulumi up` the argocd controller/server/appset
pods need a restart to pick up the IRSA annotation.

**Not done / decisions left.** Prod promotion (would need its own access entry + AppProject
and a policy change — deliberately absent). WAF IP set + `SENTINEL_ACTIONS_ENABLED=true` on
staging. Vercel promotion for the production admin. A `dev` tier on non-prod.
