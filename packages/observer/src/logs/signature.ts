// Turn a log line into a stable template so repeats group together: ids,
// numbers, timestamps and addresses become placeholders; paths keep their
// file name but lose line:column. Order matters — earlier masks stop later
// ones from matching inside what they replaced.

const ISO_TS = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;
const US_TS = /\d{1,2}\/\d{1,2}\/\d{4},?\s+\d{1,2}:\d{2}:\d{2}(?:\s*[AP]M)?/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const OBJECT_ID = /\b[0-9a-f]{24}\b/gi;
const HEX = /\b[0-9a-f]{8,}\b/gi;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const IP = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
const LONG_QUOTED = /(["'`])([^"'`]{32,})\1/g;
const FILE_LINE = /(\S+\.(?:[cm]?[jt]sx?|py|go|rb|java|kt|rs))(?::\d+){1,2}\b/g;
const NUMBER = /(?<![A-Za-z_:])\d+(?:\.\d+)?(?![A-Za-z_])/g;

export function templatePath(s: string): string {
  return s
    .replace(ISO_TS, ":ts")
    .replace(US_TS, ":ts")
    .replace(UUID, ":uuid")
    .replace(OBJECT_ID, ":id")
    .replace(EMAIL, ":email")
    .replace(IP, ":ip")
    .replace(LONG_QUOTED, "$1:str$1")
    .replace(FILE_LINE, "$1")
    .replace(HEX, ":hex")
    .replace(NUMBER, ":n")
    .replace(/\s+/g, " ")
    .trim();
}

/** Signature of a record = template of the first 200 chars of its head line. */
export function signatureOf(body: string): string {
  return templatePath(body.slice(0, 200)).slice(0, 200);
}

/** FNV-1a 32-bit, hex. Browser-safe (no node:crypto). */
export function signatureHash(sig: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < sig.length; i++) {
    h ^= sig.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Shorten a pod name to its deployment + the pod suffix, for display. */
export function podShort(pod: string): string {
  const m = pod.match(/^(.*)-[a-z0-9]{5,10}-([a-z0-9]{5})$/);
  if (m) return `${m[1]}-…${m[2]}`;
  return pod;
}

/** Deployment / owner name a pod belongs to (best effort by name shape). */
export function deploymentOf(pod: string): string {
  return pod.replace(/-[a-z0-9]{5,10}-[a-z0-9]{5}$/, "").replace(/-[a-z0-9]{5}$/, "").replace(/-\d+$/, "");
}
