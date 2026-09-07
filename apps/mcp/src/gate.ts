import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { userInfo } from "node:os";
import { createAudit, createGate, loadPolicyFile, MemoryNonceStore } from "@twizz-idp/actions";

export const actor = process.env.TWIZZ_MCP_ACTOR ?? `local:${userInfo().username}`;

const policy = loadPolicyFile(join(dirname(fileURLToPath(import.meta.url)), "..", "policy.yaml"));

// Neon AuditLog row when DATABASE_URL is set, ~/.twizz-mcp-audit.jsonl otherwise.
let prismaPromise: Promise<any> | undefined;
export const audit = createAudit({
  actor: `mcp:${actor}`,
  getAuditLog: async () => {
    if (!process.env.DATABASE_URL) return undefined;
    prismaPromise ??= import("@twizz-idp/db").then((m) => m.prisma);
    return (await prismaPromise).auditLog;
  },
});

/** policy → confirm nonce → action → audit. The stdio server is one
 * long-lived process, so nonces live in memory. */
export const gate = createGate({ policy, nonces: new MemoryNonceStore(), audit });
