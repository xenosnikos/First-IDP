# @twizz-idp/dashboard — Nebula

Next.js 15 App Router app, branded **Nebula** (docs/NEBULA.md). Hosted **in-cluster**
at `nebula.prv.twizz.com` (root Dockerfile `dashboard` target: `output: "standalone"`).
`/api/health` is the probe.

## Write policy (deliberate exception to "dashboard is read-only")
The ONLY writes are the Nebula named-env actions in `src/server/routers/actions.ts`.
Who may: `createNamedEnv` (release image) and `cloneStagingDb` need the operator allowlist
(`NEBULA_OPERATORS`, `src/lib/nebula/operators.ts`); `createEnvFromRepo` (build-on-provision,
docs/NEBULA.md §N3.7) is self-service for any signed-in user; `teardownNamedEnv`,
`extendNamedEnv`, `setEnvVars`, `rebuildFromRef` are owner-or-operator (`ownedEnv()`, denial
audited); `promoteRelease` / `mergePromotion` (release train, docs/NEBULA.md §N4: a gitops PR
to the staging tier, then a sha-guarded merge) are operator-only, as are `applyCapacityPreset` /
`mergeCapacityPr` / `setAtlasTier` / `applyLiveCapacity` / `setProdAtlasTier` (capacity, docs/NEBULA.md §N5–§N5.3). Every one then goes through `@twizz-idp/actions` `createGate` (policy.yaml →
`PrismaNonceStore` two-step confirm → action → `AuditLog` row). Secret VALUES never enter
gate fields, summaries, audit rows, results or git — `createEnvFromRepo` refuses them on the
request call and accepts them only with the nonce. Never add a mutation that bypasses the
gate. No kube API writes. The Configurator (`/api/configurator`) is read-only and audited.
Policy file: `apps/mcp/policy.yaml`, resolved by `src/server/nebula/deps.ts` and traced
into the standalone image by `next.config.ts`.

## Brand (docs/NEBULA.md §2)
Tokens in `src/app/globals.css` (dark plate default, light paper via
`prefers-color-scheme` / `data-theme`). Gloock + Azeret Mono via `next/font/google`.
Primitives in `src/components/nebula/`: `Pill` (a colour never without its word — use
only `STATUS_WORDS` from `src/lib/nebula/status.ts`), `EmberButton` (human gate ONLY),
`Button`, `Plate/Row`, `Drawer`, `GateDialog`. Inline styles; no shadcn.

## Auth
Auth.js v5. `src/lib/auth.config.ts` is edge-safe (middleware; no Prisma; `trustHost`
for the ingress); `src/lib/auth.ts` adds org-membership RBAC + AuditLog. Session carries
`login` (GitHub) — the actor for every audit row — and `accessToken`, refreshed in the jwt
callback (`src/lib/github-token.ts`; GitHub App tokens expire in 8 h). GitHub reads use
`server/nebula/github-session.ts` `withGithub()`: session token first, the platform token on
a 401. Never build a `GitHubService` from `session.accessToken` directly.

## Routes
`/environments` Nebula grid (preview/pending cards, "Spin up from a repo" drawer for everyone,
release-image drawer for operators; non-prod tier only), `/environments/topology` the pre-Nebula
introspection map, `/projects` (kind column + "Spin up"), `/clusters` (Observer), `/pipelines`,
`/releases` the release train (`components/releases/release-train.tsx`), `/capacity` the capacity
planner (`components/capacity/capacity-view.tsx`), `/monitor` the read-only prod/staging monitor
(`components/monitor/monitor-view.tsx`, server `server/nebula/monitor.ts` + pure `monitor-model.ts`, §N6).

## MCP endpoint (docs/NEBULA.md §N7)
`src/app/api/mcp/route.ts` (stateless Streamable HTTP) → `server/mcp/auth.ts` + `identity.ts` (HARD gate:
GitHub token + Google ID token + presigned STS GetCallerIdentity, all matching `NEBULA_MCP_IDENTITIES`; §N7.1) → `server/mcp/tools.ts` (explicit tool
list; each tool = a tRPC procedure through `appRouter.createCaller`, an Observer tool with an explicit
NonProd/staging/prod scope, or a GET on sentinel `server/mcp/sentinel.ts`). Every tool call
writes an `mcp.tool.*` AuditLog row with all three identities. The ONLY prod writes are the two capacity
tools (operator + `capacity:<tier>` scope; named template or a server-side traffic estimate, never a custom
size; §N5.4). Never add another write that takes a cluster/tier/target, or a secret VALUE input; the tests pin it.

## Tests
`pnpm --filter @twizz-idp/dashboard test` (vitest): status-word mapping, operator
allowlist, policy wiring, spin-up helpers, and `create-env-from-repo.test.ts` — the gated
create path against fake ports (secret values only ever land in the secret store).

## Gotchas
- tsconfig `declaration: false` — re-enabling resurrects TS2742 from next-auth/trpc
- Middleware must never import Prisma
- `@kubernetes/client-node` is `serverExternalPackages`; Prisma engine + policy.yaml are
  `outputFileTracingIncludes` — check `.next/standalone` if either breaks
