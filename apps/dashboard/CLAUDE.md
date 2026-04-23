# @twizz-idp/dashboard

Next.js 15 App Router dashboard for TWIZZ-IDP. Hosted on ECS Fargate (standalone output mode).

## Auth
GitHub OAuth via Auth.js v5. Session checked via `auth()` in server context.

## API
tRPC 11 with routers in `src/server/routers/`. Exposed at `/api/trpc`.
- `project` - CRUD + GitHub repo detection
- `environment` - create/teardown environments
- `pipeline` - trigger/poll Argo workflows
- `secret` - list secret key names (no values)
- `release` - create/promote/rollback releases

## Services
External API wrappers in `src/server/services/`. Each has a singleton export + class.
Many methods are stubbed with TODO -- implement against real APIs.

## UI
shadcn/ui + Tailwind 4. Components in `src/components/`.

## Workspace deps
`@twizz-idp/db` (Prisma client), `@twizz-idp/shared` (types + validators)
