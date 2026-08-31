import { randomBytes } from "node:crypto";

// Two-step confirmation for write tools, enforced server-side: the first call
// returns a summary + nonce; the second call must echo the nonce for the SAME
// tool + arguments within 5 minutes.
const TTL_MS = 5 * 60_000;

const pending = new Map<string, { fingerprint: string; expires: number }>();

function fingerprint(tool: string, fields: Record<string, string>): string {
  return JSON.stringify([tool, Object.entries(fields).sort()]);
}

export function issueNonce(tool: string, fields: Record<string, string>): string {
  const nonce = randomBytes(8).toString("hex");
  pending.set(nonce, { fingerprint: fingerprint(tool, fields), expires: Date.now() + TTL_MS });
  return nonce;
}

export function consumeNonce(
  nonce: string,
  tool: string,
  fields: Record<string, string>,
): { ok: true } | { ok: false; reason: string } {
  const entry = pending.get(nonce);
  if (!entry) return { ok: false, reason: "unknown or already-used confirm token" };
  pending.delete(nonce);
  if (entry.expires < Date.now()) return { ok: false, reason: "confirm token expired (5 min)" };
  if (entry.fingerprint !== fingerprint(tool, fields)) {
    return { ok: false, reason: "confirm token was issued for different arguments" };
  }
  return { ok: true };
}
