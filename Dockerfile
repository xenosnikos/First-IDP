# syntax=docker/dockerfile:1.7
# Images for the in-cluster half of the platform, built from the pnpm
# workspace. Two targets, one ECR repo:
#   docker build --target reaper    -t 848281935985.dkr.ecr.eu-west-1.amazonaws.com/twizz-idp:reaper-<sha> .
#   docker build --target dashboard -t 848281935985.dkr.ecr.eu-west-1.amazonaws.com/twizz-idp:dashboard-<sha> .
# Both run as the unprivileged `node` user; secrets arrive at runtime (IRSA,
# ESO-synced env), never at build time.

ARG NODE_IMAGE=public.ecr.aws/docker/library/node:22-alpine
ARG PNPM_VERSION=9.15.4

# ── base: node + the pinned pnpm from package.json#packageManager ─────
FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app

# ── workspace: sources + full install (dev deps included, for prisma/next) ──
FROM base AS workspace
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile
# Prisma client for AuditLog rows (both targets import @twizz-idp/db).
RUN pnpm --filter @twizz-idp/db generate

# ═══════════════════════════════════════════════════════════════════════
# reaper — hourly CronJob; runs TS straight through tsx (like apps/mcp),
# so the runtime image is the reaper + its workspace deps, prod deps only.
# ═══════════════════════════════════════════════════════════════════════
FROM workspace AS reaper-prune
RUN pnpm --filter @twizz-idp/reaper --prod deploy /out/reaper
# `pnpm deploy` re-installs into /out without the generated Prisma client;
# copy it from the workspace install (same lockfile => same virtual-store path).
RUN set -eu; \
    src=$(find /app/node_modules/.pnpm -maxdepth 1 -type d -name '@prisma+client@*' | head -1); \
    dst=$(find /out/reaper/node_modules/.pnpm -maxdepth 1 -type d -name '@prisma+client@*' | head -1); \
    cp -r "$src/node_modules/.prisma" "$dst/node_modules/.prisma"

FROM base AS reaper
ENV NODE_ENV=production
COPY --from=reaper-prune --chown=node:node /out/reaper /app
USER node
# GITHUB_TOKEN, AWS_REGION (+ IRSA), optional DATABASE_URL / REAPER_DRY_RUN at runtime.
CMD ["node_modules/.bin/tsx", "src/index.ts"]

# ═══════════════════════════════════════════════════════════════════════
# dashboard — Next.js standalone output of apps/dashboard (next.config.ts
# sets output: "standalone"). In a monorepo the standalone tree keeps the
# workspace layout, so the server lives at apps/dashboard/server.js.
# ═══════════════════════════════════════════════════════════════════════
FROM workspace AS dashboard-build
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @twizz-idp/dashboard... build \
 && mkdir -p apps/dashboard/public   # optional in Next; keep the COPY below unconditional

FROM base AS dashboard
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=dashboard-build --chown=node:node /app/apps/dashboard/.next/standalone ./
COPY --from=dashboard-build --chown=node:node /app/apps/dashboard/.next/static ./apps/dashboard/.next/static
COPY --from=dashboard-build --chown=node:node /app/apps/dashboard/public ./apps/dashboard/public
USER node
EXPOSE 3000
CMD ["node", "apps/dashboard/server.js"]
