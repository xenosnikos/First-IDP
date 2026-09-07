import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { Octokit } from "@octokit/rest";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { ECRClient } from "@aws-sdk/client-ecr";
import {
  EcrRegistry,
  GithubGitops,
  PrismaNonceStore,
  SecretsManagerStore,
  createAudit,
  createGate,
  loadPolicyFile,
  type AuditLogDelegate,
  type Gate,
  type Policy,
} from "@twizz-idp/actions";
import type { Prisma, PrismaClient } from "@twizz-idp/db";

// Wiring for the Nebula write path. Every write in this app goes through
// @twizz-idp/actions' gate: policy → Prisma-persisted confirm nonce → action →
// AuditLog row. This is the one deliberate exception to "no dashboard writes"
// (see apps/dashboard/CLAUDE.md).

export const region = process.env.AWS_REGION ?? "eu-west-1";

/** The same policy.yaml the MCP server enforces. NEBULA_POLICY_PATH overrides;
 * otherwise ../mcp/policy.yaml relative to the app dir (dev AND the standalone
 * image — next.config traces it in), with the app-local copy as a fallback. */
export function policyPath(): string {
  if (process.env.NEBULA_POLICY_PATH) return process.env.NEBULA_POLICY_PATH;
  const candidates = [resolve(process.cwd(), "../mcp/policy.yaml"), resolve(process.cwd(), "policy.yaml")];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

let policyCache: Policy | undefined;
export function policy(): Policy {
  policyCache ??= loadPolicyFile(policyPath());
  return policyCache;
}

export function octokit(): Octokit {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is not configured on the Nebula server (SM preview/github)");
  return new Octokit({ auth: token });
}

/** Named-env ports. AWS uses the default credential chain — IRSA in-cluster,
 * AWS_PROFILE locally. No static keys in the app. */
export function namedEnvDeps() {
  return {
    gitops: new GithubGitops(octokit()),
    secrets: new SecretsManagerStore(new SecretsManagerClient({ region })),
    images: new EcrRegistry(new ECRClient({ region })),
    maxNamedEnvs: Number(process.env.NEBULA_MAX_NAMED_ENVS) || undefined,
  };
}

/** Prisma's generated `auditLog.create` is stricter about `detail` (Json
 * input) than the structural `AuditLogDelegate` in @twizz-idp/actions
 * (`detail?: unknown`), so bridge it here rather than widen the library. */
function auditLogDelegate(prisma: PrismaClient): AuditLogDelegate {
  return {
    create: ({ data }) =>
      prisma.auditLog.create({
        data: { ...data, detail: (data.detail ?? undefined) as Prisma.InputJsonValue | undefined },
      }),
  };
}

/** A gate bound to the acting GitHub login. Nonces live in Prisma
 * (`ActionNonce`) so issue and confirm may hit different replicas. */
export function gateFor(prisma: PrismaClient, actor: string): Gate {
  return createGate({
    policy: policy(),
    nonces: new PrismaNonceStore(prisma.actionNonce),
    audit: createAudit({ actor, getAuditLog: async () => auditLogDelegate(prisma) }),
    actionPrefix: "nebula.",
  });
}
