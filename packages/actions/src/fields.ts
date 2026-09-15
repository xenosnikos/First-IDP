// Gate `fields` helpers. The confirm nonce is fingerprinted to (tool, fields),
// so anything that changes the effect of an action must be IN fields — but
// fields are also the audit `resource` and the policy input, so big or
// sensitive things go in as a HASH: file bytes, env overrides. Secret VALUES
// never go in at all; their sorted NAMES do.
import { createHash } from "node:crypto";

export type FileInput = { path: string; content: string };

/** sha256 over a canonical, order-independent encoding of the files:
 * `<path>\0<content>\0` sorted by path. Byte-sensitive: any edit changes it. */
export function hashFiles(files: readonly FileInput[]): string {
  const h = createHash("sha256");
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) h.update(f.path).update("\0").update(f.content).update("\0");
  return h.digest("hex");
}

/** sha256 over sorted `K=V` pairs. For env overrides (non-secret by schema)
 * and for binding a set_env_vars edit to its values without auditing them. */
export function hashVars(vars: Record<string, string>): string {
  const h = createHash("sha256");
  for (const k of Object.keys(vars).sort()) h.update(k).update("=").update(vars[k]).update("\0");
  return h.digest("hex");
}

/** Sorted, deduplicated, space-joined names — the audit-safe shape of a
 * secret set (names only) or an env-var name list. */
export function nameList(names: readonly string[]): string {
  return [...new Set(names)].sort().join(" ");
}
