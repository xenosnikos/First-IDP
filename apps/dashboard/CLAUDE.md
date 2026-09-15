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
audited). Every one then goes through `@twizz-idp/actions` `createGate` (policy.yaml →
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
`login` (GitHub) — the actor for every audit row.

## Routes
`/environments` Nebula grid (preview/pending cards, "Spin up from a repo" drawer for everyone,
release-image drawer for operators), `/environments/topology` the pre-Nebula introspection
map, `/projects` (kind column + "Spin up"), `/clusters` (Observer), `/pipelines`.

## Tests
`pnpm --filter @twizz-idp/dashboard test` (vitest): status-word mapping, operator
allowlist, policy wiring, spin-up helpers, and `create-env-from-repo.test.ts` — the gated
create path against fake ports (secret values only ever land in the secret store).

## Gotchas
- tsconfig `declaration: false` — re-enabling resurrects TS2742 from next-auth/trpc
- Middleware must never import Prisma
- `@kubernetes/client-node` is `serverExternalPackages`; Prisma engine + policy.yaml are
  `outputFileTracingIncludes` — check `.next/standalone` if either breaks
