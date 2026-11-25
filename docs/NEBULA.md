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
| `twizz-app/front-business` (was `business`) | Vite 6 + React 19 | `VITE_BACKEND_URL` | static build → nginx |
| `twizz-app/moly_admin` | Next **9.4.4** + custom Node server | `NEXT_PUBLIC_API_ENDPOINT` (browser) + `API_ENDPOINT` (server) | oldest; standalone output unsupported on Next 9 → `next build` + `node server` image |
| `twizz-app/front-admin` (was `twizz-admin`) | Next 15 | `NEXT_PUBLIC_API_URL` (+ `NEXT_PUBLIC_APP_URL`, `NEXTAUTH_URL`) | already previewed by the joint PR appset; standalone |

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

## N5 — Capacity: traffic templates for pods, nodes and Atlas (built 2026-10-14)

Admins size the platform ahead of expected traffic from `/capacity`. Pick a tier, then
pick a **preset** (Quiet / Normal / Campaign / Peak) or run the **traffic calculator**
(steady rps × peak × headroom). Nebula renders the diff against what gitops declares and
what is actually running, with a rough ≈ $/month cost delta.

| Tier (key) | Cluster | What Nebula may write |
|---|---|---|
| NonProd (`preview`) | EKS-Twizz-NonProd | Shared services `apps/shared/*.yaml`, spot NodePool ceiling + warm capacity, and the Atlas tier of `NonProd-Twizz` |
| Staging (`staging`) | EKS-Moly-staging | ns `sentinel` by gitops PR; ns default/jobs + the node group **live** (§N5.2); Atlas = NonProd-Twizz (shared, read-only here) |
| Prod (`production`) | EKS-Moly-Prod | Workloads in ns default/jobs + the managed node groups, **live** (§N5.2) |

**Source of truth.** All of these live in twizz-gitops and are edited by PR:
- `capacity/presets.yaml`: per tier, per service: replicas, requests/limits and an optional HPA. `nodes` holds the NodePool ceiling plus warm vCPU/GiB; `atlas` holds instanceSize plus auto-scaling bounds.
- `capacity/profiles.yaml`: the calculator's per-pod factors: `rpsPerPod`, requests, `dbConnsPerPod`, HPA burst. Also the node base/overhead/warm fraction and the Atlas working set. **These are starting guesses — calibrate them.**
- `clusters/nonprod/capacity/`: Argo app `capacity`, `prune: false`, no finalizer. It holds:
  - the `spot` NodePool, adopted from Pulumi (`infra/src/bootstrap.ts` now has `retainOnDelete` and `ignoreChanges: spec`)
  - the `capacity-warm` PriorityClass (-10, never preempts)
  - the `warm-capacity` pause Deployment: 1 vCPU / 2Gi units. Real pods evict it instantly, so pre-provisioned nodes are handed over without waiting for Karpenter.

**Writes.** Every write goes through the usual gate (policy → nonce → AuditLog) and is operator-only:
- `apply_capacity_preset` opens ONE PR on branch `capacity/<tier>/<label>-<hash8>`. Named presets are re-read from gitops on the server. The nonce binds `(tier, preset, sizeHash)`. The call is idempotent per size.
- `merge_capacity_pr` is gate 2: a sha-pinned squash merge, after which Argo syncs.
- `set_atlas_tier` calls the Atlas Admin API, only for `NonProd-Twizz`, with M10–M40. It PATCHes only the instance size and compute auto-scaling (electable + read-only specs; analytics too while it has 0 nodes, which keeps the auto-scaling blocks in lockstep as Atlas requires), and refuses unless the cluster is IDLE.

**Hard caps.** These are set in code (`CAPACITY_TARGETS`) and refused before the gate:
- preview: ≤ 6 replicas per service, NodePool ≤ 256 vCPU, Atlas ≤ M40
- staging: ≤ 10 replicas, Atlas ≤ M60

**Reads.**
- Staging and prod pods/nodes come from CloudWatch Container Insights. NonProd has no Container Insights, so its Deployments, HPAs, nodes and NodePools come from the kube API.
- The Atlas Admin API needs **HTTP Digest** auth for programmatic keys (Basic returns 401); `atlasFetch` does the challenge/response.
- On NonProd, the managed `spot` pool is an OVERFLOW pool: most workloads land on `private-egress` (owned by the twizz-support app, 16 vCPU) and the built-in `general-purpose` pool is uncapped. The page lists every pool; only `spot` is managed. This needs the extra get/list rules in `nebula-dashboard-read`.
- The Atlas tier is read through `AtlasTierService`. Staging and prod Atlas are read only when `NEBULA_ATLAS_CLUSTER_STAGING` / `NEBULA_ATLAS_CLUSTER_PRODUCTION` name a cluster in the configured project.

**Prod is writable through ONE tool.** `apply_live_capacity` is the only write that may name `tier: production` (`exempt_global_deny: [tier]` in policy.yaml, that tool and field only; every other tool still hits the global `*prod*` deny — tested).

**Not yet:**
- Atlas storage, IOPS and node counts.
- Staging node pools: Argo is namespace-scoped there.
- Moving `scale_shared_service` (a direct kube patch that Argo selfHeal reverts) onto capacity PRs.

### N5.2 — Live capacity on EKS-Moly-staging + EKS-Moly-Prod (2026-10-14)

Platform-owner decision: prod capacity is adjusted from Nebula. The Moly clusters have no gitops
source for sizing (their CodeBuild pipelines only `rollout restart` `:latest`; repo
`deployment.yaml`s say 2 replicas while prod runs 24), so **the live cluster is the truth**: the
Current pane reads it on every load, every plan is a diff against a fresh read, and apply re-reads
and refuses unless the plan is byte-identical to the one confirmed (`planHash` binds the nonce).

- **Access** (applied 2026-10-14): EKS access entries map `twizz-nebula-dashboard` to group
  `nebula-capacity` (infra/src/capacity-access.ts); RBAC infra/k8s/nebula-capacity-rbac.yaml — read
  nodes; in ns default + jobs read pods/deployments, write ONLY deployments/scale + HPAs (no
  `patch deployments`: that would be full pod-template control on prod). `can-i`-verified: no
  secrets/configmaps/logs/exec, no kube-system, no create/delete.
  Node groups: eks:UpdateNodegroupConfig on those two clusters only. Prod API allowlist = bastion +
  Nebula NAT `108.133.39.9/32`. Tokens: SigV4-presigned STS (core `eks-auth.ts`, node:crypto).
