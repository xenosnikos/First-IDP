# @twizz-idp/actions

The platform's **write gate** and the Nebula named-env actions, shared by the
MCP server (`apps/mcp`, stdio) and — later — the in-cluster Nebula UI. No
Kubernetes API anywhere in here: every write is a GitHub Contents-API commit to
`TwizzyNicky/twizz-gitops` or a Secrets Manager call; Argo CD does the rest.

- `gate.ts` — `createGate()`: policy allowlist → two-step confirm nonce → action → audit row
- `policy.ts` — glob policy evaluator (`loadPolicyFile` reads the caller's `policy.yaml`)
- `confirm.ts` — `NonceStore` interface; `MemoryNonceStore` (single process) and `PrismaNonceStore` (`ActionNonce` table)
- `audit.ts` — `createAudit()`: `AuditLog` row when a Prisma client is supplied, `~/.twizz-mcp-audit.jsonl` otherwise
- `named-envs.ts` — pure helpers (Mongo URI rewrite, manifest (de)serialisation, validation) + the four actions over injected `GitopsRepo` / `SecretStore` / `ImageRegistry` ports
- `promote.ts` — the release train (docs/NEBULA.md §N4): `promoteRelease` (gitops PR bumping `apps/<svc>/values-staging.yaml`), `mergePromotion` (sha-guarded squash), `listReleaseCandidates`, `listPromotions`, `readTargetState`; targets come from `registry.ts releaseTrain`
- `capacity.ts` — capacity templates (docs/NEBULA.md §N5): `CAPACITY_TARGETS` (per-tier services, files, caps; prod never writable), comment-preserving values/NodePool surgery, `planCapacity`, `estimateTier`, `applyCapacity` (one gitops PR), `mergeCapacityPr`, `setAtlasTier` over the `AtlasClusters` port; prices in `capacity-prices.ts`
- `live-capacity.ts` — staging/prod live sizing (§N5.2): `LIVE_TARGETS`, `planLive`, `applyLive`
- `prod-atlas.ts` — prod Atlas tier (§N5.3): `PROD_ATLAS` allowlist + step limits, `planProdAtlas`, `setProdAtlasTier` (re-checks `from`)
- `adapters.ts` — the real ports: Octokit (`GithubGitops`, `GithubBuilds`, `GithubPromotions`), `@aws-sdk/client-secrets-manager`, `@aws-sdk/client-ecr`

Tests: `pnpm --filter @twizz-idp/actions test` (vitest, pure pieces + fake ports).
