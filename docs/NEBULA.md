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
