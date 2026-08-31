# @twizz-idp/dashboard

Next.js 15 App Router dashboard. **Read-only surface** — no write mutations except
project registration; environments/deploys are driven by GitOps. Hosted on Vercel
(Phase 2; Dockerfile/ECS path retired).

## Auth
Auth.js v5. Split config: `src/lib/auth.config.ts` is edge-safe (middleware imports it,
no Prisma); `src/lib/auth.ts` adds the org-membership RBAC `signIn` callback + User
upsert + AuditLog. Session checked via `auth()` in server context.

## API
tRPC 11, routers in `src/server/routers/` (`project`, `environment`, `pipeline`,
`secret`, `logs`) — all `protectedProcedure`, all reads.

## Services
`src/server/services/`: `github.ts`, `aws.ts`, `vercel.ts`, `atlas.ts`, `introspect.ts`.
All real implementations (no stubs).

## UI
Tailwind 4, inline styles (no shadcn/ui). Components in `src/components/`
(`environments/`, `pipeline/`, `projects/`, `layout/`).

## Workspace deps
`@twizz-idp/db` (Prisma client), `@twizz-idp/shared` (types + validators)

## Gotchas
- tsconfig sets `declaration: false` — re-enabling resurrects TS2742 errors from next-auth/trpc
- Middleware must never import anything that pulls in Prisma
