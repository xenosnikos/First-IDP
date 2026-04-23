# @twizz-idp/db

Prisma schema and client for the IDP PostgreSQL database.

- Import: `import { prisma, Project, Environment } from "@twizz-idp/db"`
- Run `pnpm db:generate` after schema changes
- Run `pnpm db:migrate` to create migrations
- Run `pnpm db:push` for quick prototyping (no migration files)
- Schema at `prisma/schema.prisma`
