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
- `adapters.ts` — the real ports: Octokit, `@aws-sdk/client-secrets-manager`, `@aws-sdk/client-ecr`

Tests: `pnpm --filter @twizz-idp/actions test` (vitest, pure pieces + fake ports).
