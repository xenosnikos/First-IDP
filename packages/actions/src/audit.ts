import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type AuditEntry = {
  action: string;
  resource?: string;
  allowed: boolean;
  detail?: Record<string, unknown>;
};

export type AuditFn = (entry: AuditEntry) => Promise<void>;

/** Structural view of the Prisma `AuditLog` delegate. */
export interface AuditLogDelegate {
  create(args: {
    data: { actor: string; action: string; resource?: string; allowed: boolean; detail?: unknown };
  }): Promise<unknown>;
}

export type AuditOptions = {
  /** e.g. "mcp:local:nick" or a GitHub login. Stored verbatim on every row. */
  actor: string;
  /** Lazily resolve a Prisma AuditLog delegate; return undefined to use the file fallback. */
  getAuditLog?: () => Promise<AuditLogDelegate | undefined>;
  fallbackPath?: string;
};

/** Append-only audit trail: an AuditLog row when a Prisma delegate is
 * available, a JSONL file otherwise. Every gated action lands here, including
 * denials. Never throws. */
export function createAudit(opts: AuditOptions): AuditFn {
  const fallbackPath = opts.fallbackPath ?? join(homedir(), ".twizz-mcp-audit.jsonl");
  return async (entry) => {
    const row = { actor: opts.actor, createdAt: new Date().toISOString(), ...entry };
    try {
      const auditLog = await opts.getAuditLog?.();
      if (auditLog) {
        await auditLog.create({
          data: {
            actor: row.actor,
            action: entry.action,
            resource: entry.resource,
            allowed: entry.allowed,
            detail: entry.detail,
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
  };
}