- **Rules** (`packages/actions/src/live-capacity.ts`): moly-backend + lolygram-discovery are a pair —
  linked in the editor by default, but an uneven split (prod runs 30/20 by choice) is allowed with a
  warning; unnamed workloads stay at their live baseline (the editor sends
  only what you changed); one apply ≤ ×3 and ≥ ×0.5 (rounded UP: 3→1 refused) per workload / node
  group; node groups shrink at most one node, one group per apply (pods carry no requests, so the
  scheduler cannot see load); caps (prod 120 replicas, 20 nodes/group; staging 20 / 6); never
  deletes (no HPA removal, no zero); HPAs only with metrics.k8s.io AND CPU requests on the pods
  (prod's pair has none today → replicas only), with a warning when HPA min < running; replicas
  only — resources are not sizable live; node groups grow first, shrink last; stop at first
  failure. The audit row stores the JSON result + the confirmed summary.
- **Accepted risk**: the prod API allowlist includes the NonProd NAT (108.133.39.9), shared by all
  NonProd egress incl. PR-preview pods; the endpoint still requires an authorised IAM identity.
- **UI**: /capacity → Staging / Prod show the live workloads + node groups, a live sizing editor
  (starts from what runs; sends only what you change; ⇆ link-pair toggle), the plan in apply
  order, and **Apply to <cluster>** (operators, two-step confirm, AuditLog `nebula.apply_live_capacity`).
- **Prod templates** (owner decision 2026-11-05, replacing "no presets for the live tiers" of
  2026-10-14): capacity/presets.yaml carries three prod templates with a `production.live` section —
  **Baseline** (prod as it ran on 2026-11-05: pair 40/20, node group 5/5/8), **Campaign** (2×:
  80/40, 8/10/14) and **Max** (3×, the most one apply allows: 120/60, 12/15/20). One click plans a
  template against what runs; one confirm applies it. A NAMED template is planned with
  `LivePlanOpts.template` (floor = the tier's `baseline` template, read from gitops): for whatever
  the floor names, the ≥ ×0.5 step-down and the one-node-per-apply drain guard are lifted, so Max →
  Baseline is one apply; nothing may go below the floor. ×3 step-up, caps, never-zero and
  one-group-per-apply still hold, the plan hash binds the template name, and a template's uneven
  pair split does not warn. Hand edits in the editor keep every original rule. Staging has no live
  templates (editor only).
- **Atlas**: staging uses NonProd-Twizz (shared). Prod is Moly-Prod + Prod-Shift4 in another Atlas
  account (project "Loly" `64a3f2d23e82167aa3f7f66e`, key "Nebula" = Project Cluster Manager,
  `ATLAS_PROD_*` in SM preview/nebula since 2026-10-16) — resized per §N5.3.

### N5.3 — Prod Atlas tier (2026-10-16)

Platform-owner decision: ops resize the prod MongoDB clusters from Nebula ahead of anticipated
traffic, without a devops hand-off. /capacity → Prod → "atlas · prod account": per cluster, pick a
tier (and the auto-scaling bounds where auto-scaling is on) → **Plan** (fresh read) → **Resize**
(operators, two-step confirm, AuditLog `nebula.set_prod_atlas_tier`).

- **Rules** (`packages/actions/src/prod-atlas.ts`): clusters allowlisted (Moly-Prod, Prod-Shift4 —
  in code AND policy.yaml `set_prod_atlas_tier`, whose `tier`/`cluster` are the only fields exempt
  from global_deny); one cluster per change; at most +2 tiers up / −1 down (range M10–M200); IDLE
  only; compute auto-scaling stays on/off as configured (bounds editable; the tier must sit inside
  them; ceiling cut ≤ 1 tier); an existing `scaleDownEnabled` choice is kept (core `tierPatch`);
  the nonce binds `from` (the tier reviewed) and the action re-reads and refuses if it moved.
- **Warnings shown in the plan**: rolling node-by-node change with one primary election (seconds
  of write retries — do it ahead of traffic, not at peak); downsizing = less RAM; on an
  auto-scaled cluster, raise the floor (min) too or Atlas may scale back down after low load.
- Cost is Atlas list price per cluster (capacity-prices.ts), shown as a delta, not a bill.

### N5.4 — Capacity by traffic: estimate from req/s, learn from past events (2026-11-06)

**Why.** 2026-11-05 00:17 EET: prod edge traffic went 132 → 2,327 req/s in ~2 minutes (17×).
40 moly-backend pods (no CPU requests/limits) each hit one Node core (~820–1,000m) and the
node group (5 × m5.2xlarge) ran at 91–99% CPU; p95 went 280 ms → 9.5 s for ~3 minutes, with
almost no errors. A 2-minute ramp outruns any HPA plus node scale-up, so capacity has to be
in place **before** the event, sized from expected traffic.

**Profile** (`twizz-gitops capacity/profiles.yaml` `<tier>.live`, calibrated on that event):
per-pod CPU = `baseMcpu + mcpuPerRps × req/s per pod` (30m + 15.5m; fits 5 measured points),
sized at `targetMcpu` 600m (≈37 req/s per pod); node groups: `allocatableCpu`, `reservedCpu`
(other load), `headroom`, `burst` (max = desired × burst).

**Pure core** (`packages/actions/src/traffic.ts`):
- `estimateLive(target, profile, {rps, peakFactor, headroom}, floor)` → a `LiveTierSize` with
  the arithmetic per step. It is floored by the tier's `baseline` template and capped by
  `LIVE_TARGETS`, saying so, never silently. Node group min = desired, so nothing scales away
  mid-event.
- `assessLive(profile, size, rps)` → OK / WATCH / SATURATED per pod and node group. It
  replays a case: on 2026-11-05 `baseline` comes out SATURATED (932m/pod, 109% nodes),
  `campaign` OK (481m, 56%). Tests pin that the profile predicts the observed saturation.
- `findBursts(series)` → sudden ramps (≥ 3× and +300 req/s over a 15-minute median).

**Reads** (`capacity` router, every signed-in user; MCP for every bound person):
- `estimateLive` (MCP `capacity_estimate`): the estimate, the plan against a fresh read with
  its `planHash`, and what runs now, the estimate and each named template assessed at that load.
- `trafficPeaks` (`traffic_peaks`): ≤ 14 days, ALB per-minute points.
- `trafficWindow` (`traffic_window`): ≤ 3 h minute by minute; pods/nodes from Container
  Insights, which keeps them about 1 day. A window crossing that cutoff gets pod/node data
  for its retained part and says so.
- `cases` (`capacity_cases`): `capacity/cases.yaml`, each case replayed against today's profile.

**Apply.**
- `actions.applyLiveCapacity` takes exactly one of `preset` / `custom` / `estimate`.
- An estimate is resolved server-side; the client sends only req/s, peak factor and headroom.
  Its numbers are bound into the nonce fields.
- It is floored by `baseline`, which is **required**: an estimate fails closed if the tier has no
  baseline live section.
- Unlike a reviewed named template, it **keeps the step-down guards**: ×0.5 per apply and one
  node per apply. A low estimate can't drain prod in one click (Codex review 2026-11-06).
- Step-up limits and caps apply as usual.
- A profile may only name allowlisted workloads and node groups (`LIVE_PROFILE_ALLOWLIST` in
  `routers/capacity.ts`). Editing `capacity/profiles.yaml` changes prod sizing coefficients, so
  it needs the same review as the presets.
- MCP `apply_live_capacity` takes `preset` or `estimateRps` (never a custom size), still
  operator + `capacity:<tier>`.

**Prompt.** MCP `plan_capacity_for_traffic {tier, expectedPeakRps, when, event}`:
1. cases first, then peaks;
2. estimate, compared with the templates;
3. recommend one, apply ahead of the event (with the user's yes);
4. plan the step back to baseline;
5. record the new case.

### N5.5 — Events and incidents: set, validate, watch, diagnose, rectify (2026-11-06)

**Before an event** (MCP prompt `prepare_marketing_event`):
1. Read `capacity_cases` and `traffic_peaks`.
2. Get `capacity_estimate`, then apply ahead with `apply_live_capacity` (named template or estimate).
3. Run **`capacity_verify`** until READY. It reports MISMATCH when the spec isn't what was planned,
   PROGRESSING while pods or nodes are coming, and READY otherwise (`verifyLive` in actions/traffic.ts).

**During**, **`event_watch`** returns the last N minutes plus the monitor's signals, labelled with
their 15-minute window. The verdict is the pure `watchVerdict` (`server/nebula/watch-model.ts`):
- **ACT:** what runs is SATURATED at the current peak, pods ≥ 900m, a node ≥ 90%, p95 > 1 s,
  5xx ≥ 2%, or a monitor signal HOT.
- **WATCH:** no 30% margin, p95 > 500 ms, 5xx ≥ 0.5%, nodes ≥ 70% average, a monitor WATCH, or
  any data gap (named).
- **UNKNOWN:** no edge data or no capacity model.
- **OK:** otherwise.

It recommends scaling **only on capacity evidence**: the smallest named template that holds
peak × 1.3 and is **at least as large as what runs**, never a downsize mid-incident. Without
capacity evidence it says "diagnose before scaling".

`capacity_verify` counts only Ready, schedulable nodes. A deployment is done only when its
controller observed the spec and every replica is updated and available.

**After**, step back down, then record the event in `capacity/cases.yaml`.

**Incidents** (MCP prompt `diagnose_outage`):
1. `event_watch` (60 min).
2. **`recent_changes`** (operators: it shows who did what): Nebula's audited writes (truncation
   reported) plus ECR pushes of the prod services (per-repo errors reported, listings cached
   5 min). Prod Moly deploys run outside Nebula, so an image push is the deploy signal.
3. Saturation or failure? Use pods/nodes CPU vs 5xx/restarts, the monitor (Atlas), `cluster_overview`.
4. Errors: `log_histogram` → `fetch_logs` → `get_group_samples`; sentinel.
5. Conclusion with evidence for and against.

**Rectify.** Nebula's levers, each a plan → explicit yes → confirm → verify:
- capacity (`apply_live_capacity`);
- prod Atlas tier;
- staging rollback (`promote_release` of the previous good tag);
- NonProd env actions.

Prod restarts and image rollbacks are **not** Nebula actions (platform-owner rule: EKS-Moly-Prod is
changed only through `apply_live_capacity`). The prompt tells the user the exact command for on-call.

**Provenance of the capacity files.** twizz-gitops is a private personal repo, so GitHub offers no
branch protection or rulesets, and `main` also takes Nebula's own commits. Nebula enforces review
itself, against one pinned commit (`pinReviewedCapacity`). For a PRODUCTION `applyLiveCapacity`
from gitops:
1. resolve `main` to `H`;
2. for `capacity/presets.yaml` (plus `profiles.yaml` for estimates), take the last commit `C` as of `H`;
3. find a PR associated with `C`, merged into **this** repo's `main` by a capacity owner
   (`NEBULA_CAPACITY_OWNERS`, default `twizzynicky`), whose merge commit `M` passes a
   **blob-level proof**:
   - `M` is on `H`'s history;
   - the file's blob at `M` equals its blob at `H` (nothing changed it since);
   - the blob at `M`'s first parent differs (this merge introduced it).

   Commit-list membership is not accepted, so a stacked PR can't launder a direct push;
   A later push that restores bytes identical to an approved version passes, by design: the
   bytes are reviewed content. Rebase merges of several commits may be refused (fail safe;
   this repo squash-merges);
4. read the files **at `H`** and size from exactly those bytes. Their blob SHAs are bound into the
   nonce, so a change between review and confirm is refused.

Proofs are cached per (H, path); doubts are not cached. It fails closed, the denial is audited, and
`.github/CODEOWNERS` documents the owners. Custom sizes (operator, UI) don't come from these files
and skip this check by design.

## N6 — Monitor: prod + staging at a glance (2026-10-16)

`/monitor` — one page so ops can see pressure and headroom without devops watching CloudWatch,
Atlas and kubectl. Read-only for every signed-in user; "Scale on /capacity →" for the fix.
Refreshes every 60 s (paused in background tabs); windows 15m / 1h / 6h / 24h.

- **Pressure board** (`server/nebula/monitor-model.ts` `deriveSignals`, unit-tested): requests,
  5xx rate (≥1 % WATCH, ≥5 % HOT), p95 latency (≥1 s / ≥3 s), node CPU (≥70 / ≥85 %, or a node
  ≥90 %), node memory (≥75 / ≥90 %), node headroom (WATCH when a group's desired = max), workloads
  (not fully ready / restarts), per Atlas cluster CPU (≥60 / ≥80 %) + connections vs tier max
  (≥70 / ≥90 %) + query targeting ≥1000 (an index hint, WATCH only). Data older than 6 min is
  UNKNOWN, never OK. Words: OK / WATCH / HOT (status.ts).
- **Sources** (`server/nebula/monitor.ts`), all with access Nebula already had:
  traffic = prod ALB `app/k8s-internalingressgr-*` (found via ListMetrics; per target group =
  per service), staging = classic ELB `ada851bd…` (TCP pass-through: requests + 5xx, no latency);
  CPU/memory = Container Insights (node + per-deployment `PodName`: total cores, hottest pod,
  working set, pods, restarts); pods ready/desired + node groups = the live kube read (§N5.2);
  database = Atlas measurements on each cluster's primary (prod key / NonProd key for staging).
- **Freshness / cost**: CloudWatch 1-min data lags ~1–2 min. One snapshot per (tier, window) is
  cached 30 s and shared by all viewers; a prod snapshot is ~50 GetMetricData metrics (≈ $0.0005).

## N7 — Nebula over MCP: the `twizz-nebula` plugin (2026-11-05)

Teammates drive Nebula from Claude Code. The MCP server is **Nebula itself**,
not a laptop process: `POST https://nebula.prv.twizz.com/api/mcp` (Streamable
HTTP, stateless, JSON responses). The client is the `twizz-nebula` plugin in its own
repo, **TwizzyNicky/nebula-mcp** (to move to twizz-app): plugin, marketplace,
`/nebula:setup`, onboarding and the security model (docs/AUTH.md there).

### N7.1 Auth: three credentials, all the user's own (2026-11-05)

Every request carries three proofs minted by the plugin's `headersHelper` from
credentials the person set up themselves; `server/mcp/auth.ts` + `identity.ts`
verify ALL of them and require them to match the person's binding:

| Header | Proof | Verified as |
|---|---|---|
| `Authorization: Bearer` | GitHub token (`gh auth token`) | `GET /user` → login; the browser sign-in rule (`lib/github-access.ts`) |
| `x-nebula-google-token` | Google ID token (`gcloud auth print-identity-token`) | tokeninfo: issuer, gcloud audience, exp, `email_verified`, `@twizz.com` |
| `x-nebula-aws-sts` | presigned `sts:GetCallerIdentity`, SigV4, ≤ 15 min, **signs `x-nebula-audience`** | shape-checked, then executed against STS with the audience header → ARN under `arn:aws:iam::848281935985:user/nebula-mcp/` |

`NEBULA_MCP_IDENTITIES` (SM `preview/nebula`, `scripts/nebula-mcp-bind.sh`) =
`{"<login>": {"google", "aws"}}` IS the MCP list: no binding, no MCP, operators included.
The AWS users (`scripts/nebula-mcp-iam.sh`: path `/nebula-mcp/`, group `nebula-mcp-users`)
hold no permissions. GetCallerIdentity needs none, and the group allows only self-service
(password, MFA, own access keys with MFA) and explicitly denies everything else
(policy-simulated, including an accidentally attached admin policy). Caches: GitHub 5 min;
verified Google/AWS proofs until the Google token expires (≤ 1 h); SHA-256 keys, nothing stored.

**Traceability.** The session carries `google` + `aws` alongside the login. `mcp.signin`
rows record all three (or the refusal reason). Every tool call, reads included, writes
`mcp.tool.<name>` with the three identities, sanitized args (names and hashes only), ms
and outcome. Writes also get the gate's `nebula.<tool>` rows.

The token is the session's `accessToken`, so GitHub reads run as that person like the UI
(`withGithub()`); writes still use the platform token. Network: VPN-only (prv zone), with its
own Ingress (`dashboard-mcp`, path `/api/mcp` Exact, gitops `apps/nebula/dashboard.yaml`) that
skips the browser SSO gate. The Google ID token check above is the SSO proof for MCP.

**One code path.** Each tool (`server/mcp/tools.ts`) is a tRPC procedure called
through `appRouter.createCaller({ session, prisma })`: protected / operator /
owner-or-operator checks, the `@twizz-idp/actions` gate (policy → nonce →
AuditLog) and every server-side validation are the UI's. The gate's two-step
confirm is phrased for the agent: show the summary, get a yes, re-call with
`confirm=<nonce>`.

**Scope (pinned by `server/mcp/__tests__/tools.test.ts`).**

| | Tools |
|---|---|
| Reads | `nebula_whoami`, `list_envs`, `list_projects`, `list_repos`, `list_branches`, `branch_head`, `repo_config`, `release_train`, `release_images`, `cluster_overview` (all three clusters), `list_ci_runs`, `ci_run`, `ci_job_logs` |
| Logs (Observer tools, explicit scope) | `list_pods`, `log_histogram`, `fetch_logs`, `get_group_samples`, `node_metrics`: cluster ∈ {EKS-Twizz-NonProd, EKS-Moly-staging, **EKS-Moly-Prod**}, any namespace, window ≤ 24 h — prod is READ-ONLY |
| Monitor | `monitor {tier: production \| staging}` (§N6 snapshot) |
| twizz-sentinel (read key) | `sentinel_status`, `sentinel_alerts`, `sentinel_alert`, `sentinel_alert_stats`, `sentinel_events`, each `tier: staging (default) \| production` |
| Writes, self-service | `create_env_from_repo` (secret VALUES never accepted: declared secrets are created blank, filled in the UI) |
| Writes, owner or operator | `rebuild_env`, `set_env_vars` (credential-shaped values refused), `extend_env`, `teardown_env` |
| Writes, operators | `create_named_env`, `clone_staging_db`, `promote_release` / `merge_promotion` (target fixed to `staging`) |
| Capacity reads (everyone bound) | `capacity_presets`, `capacity_tier`, `capacity_plan` (named template → live ops + `planHash`), `prod_atlas_plan` |
| Capacity writes (operator **and** binding scope) | `apply_live_capacity` (`capacity:production` / `capacity:staging`; NAMED templates only: prod `baseline`/`campaign`/`max`, #6 floor + ×3/×0.5 + caps, nonce binds `planHash`), `set_prod_atlas_tier` (`capacity:production`; allowlisted clusters, +2/−1, M10–M200, nonce binds `from`) |

**Production:** reads for every bound person; the only prod writes are capacity, for an operator
whose binding carries `capacity:production` (`scripts/nebula-mcp-bind.sh … capacity:production`).
Tools a person may not use are not even listed (`toolsFor`), and each handler re-checks. Custom
sizes, `setAtlasTier` (NonProd) and capacity PRs stay UI-only.

**Sentinel.** `server/mcp/sentinel.ts`: GET-only, path allowlist, READ key only,
`x-actor: nebula-mcp:<login>`. Staging: `SENTINEL_STAGING_API_KEY` (copied from SM
`staging/twizz-sentinel` by `scripts/nebula-set-sentinel-key.sh`), base
`NEBULA_SENTINEL_STAGING_URL` (default `https://sentinel-stg.prv.twizz.com`, proxied by
Nebula's own `staging-edge-sentinel` Ingress). Production: `NEBULA_SENTINEL_PROD_URL` +
`SENTINEL_PROD_API_KEY` (`--prod`); unset → the tools answer "not reachable".
**State 2026-11-05:** prod sentinel is NOT installed — `values-prod.yaml` (gitops #5) and
`deploy/prod/bootstrap-prod.sh` exist, but no IAM role `twizz-prod-sentinel`, no SM
`prod/twizz-sentinel`, no pods on EKS-Moly-Prod; and values-prod has no ingress, so even
once installed Nebula needs an endpoint (e.g. an internal ingress on prod's ingress-nginx
behind the VPN, proxied like `staging-edge-sentinel`).

**Rollout.** (1) merge + build the dashboard image; (2) twizz-gitops: the
`dashboard-mcp` Ingress + image bump; (3) `AWS_PROFILE=twizz bash
scripts/nebula-set-sentinel-key.sh`, resync `nebula-env`, restart the dashboard;
(4) per person: `nebula-mcp-iam.sh user <name>` → they follow nebula-mcp ONBOARDING.md →
`nebula-mcp-bind.sh`; install: `/plugin marketplace add TwizzyNicky/nebula-mcp`,
`/plugin install twizz-nebula@nebula-mcp`. Missing config was filled 2026-11-05 by
`scripts/nebula-fill-secrets.sh` (staging sentinel key, staging API URL, Vercel).

## N8 — Prod sentinel + the sentinel log archive (2026-11-06)

Nebula reads production twizz-sentinel (alerts, cases, similar-alert vectors) and the raw-log
archive of prod and staging. Everything here is read-only.

**Prod sentinel API.** Prod sentinel (ns `sentinel` on EKS-Moly-Prod, gitops
`apps/twizz-sentinel/values-prod.yaml`) has no ingress. Nebula goes through the prod API
server's **service proxy**: `GET /api/v1/namespaces/sentinel/services/twizz-sentinel:http/proxy/api/v1/<path>`
with a fresh EKS token from the dashboard's IRSA role (group `nebula-capacity`, already on the
prod allowlist via the Nebula NAT). The connection is TLS, pinned to the cluster CA.
- RBAC: `infra/k8s/nebula-sentinel-proxy-rbac.yaml` grants `get services/proxy` on
  `twizz-sentinel:http` in ns `sentinel` and nothing else. It is applied and verified by
  `scripts/nebula-sentinel-proxy-access.sh`.
- The chart NetworkPolicy admits `allowFromCIDRs` (the VPC, `192.168.0.0/16`) on port `http`
  only, because the API server's ENIs sit in the cluster subnets.
- The sentinel API still requires its READ key: `SENTINEL_PROD_API_KEY` in SM
  `preview/nebula`, copied from `prod/twizz-sentinel` by `nebula-set-sentinel-key.sh --prod`.
  Its admin routes refuse that key.
- `NEBULA_SENTINEL_PROD_URL` overrides the proxy with a direct endpoint.
- MCP: the `sentinel_*` tools with `tier: production`.

**Archive.** Prod and staging sentinel write raw app log lines to
`s3://twizz-sentinel-logs-848281935985/env=<env>/dt=YYYY-MM-DD/*.jsonl.gz`:
- `{ts, pod, msg}` per line, SSE-KMS, 365-day lifecycle;
- prod writes `env=prod/*` only.

Athena workgroup `sentinel` (10 GiB scan cutoff, results expire after 7 d) queries the Glue
table `sentinel_logs.sentinel_app_logs`, which uses partition projection on env + dt. Owned by
`infra/addons` (see infra/CLAUDE.md, State).
- `@twizz-idp/core` `searchArchive` runs ONE fixed query template, with every caller value
  bound as an Athena execution parameter. Limits: at most 7 days, 1000 rows; LIKE wildcards
  in `contains` are escaped.
- `clusters.archiveSearch` (tRPC) is for **operators only**. It writes an AuditLog row
  `nebula.archive_search` before the query runs (denials are logged too), and every line is
  redacted with the Observer's redactor.
- MCP: the operator read `sentinel_archive_search`.
- The dashboard role reads `env=prod/*` and `env=staging/*` and writes `athena-results/*`.

**Similar alerts (vectors).** Prod sentinel embeds alerts with Bedrock
`amazon.titan-embed-text-v2:0` (eu-west-1, `EMBEDDINGS_SIMILAR_THRESHOLD` 0.92; IAM inline
policy `twizz-prod-sentinel-archive-embeddings`). `sentinel_alert {include: "similar"}` returns
them through the proxy.

**Turn-on order:**
1. `pulumi up` in `infra/addons` (done 2026-11-06).
2. The prod helm upgrade with the new `values-prod`. This runs over the SOCKS tunnel and
   starts the archive and embeddings.
3. `nebula-sentinel-proxy-access.sh`.
4. `nebula-set-sentinel-key.sh --prod`, then resync `nebula-env` and restart the dashboard.

## N9 — Lifecycle (built 2026-11-25)

*Ask: "one tab that shows what is outdated across the stack, what the monthly upgrade sweep is
doing, a staging preview of the consolidated change with a human sign-off — and a CVE lookup
for anything coming up that affects our stack." Decision: the Platform Lifecycle Orchestrator
(PLO, `twizz-app/platform-lifecycle-orchestrator`) runs as CronJobs in ns `nebula` and only
REPORTS in-cluster; Nebula stores what it posts and renders it. Nothing in this section lets
Nebula or in-cluster PLO change a cluster.*

**Shape.**
1. A PLO job finishes (`plan`, `cve`, `source`, or a `smoke` run) and a publisher step POSTs
   ONE JSON **snapshot** to `POST /api/lifecycle/ingest` on the dashboard Service. PLO never
   talks to the Nebula database.
2. The dashboard validates it (Zod, `@twizz-idp/shared` `lifecycle.ts`, schemaVersion 1),
   strips unknown keys, stores the parsed output in `LifecycleSnapshot` and writes an AuditLog
   row (`lifecycle.ingest`, actor `plo`). A snapshot is written ONCE: the same `runId` with the
   same content is an idempotent retry (200 `{id, duplicate: true}`, nothing changes), with
   different content a 409 — a stored snapshot is never replaced. The newest 60 per job are kept.
3. `/lifecycle` renders the latest snapshots: Schedule · Tiers · Advisories · Preview · History.
4. On-demand runs are **requests**: an operator confirms through the gate, a `LifecycleRequest`
   row is inserted, and the `plo-dispatch` CronJob claims it within about 5 minutes
   (`POST /api/lifecycle/requests/claim`, one `UPDATE … FOR UPDATE SKIP LOCKED`), runs it,
   publishes a snapshot and calls `…/requests/:id/complete`. The dashboard writes nothing to a
   kube API for this.
5. The monthly **bundle** (one branch `plo/bundle/<yyyy-mm>` per repository, every upgrade PR
   merged into it) goes through a state machine keyed by `bundleKey` (sha256 over the sorted
   `owner/name@sha` lines of every bundle with a head — Nebula RECOMPUTES it, see "Who is
   trusted for what"): `no-bundle → bundle-ready → preview-requested → preview-up →
   smoke-preview-pass|fail → stg-requested → stg-deployed → smoke-stg-pass|fail →
   awaiting-signoff → signed-off`. Five gated operator writes move it (below). A new bundle
   starts again at `bundle-ready`; no evidence carries over.
6. The sign-off is the human gate (Ember). It records an AuditLog row and comments on each
   bundled pull request. It merges NOTHING: merging the application PRs stays a human action
   in GitHub, and merging a staging promotion stays `merge_promotion` on /releases (§N4).

**The CVE lookup.** The `cve` job (daily 05:30 UTC) checks every inventory component and every
package of every repository's `package-lock.json` against OSV, the Node.js release feed
(base images), and enriches with CISA KEV and EPSS. Only a package name and a version leave
the cluster. The Advisories pane sorts known-exploited (KEV) first, then severity, then EPSS;
each row names the affected component, the version running, the version that fixes it, the
environments it reaches and the open upgrade PR if there is one. "new" = not in the previous
successful scan (by id or alias). Over MCP: `lifecycle_advisories` (filter by id / alias /
package, minimum severity, KEV, new-since-last-scan, environment). Which infrastructure
packages OSV actually knows is listed in PLO `docs/nebula.md`; a component OSV does not know
is silently NOT covered — the pane shows what was found, never "this component is clean".

**Trust boundaries.**
- **Ingest routes** (`/api/lifecycle/ingest`, `/requests/claim`, `/requests/:id/complete`):
  bearer `LIFECYCLE_INGEST_TOKEN` (Kubernetes Secret `plo-env` ← SM `nebula/plo`, the one copy
  PLO itself presents; never under `preview/*`, which every preview pod's role can read), compared with
  `timingSafeEqual` over sha256 digests. Unset or shorter than 32 chars → every call is 503
  (fail closed). Not session routes: deliberately NOT in the middleware matcher (a test pins
  that no matcher entry is a prefix of `/api/lifecycle/*`). Bodies over 4 MB are refused before
  parsing; a rejected snapshot answers with Zod issue paths only, never values.
- **Who is trusted for what (review 2026-11-25).** Treat whoever holds the ingest token as
  possibly compromised; this is exactly what its word is worth:
  - *plan / cve snapshots*: display only. They move no gate.
  - *source snapshots*: WHICH bundle exists. `bundleKey` is recomputed from `bundles`
    (`lifecycleBundleKey`, PLO's `computeBundleKey` byte for byte): ingest rejects a source
    snapshot whose key is not that hash (400 `bundleKey: not_the_hash_of_bundles`), and the
    reader drops one that is stored anyway and says so. Every gated write — create, smoke,
    deploy, sign-off — then re-reads every bundle branch head from GitHub and refuses when one
    moved or is gone. So a snapshot can only ever point a gate at commits that really are the
    heads of those branches; it cannot keep a tested key and re-point it at another commit.
  - *smoke snapshots*: the smoke VERDICT. **This is the one piece of gate evidence that is the
    holder's own word — Nebula cannot verify that the checks ran.** It is bound as far as a
    self-reported result can be: accepted only as the answer to a smoke request Nebula itself
    created (an operator, through the gate), only while that request is `claimed`, only for
    the request's own scope and bundle key, and only ONCE — ingest binds the request to the
    snapshot's `runId`, a second result is a 409, and `complete` cannot name another run. The
    verdict reads exactly that run, requires it to have been RECEIVED (server clock) after the
    claim and not after the completion, and requires every check to be a check of one of the
    request's own targets. A later snapshot can therefore never change a recorded verdict.
  - *`included` pull requests*: the sign-off asks GitHub for each one and comments only on an
    open pull request of that repository whose head commit is contained in the bundle head.
  - Not from the token holder at all: the request rows, the named-env manifests and their
    build records (gitops), image existence (ECR), what staging and the previews RUN (Argo),
    the sign-off (AuditLog).
- **`LIFECYCLE_DISPATCH_TOKEN` — the dispatcher's own credential.** With one shared token every
  PLO pod (and anything that can read the token) could answer a smoke request. With this second
  secret (≥ 32 chars, different from the ingest token) the two are separate credentials: the
  request queue (`claim`, `complete`) and smoke snapshots need the dispatch token; `source`
  snapshots need the ingest token; plan/cve snapshots take either. A misconfigured second
  token is a 503, never a fall back. It is wired end to end: `scripts/nebula-set-plo-secrets.sh`
  writes both tokens into SM `nebula/plo` (`NEBULA_INGEST_TOKEN`, `NEBULA_DISPATCH_TOKEN`);
  twizz-gitops syncs the second into its own Secret `plo-dispatch-env`, which only the
  `plo-dispatch` pod (as its `NEBULA_INGEST_TOKEN`) and the dashboard mount. The code still
  runs without it (one shared credential) and the Preview pane then says so under "Holding it
  back" — that is the state of a dashboard that started before `plo-dispatch-env` synced.
- Externally these paths sit behind the browser SSO gate AND the bearer. **In-cluster, on the
  Service, the bearer is the only credential and there is no rate limit**: any pod in the
  NonProd cluster may try tokens. The token is 32 random bytes.
- **`plo-source`** builds and tests application repo code (untrusted). It runs under SA
  `plo-source` (no IAM role, no kube token) as an init container holding only `GH_TOKEN`; a
  second container holds only the ingest token, runs no repo code, re-validates the files and
  POSTs. The ingest token is never in the environment of a container that runs repo code.
- **Helm discovery exposure.** SA `plo` → IRSA role `twizz-nebula-plo` (read-only). On each of
  the three clusters its access entry maps to the group `nebula-plo` and carries NO EKS access
  policy (`AmazonEKSViewPolicy` would add pod logs and ConfigMaps of every namespace); the group
  may get/list namespaces and nodes, plus `list secrets` in the namespaces an operator NAMES
  when running `scripts/nebula-plo-access.sh --helm-namespaces …` (`infra/k8s/nebula-plo-rbac.yaml`;
  a plain run opens none). Helm stores a release with its values in
  a Secret and RBAC cannot filter by label, so that role can read every Secret of those
  namespaces (on NonProd the candidates include `argocd`, `auth`, `external-secrets` — the script asks
  for an explicit override before opening those). PLO keeps Helm
  values out of every snapshot and Nebula stores only the parsed schema, but the role can read
  them. Without that RBAC the Helm tier reports a discovery error and the rest still works.
- **`global_deny`**: no gate field of the five tools ever carries "prod" or "staging"; the
  staging scope is the literal `stg` and the bundle key is hex.

**The five gated writes** (`routers/actions.ts`, operators only, policy.yaml `write_tools`;
logic and ports in `@twizz-idp/actions` `lifecycle.ts`). Each plans BEFORE the gate, so the
summary the human confirms is what would really happen, and re-plans inside the gate from a
fresh read; a plan that no longer matches the confirmed fields is refused. The caller supplies
only a run kind, a scope or a bundle key.

| tRPC `actions.*` | gate tool | what it does |
|---|---|---|
| `lifecycleRequestRun {kind}` | `lifecycle_request_run` | queue a `plan` or `cve` run (refused while one is pending/claimed) |
| `lifecycleCreatePreview {bundleKey}` | `lifecycle_create_preview` | one named env `plo-<yymm>-<service>` per bundled registry service, pinned to the bundle head, 72 h, through `createEnvFromRepo`; all or nothing against the env cap |
| `lifecycleRequestSmoke {scope, bundleKey}` | `lifecycle_request_smoke` | queue a smoke run; targets are built server-side: for `preview` each env's Service inside the cluster, for `stg` the fixed staging hosts |
| `lifecycleDeployStg {bundleKey}` | `lifecycle_deploy_stg` | open the staging promotion PR(s) with each preview env's image, through `promoteRelease`; needs a passed preview smoke |
| `lifecycleSignoff {bundleKey}` | `lifecycle_signoff` | the human gate: AuditLog `nebula.lifecycle_signoff` + one comment per bundled PR |

**What the gates mean by their words — each fails closed** (review 2026-11-25):
- *the bundle's preview env* is ONE env: the one named `plo-<yymm>-<service>`, built from that
  repository, that bundle branch and that head sha, for that service, and created by a Nebula
  operator. Any other env — another `plo-*` name on the same commit, the right name from
  another commit or branch, the right name owned by a non-operator — is never adopted; it is
  listed under "Holding it back" and the flow stops. The `plo-` prefix is RESERVED: only
  `lifecycle_create_preview` creates such an env (`createEnvFromRepo` / `createNamedEnv` and
  their tRPC procedures refuse the name for everyone, operators included; policy.yaml denies
  it for `create_named_env`).
- *up* / *deployed* = gitops names the bundle image (`nb-<envName>-<sha12>`, exactly), Argo is
  Synced + Healthy, **and Argo's `status.summary.images` reports the pods on that image and no
  other tag of that repository**. Synced + Healthy alone is not it: between a promotion merge
  (or a rebuild) and Argo's next poll (~3 min) it still describes the previous image. An
  Application that reports no images is "not deployed".
- *a smoke target* has ONE form per scope, the same on both sides (shared `LifecycleSmokeParams`,
  PLO `smoke.allowedHosts`): `preview` → `http://<service>.env-<envName>.svc.cluster.local[:<port>]`,
  the env's own Service on the port its manifest records (that branch's `twizz.yaml`); `stg` →
  `https://<short>-stg.prv.twizz.com`. A preview smoke does NOT go through the public host
  `https://<envName>.prv.twizz.com`: every preview Ingress is behind the ingress-nginx Google
  sign-in gate, which answers an unauthenticated GET with 302 whatever the app does (gitops
  review #3). `plo-dispatch` runs in the same cluster and calls the Service directly. A target
  of one scope is never accepted for the other, and a preview target must be the Service of
  the target's own registry service.
- *the smoke passed* = the verdict above, AND it covered every expected service at the origin
  where the bundle runs (for a preview: that env's Service, on that env's port) with at least
  one passing check, AND the request was created after
  the env was built AND after Argo finished rolling out what runs now
  (`status.operationState.finishedAt`, phase Succeeded). An unknown rollout time is not
  evidence: run the smoke again.
- *sign-off* needs the preview smoke of EVERY bundled service — also when the bundle has a
  staging route. The staging smoke only calls the release-train services and can never stand
  in for the others.
- *a bundle* comes from a SUCCESSFUL source run. A failed run's partial bundle is shown and
  cannot be previewed, deployed or signed off.
- *the image that goes to staging* is the one the bundle's own preview env runs, built with
  the dockerfile, context and kind the repository's `twizz.yaml` declares at the bundle head.
- **Frontends and staging.** A preview image whose build args carry a preview-domain address
  that is not one of the fixed staging hosts is NOT promoted (`lifecycle_deploy_stg` refuses
  the whole call and says which arg). `lifecycle_create_preview` builds a bundled frontend
  against its bundled backend's 72 h preview env, so today **a bundle that contains
  `twizz-admin` cannot be taken to staging from `/lifecycle`** — see **Not done**.

**The tab** (`/lifecycle`, sidebar `Lc`). Header: six tiles (outdated, critical/high, known
exploited, bundle state, last plan, last CVE scan — each a button to its pane) and ONE "next"
line derived from what the server allows (`lib/nebula/lifecycle.ts` `nextAction`): the
bundle's pipeline step first, else KEV, else critical/high, else stale data, else what is
outdated.
- **Schedule**: job · what · when (plain words + the cron) · next run (UTC + relative) · last
  run · result · where it runs · "Run now" for plan/cve. `sweep-staging` and `promote-prod`
  are listed as "GitHub Actions / not reported to Nebula".
- **Tiers**: one plate per tier in dependency order (control plane → add-ons → nodes → Helm →
  base images → npm direct → npm transitive), a summary line that always counts everything,
  and a table. The default filter keeps "what needs attention": any non-current status, any
  advisory, or end-of-life — an up-to-date but vulnerable component is never hidden. Rows are
  sorted riskiest first. Clicking a component opens a drawer (reasons, handling, rollback,
  end of life, advisories).
- **Advisories**: as above.
- **Preview**: the stepper, "what can be done now" (five buttons; each disabled one shows the
  server's reason), what holds the bundle back, one card per bundled repository (branch, sha,
  included PRs, conflicts as FAIL rows, the preview env, staging and its promotion PR) and the
  two smoke result tables.
- **History**: snapshots received and on-demand requests.
- Non-operators read everything; every control is rendered disabled with
  `title="operators only"`. Stale data (plan > 8 days, cve > 36 h), a failed latest run and
  unreachable sub-sources (GitHub, Argo) are shown as notices; nothing is silently missing.
- Status vocabulary: PLO's component statuses map onto existing words, with the PLO status in
  plain text next to the pill. **Five words were added** to `lib/nebula/status.ts` —
  `CRITICAL`, `HIGH`, `KEV` (fail tone), `MODERATE` (pending), `LOW` (muted) — because a
  severity is its own word. None is Ember; `AWAITING HUMAN` stays the only Ember word.

**Where it runs.** twizz-gitops `apps/nebula/plo.yaml`: CronJobs `plo-cve` (`30 5 * * *`),
`plo-plan` (`0 6 * * 1`), `plo-source` (`0 7 2 * *`), `plo-dispatch` (`*/5 * * * *`), all UTC,
all shipped `suspend: true` with the image placeholder `plo-REPLACE_WITH_SHA`. ExternalSecret
`plo-env` (SM `nebula/plo`: `NEBULA_INGEST_TOKEN`, the publishers') and `plo-dispatch-env`
(SM `nebula/plo`: `NEBULA_DISPATCH_TOKEN`, only `plo-dispatch`). Image `twizz-idp:plo-<sha>` in ECR,
built by PLO's own `build-image.yml`; `scripts/nebula-plo-access.sh` adds the ECR keep-rule
for `plo-*`. The schedule's source of truth is PLO `config/inventory.yaml` `schedule:`. The
staging infrastructure sweep and the prod promotion stay in PLO's GitHub Actions workflow;
`PLO_IN_CLUSTER=1` makes the CLI refuse `run --stage <infra stage> --execute`.

**Code.**
- DB: `LifecycleSnapshot`, `LifecycleRequest`; migration `0003_lifecycle`. Sign-offs are
  AuditLog rows, not a table.
- Shared: `packages/shared/src/lifecycle.ts` (the snapshot contract; PLO
  `src/nebula/snapshot.ts` must mirror it). The contract is pinned as files:
  `packages/shared/src/__tests__/fixtures/lifecycle-contract/*.json` are generated by PLO's own
  builder (PLO `test/contract.test.ts` fails when it stops producing them) and copied here
  byte for byte. `lifecycle-contract.test.ts` in `packages/shared` requires that the schema
  accepts them with nothing stripped and that vocabularies, limits and key sets match; the
  one in `apps/dashboard/src/server/nebula/__tests__/` sends them through the real ingest,
  claim and complete handlers and builds the view from what was stored. Never edit the
  files by hand: regenerate in PLO and copy (the copy is a manual step).
- Server: `server/nebula/lifecycle-model.ts` (pure: cron evaluator, tiers, advisories, stale
  flags, the preview state machine), `lifecycle.ts` (reader + the one enqueue helper),
  `lifecycle-ingest.ts` (handlers), `lifecycle-actions.ts` (wiring), `app/api/lifecycle/**`.
- tRPC: `lifecycle.overview`, `.advisories`, `.preview`, `.history` (queries, any signed-in
  user; every sub-source failure is returned as `{ error }`); the five `actions.lifecycle*`
  mutations above.
- UI: `app/(dashboard)/lifecycle/page.tsx`, `components/lifecycle/` (`lifecycle-view`,
  `schedule-pane`, `tiers-pane`, `advisories-pane`, `preview-pane`, `history-pane`,
  `gate-result`, `parts`), pure helpers `lib/nebula/lifecycle.ts`. Types come from the router
  (`inferRouterOutputs`) and from the action functions (type-only imports).
- MCP: read tools `lifecycle_overview` and `lifecycle_advisories`. No lifecycle write is
  exposed over MCP.
- Env: `LIFECYCLE_INGEST_TOKEN` (required for ingest; from Secret `plo-env`);
  `LIFECYCLE_DISPATCH_TOKEN` (the dispatcher's own credential, from Secret `plo-dispatch-env`; see
  **Trust boundaries**). `NEBULA_STAGING_API_URL` is now also
  the build-time API a bundled frontend preview attaches to when its backend is not in the
  same bundle.
- Tests (2026-11-25, after the external review): shared 30, actions 234, reaper 17, dashboard
  438 passed + 9 skipped (the opt-in real-Postgres store test, `LIFECYCLE_TEST_DATABASE_URL`;
  run separately against a throwaway local `postgres:17-alpine` with the three migrations
  applied: 9 passed, including the claim/audit rollback and the jsonb-reordered idempotent
  retry). The gate-bypass claims of the review are pinned end to end in
  `lifecycle-actions.test.ts` ("gate bypass claims", "a compromised ingest-token holder").

**Gotchas.**
- "Latest" is by time RECEIVED, staleness by the run's own `finishedAt`. A failed newer run
  does not replace the data shown; the pane says so.
- A smoke verdict belongs to the LATEST request for (scope, bundle): re-running suspends an
  older pass until the new run reports.
- "Up" and "deployed" need Argo `PASS` AND Argo reporting the pods on the expected image (see
  above). Argo unreachable fails closed and is listed under "Holding it back". For the few
  minutes after a promotion merge the page says "gitops is on the bundle image but Argo does
  not report the pods on it yet" — that is the rollout, not a fault.
- Anything that re-syncs a preview env or staging after its smoke (a rebuild, new env vars, a
  later promotion) makes that smoke stale: the page asks for it again before the next gate.
- A named-env create (`create_named_env`, `create_env_from_repo`, `lifecycle_create_preview`)
  runs under one Postgres advisory lock, so two creates cannot both count the same free slot
  and exceed `NEBULA_MAX_NAMED_ENVS`.
- When a preview batch is rolled back and a secret cannot be deleted, the error names the
  secret: delete it by hand or the next create fails on it.
- The builder's `service` input is the ECR repository (`envEcrRepo`: the registry's `ecrRepo`,
  e.g. `molybackend` for moly-backend), the same one the watcher checks and the chart pulls.
- Every link built from a snapshot is `https` on an allowlisted host (GitHub, osv.dev,
  nodejs.org, nvd.nist.gov, cve.org, cisa.gov), enforced by the schema at ingest and again by
  `<Ext>` at render; a pull request URL must be exactly that pull request's GitHub URL.
- The gated deploy and sign-off are stricter than the buttons: they also require the smoke to
  have covered every expected service with at least one passing check. A service with no
  smoke checks in the PLO inventory therefore blocks both, with the button enabled; the gate's
  error says why.
- Preview env names are per month. A re-bundle in the same month meets the old env's name and
  the create is refused until the old env is torn down on /environments.
- A pre-gate refusal arrives as a tRPC `PRECONDITION_FAILED` and the dialog shows it in its
  error phase; nothing was written.
- `apps/dashboard/.env.local` on a developer machine has no `GITHUB_TOKEN`: the Preview pane
  then shows "could not be read" for envs, promotions and staging. That is the designed
  failure, not a bug.

**Not done / decisions left.**
- **Nothing is rolled out.** No image, secret, IAM role, RBAC or CronJob exists yet; the
  code was verified with unit tests, a local Postgres and a local dashboard only. The five
  gated writes were tested against fakes — never against real GitHub, AWS or a cluster.
- **The two snapshot schemas agree on files, not yet on a live run.** Both require `bundleKey`
  to be 64-hex and `startedAt`/`finishedAt` to be ISO datetimes, and the contract fixtures
  (see **Code**) pin that. No real PLO pod has posted to a real dashboard: do step 7 below
  (one manual run per job) before trusting anything.
- **The smoke verdict is self-reported (narrowed, not closed).** Everything above binds a smoke
  result to Nebula's own request, but the pass/fail itself is whatever the holder of the
  DISPATCH token posts. With `LIFECYCLE_DISPATCH_TOKEN` rolled out that is the `plo-dispatch`
  pod (PLO image only, no repository code) and whoever can read Secret `plo-dispatch-env` or SM
  `nebula/plo`. Closing it fully would mean Nebula running the GET-only checks itself.
- **NEEDS OWNER — `admin-stg.prv.twizz.com` is behind the SSO gate.** A staging smoke of
  `twizz-admin` is answered 302 and fails. Exempt a health path of `staging-edge-admin` (gitops)
  or accept that a bundle with twizz-admin cannot pass its staging smoke. (It cannot be promoted
  from a bundle preview today anyway — next item.)
- **NEEDS OWNER — a bundled `twizz-admin` cannot reach staging from `/lifecycle`.** Its
  preview image bakes the API address at build time. Decide: build the bundled frontend
  against its fixed staging API (the preview then talks to staging's backend), or make the
  frontend read the API address at runtime. Until then the deploy is refused, by design.
- **NEEDS OWNER — verify `twizz-gha-ecr-push` may push to `molybackend`, `twizz-frontend`
  and `twizz-business`** (the builder now pushes where the chart pulls; before, such an env
  was promoted onto an image its pods could not pull).
- Existing `plo-*` envs created by hand before the prefix was reserved are not adopted unless
  an operator owns them and they match the bundle exactly; tear any other down.
- **A bundle that includes `twizz-admin` or `frontend` cannot be deployed to staging or signed
  off today.** PLO's inventory has smoke checks for `moly-backend` and `twizz-sentinel` only,
  and the gate needs at least one passing check per expected service. Add `smoke:` entries for
  the two frontends in PLO `config/inventory.yaml` (the path and status each really answers)
  before the first bundle.
- A bundled repository outside `twizz-app` (e.g. `xenosnikos/twizz-support`) counts as
  previewable in the state machine but `lifecycle_create_preview` refuses it, so such a bundle
  cannot progress. Decide: map it or mark it not previewable in the model.
- Auto-replacing a same-month preview env on a re-bundle (today: tear down by hand).
- A bundled frontend preview is built against its backend, but the backend env's CORS list
  does not include the frontend origin: the smoke works, a browser session may not.
- All-or-nothing preview creation has a residual gap: an already dispatched build still runs
  and pushes an image, and a first-time `apps/<svc>/values.yaml` stays.
- No rate limit on the ingest routes; unauthenticated attempts are not audited (flood vector).
- Applying infrastructure tiers from the cluster (staging sweep, prod promotion) stays in
  GitHub Actions until the platform owner decides otherwise; the tab only lists their schedule.
- MCP: no lifecycle write tools. The nebula-mcp plugin `SKILL.md` (0.6.0, not released)
  describes the two read tools; the server `INSTRUCTIONS` text does not mention them yet.
- The advisory list is only as wide as OSV's coverage of the mapped infrastructure packages.
- UI: the later Preview states were verified in a browser with real `buildPreview` output
  injected into the page (no local GitHub/Argo), not through a live cluster. No component
  test harness exists; only the pure helpers are unit-tested.
- `STATE.md` was not updated.

**Rollout / turn-on order.** Human steps are marked **[human]**; every one is idempotent.
1. **[human]** Review and merge the twizz-idp PR (`feat/lifecycle-tab`); `build-images.yml`
   builds `dashboard-<sha>` and `migrate-<sha>`.
2. **[human]** `AWS_PROFILE=twizz pulumi up` in `infra/addons` — IRSA role `twizz-nebula-plo`
   and its EKS access entries (group `nebula-plo`, no access policy) on EKS-Twizz-NonProd,
   EKS-Moly-staging and EKS-Moly-Prod; External Secrets' read access to exactly SM `nebula/plo`
   and `nebula/plo-source-github`; and the Deny that keeps the preview pods' role away from the
   platform's own secrets (review the Deny list first). Never the root `infra/` program.
3. **[human]** `AWS_PROFILE=twizz bash scripts/nebula-set-plo-secrets.sh` — creates SM
   `nebula/plo` with `NEBULA_INGEST_TOKEN` (publishers) and `NEBULA_DISPATCH_TOKEN`
   (dispatcher). Nothing is written under `preview/*`; the script stops if an old copy is there.
4. **[human]** `AWS_PROFILE=twizz bash scripts/nebula-plo-access.sh` (EKS admin; the SOCKS
   tunnel up for prod). A plain run opens NO Secrets: it lists the namespaces that hold Helm
   releases and you name the ones to open with `--helm-namespaces <cluster>=<ns,…>` — that is
   the Secret exposure you are accepting. It also adds the ECR keep-rule for `plo-*`.
5. **[human]** twizz-gitops: pin dashboard AND migrate to the new sha (migration
   `0003_lifecycle` must run) and wait for the Argo app to be Synced + Healthy. Merge the PLO
   workload PR (`plo.yaml`, placeholder tag, suspended; `dashboard.yaml` reading the two
   tokens). Then, with `K = kubectl --kubeconfig ~/.kube/twizz-nonprod.yaml -n nebula`:
   `K wait --for=condition=Ready externalsecret/plo-env externalsecret/plo-dispatch-env --timeout=10m`
   and only then `K rollout restart deploy/dashboard` (it reads both tokens at start). Check:
   `/lifecycle` loads and shows "Nothing has reported yet", WITHOUT the shared-token notice; an
   unauthenticated `POST /api/lifecycle/ingest` from a pod answers 401, not 503.
6. **[human]** Create `twizz-app/platform-lifecycle-orchestrator` (private), push PLO as
   TwizzyNicky; its `build-image.yml` pushes `twizz-idp:plo-<sha>` (the OIDC role
   `twizz-gha-ecr-push` must trust that repository). A SECOND twizz-gitops PR then replaces
   `REPLACE_WITH_SHA` with that commit sha on all five image lines of `plo.yaml` (the file was
   merged with the placeholder in step 5). Everything is still suspended.
7. **[human]** One manual run per job, then read the pod log and `/lifecycle`:
   `K create job --from=cronjob/plo-cve plo-cve-manual-1`, then the same for `plo-plan`; then
   "Run now" for plan on `/lifecycle` and `K create job --from=cronjob/plo-dispatch plo-dispatch-manual-1`.
   A 400 from ingest here means the two snapshot schemas disagree — fix that first; a 403 means a
   pod presents the other job's token.
8. **[human]** Un-suspend in git, one CronJob per PR: `plo-cve`, `plo-plan`, `plo-dispatch`,
   and `plo-source` LAST (it opens real PRs and force-pushes `plo/bundle/<yyyy-mm>` on the
   application repos). `plo-source` cannot start before its dedicated GitHub token exists
   (`scripts/nebula-set-plo-source-token.sh`, then the ExternalSecret `plo-source-github`; the
   gitops file header says exactly which token) — never point it at the platform PAT.
9. **[human]** First bundle: walk it once on `/lifecycle` → Preview with an operator —
   create the preview, smoke, deploy to staging, merge the promotion on /releases, staging
   smoke, sign off — and compare each gate summary with what actually happened.
10. Optional: release the nebula-mcp plugin 0.6.0 (its `SKILL.md` already covers the two MCP
    read tools).
