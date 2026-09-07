// Status honesty (docs/NEBULA.md §2): a colour never appears without its word.
// This is the ONLY vocabulary a coloured pill may carry, and every word here
// maps to exactly one token. Pure, client-safe, unit-tested.

export const STATUS_WORDS = [
  "SHIPPED",
  "STUB",
  "PLANNED",
  "PASS",
  "FAIL",
  "RUNNING",
  "PENDING",
  "AWAITING HUMAN",
  "UNKNOWN",
  "EXPIRED",
  "EXPIRING",
  "READ-ONLY",
  "DENIED",
] as const;

export type StatusWord = (typeof STATUS_WORDS)[number];

export type Tone = "ion" | "pass" | "fail" | "pending" | "ember" | "muted";

/** Word → tone. Ember is reserved for the human gate (AWAITING HUMAN). */
export function toneOf(word: StatusWord): Tone {
  switch (word) {
    case "SHIPPED":
      return "ion";
    case "PASS":
      return "pass";
    case "FAIL":
    case "EXPIRED":
    case "DENIED":
      return "fail";
    case "RUNNING":
    case "PENDING":
    case "EXPIRING":
      return "pending";
    case "AWAITING HUMAN":
      return "ember";
    case "STUB":
    case "PLANNED":
    case "UNKNOWN":
    case "READ-ONLY":
      return "muted";
  }
}

// ── Argo CD Application → word ────────────────────────────────────────

export type ArgoStatus = {
  /** null when no Application object exists for the env (yet) */
  sync: string | null;
  health: string | null;
  /** true when the cluster could not be queried at all */
  unreachable?: boolean;
};

export type ArgoVerdict = { word: StatusWord; detail: string };

/** The card's `argo` row. Honest mapping (spec §B):
 *   Healthy (and Synced)            → PASS
 *   Progressing / still syncing     → RUNNING
 *   Degraded / Missing              → FAIL
 *   cluster unreachable             → UNKNOWN (never faked)
 *   manifest exists, no Application → PENDING (Argo has not rendered it yet) */
export function argoWord(s: ArgoStatus): ArgoVerdict {
  if (s.unreachable) return { word: "UNKNOWN", detail: "cluster unreachable" };
  if (s.sync === null && s.health === null) return { word: "PENDING", detail: "no Application yet" };
  const health = s.health ?? "Unknown";
  const sync = s.sync ?? "Unknown";
  const detail = `${sync} · ${health}`;
  if (health === "Degraded" || health === "Missing") return { word: "FAIL", detail };
  if (health === "Progressing") return { word: "RUNNING", detail };
  if (health === "Healthy") {
    if (sync === "Synced") return { word: "PASS", detail };
    // Healthy but a sync is in flight (new image / re-clone landing)
    return { word: "RUNNING", detail };
  }
  return { word: "UNKNOWN", detail };
}

// ── TTL → word ────────────────────────────────────────────────────────

export type TtlVerdict = { word: StatusWord | null; remaining: string };

const HOUR = 3_600_000;

/** `expires` row: a countdown value, plus EXPIRED (past) or EXPIRING (<24h).
 * Otherwise no pill — a plain value is fine; the rule is colour never without
 * a word, not word for every value. */
export function ttlWord(expiresAt: string, now: Date = new Date()): TtlVerdict {
  const exp = Date.parse(expiresAt);
  if (Number.isNaN(exp)) return { word: "UNKNOWN", remaining: "invalid expiresAt" };
  const ms = exp - now.getTime();
  if (ms <= 0) return { word: "EXPIRED", remaining: `${fmtDuration(-ms)} ago` };
  return { word: ms < 24 * HOUR ? "EXPIRING" : null, remaining: `in ${fmtDuration(ms)}` };
}

export function fmtDuration(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
