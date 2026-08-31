# Drop-in replacement for MymTwo/Moly-backend Dockerfile.
# Multi-stage: one npm ci (not two), sharp built once, dev deps pruned from the
# runtime image. Node pinned to 22 (matches package.json engines >=22 — the old
# image ran node 23 against an engines field that said 22).

FROM public.ecr.aws/docker/library/node:22.14.0-alpine3.21 AS deps
RUN apk add --no-cache vips-dev fftw-dev build-base python3
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps

FROM deps AS build
COPY . .
RUN npm run build \
 && npm prune --omit=dev --legacy-peer-deps

FROM public.ecr.aws/docker/library/node:22.14.0-alpine3.21
RUN apk add --no-cache vips fftw
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/migrate.js ./migrate.js
COPY --from=build /app/migrations ./migrations
EXPOSE 8080
CMD ["npm", "run", "start:prod"]
