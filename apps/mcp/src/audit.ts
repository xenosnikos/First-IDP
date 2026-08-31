import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, userInfo } from "node:os";

export const actor = process.env.TWIZZ_MCP_ACTOR ?? `local:${userInfo().username}`;

const fallbackPath = join(homedir(), ".twizz-mcp-audit.jsonl");

let prismaPromise: Promise<any> | undefined;
function getPrisma(): Promise<any> | undefined {
  if (!process.env.DATABASE_URL) return undefined;
  prismaPromise ??= import("@twizz-idp/db").then((m) => m.prisma);
  return prismaPromise;
}

/** Append-only audit trail: Neon AuditLog row when DATABASE_URL is set,
 * ~/.twizz-mcp-audit.jsonl otherwise. Every write-tool call lands here,
 * including denials. Never throws. */
export async function audit(entry: {
  action: string;
  resource?: string;
  allowed: boolean;
  detail?: Record<string, unknown>;
}): Promise<void> {
  const row = { actor: `mcp:${actor}`, createdAt: new Date().toISOString(), ...entry };
  try {
    const prisma = await getPrisma();
    if (prisma) {
      await prisma.auditLog.create({
        data: {
          actor: row.actor,
          action: entry.action,
          resource: entry.resource,
          allowed: entry.allowed,
          detail: entry.detail as any,
        },
      });
      return;
    }
  } catch {
    // fall through to file
  }
  try {
    appendFileSync(fallbackPath, JSON.stringify(row) + "\n");
  } catch {
    console.error("[audit] could not persist audit entry", row);
  }
}
