import { randomBytes } from "node:crypto";

// Two-step confirmation for write tools, enforced server-side: the first call
// returns a summary + nonce; the second call must echo the nonce for the SAME
// tool + arguments within 5 minutes. A nonce is single-use.
export const NONCE_TTL_MS = 5 * 60_000;

export type ConsumeResult = { ok: true } | { ok: false; reason: string };

export interface NonceStore {
  issue(tool: string, fields: Record<string, string>): Promise<string>;
  consume(nonce: string, tool: string, fields: Record<string, string>): Promise<ConsumeResult>;
}

export function fingerprint(tool: string, fields: Record<string, string>): string {
  return JSON.stringify([tool, Object.entries(fields).sort()]);
}

function newNonce(): string {
  return randomBytes(8).toString("hex");
}

function check(entry: { fingerprint: string; expires: number } | undefined, tool: string, fields: Record<string, string>, now: number): ConsumeResult {
  if (!entry) return { ok: false, reason: "unknown or already-used confirm token" };
  if (entry.expires < now) return { ok: false, reason: "confirm token expired (5 min)" };
  if (entry.fingerprint !== fingerprint(tool, fields)) {
    return { ok: false, reason: "confirm token was issued for different arguments" };
  }
  return { ok: true };
}

/** In-process store — right for the long-lived stdio MCP server. */
export class MemoryNonceStore implements NonceStore {
  private pending = new Map<string, { fingerprint: string; expires: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  async issue(tool: string, fields: Record<string, string>): Promise<string> {
    const nonce = newNonce();
    this.pending.set(nonce, { fingerprint: fingerprint(tool, fields), expires: this.now() + NONCE_TTL_MS });
    return nonce;
  }

  async consume(nonce: string, tool: string, fields: Record<string, string>): Promise<ConsumeResult> {
    const entry = this.pending.get(nonce);
    this.pending.delete(nonce);
    return check(entry, tool, fields, this.now());
  }
}

/** Structural view of the Prisma `ActionNonce` delegate, so callers can pass
 * any generated client without this package depending on it. */
export interface ActionNonceDelegate {
  create(args: { data: { nonce: string; fingerprint: string; expiresAt: Date } }): Promise<unknown>;
  findUnique(args: { where: { nonce: string } }): Promise<{ fingerprint: string; expiresAt: Date } | null>;
  deleteMany(args: { where: { nonce?: string; expiresAt?: { lt: Date } } }): Promise<{ count: number }>;
}

/** Database-backed store — for serverless / multi-replica callers (the Nebula
 * UI) where the issuing and confirming requests may hit different processes. */
export class PrismaNonceStore implements NonceStore {
  constructor(private readonly db: ActionNonceDelegate, private readonly now: () => number = Date.now) {}

  async issue(tool: string, fields: Record<string, string>): Promise<string> {
    const nonce = newNonce();
    await this.db.create({
      data: { nonce, fingerprint: fingerprint(tool, fields), expiresAt: new Date(this.now() + NONCE_TTL_MS) },
    });
    // opportunistic hygiene: drop anything already expired
    await this.db.deleteMany({ where: { expiresAt: { lt: new Date(this.now()) } } }).catch(() => undefined);
    return nonce;
  }

  async consume(nonce: string, tool: string, fields: Record<string, string>): Promise<ConsumeResult> {
    const row = await this.db.findUnique({ where: { nonce } });
    if (row) await this.db.deleteMany({ where: { nonce } }); // single-use, even on mismatch
    return check(row ? { fingerprint: row.fingerprint, expires: row.expiresAt.getTime() } : undefined, tool, fields, this.now());
  }
}
