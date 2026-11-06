import { createHash } from "node:crypto";

/** Length + short sha256 of a search term: correlatable across audit rows, never the term
 *  (a term may BE a leaked secret someone is hunting for). */
export function searchFingerprint(term: string): string {
  return `(${term.length} chars, sha256:${createHash("sha256").update(term).digest("hex").slice(0, 12)})`;
}
