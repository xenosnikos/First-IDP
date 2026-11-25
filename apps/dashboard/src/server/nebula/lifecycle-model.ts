// Lifecycle (docs/NEBULA.md §N9): the pure half. Merges the latest PLO
// snapshots (plan + source + cve + smoke) into what the /lifecycle tab shows:
// the schedule with next-run times, the tiers, the advisories, the stale-data
// flags and the preview state machine. No Prisma, no GitHub, no kube and no
// node built-ins — every rule here is unit-tested and the file is safe to
// import from a client component. READ ONLY by construction.
//
// The gated writes (routers/actions.ts) decide with the SAME functions the UI
// renders from: `PreviewView.actions.<x>.allowed` is the server-side check.
import {
  LIFECYCLE_BUNDLE_KEY_RE,
  LIFECYCLE_COMPONENT_STATUSES,
  LIFECYCLE_TIERS,
  LifecycleSmokeParams,
  type LifecycleAdvisory,
  type LifecycleBundle,
  type LifecycleComponent,
  type LifecycleComponentStatus,
  type LifecycleJob,
  type LifecyclePrRef,
  type LifecycleScheduleEntry,
  type LifecycleSeverity,
  type LifecycleSmokeScope,
  type LifecycleSnapshotDoc,
  type LifecycleTier,
} from "@twizz-idp/shared";
import type { StatusWord } from "@/lib/nebula/status";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ── cron: 5-field, UTC ────────────────────────────────────────────────────

export class CronError extends Error {}

export type CronSpec = {
  minute: boolean[]; // 0..59
  hour: boolean[]; // 0..23
  dom: boolean[]; // 1..31 (index 0 unused)
  month: boolean[]; // 1..12 (index 0 unused)
  dow: boolean[]; // 0..6, Sunday = 0
  /** the field began with `*` (a plain star or a stepped star) — drives the day rule */
  domStar: boolean;
  dowStar: boolean;
};

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DOW_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function cronNumber(raw: string, min: number, max: number, names: string[] | undefined, nameBase: number, field: string): number {
  const named = names?.indexOf(raw.toLowerCase()) ?? -1;
  if (named >= 0) return named + nameBase;
  if (!/^\d{1,2}$/.test(raw)) throw new CronError(`cron ${field}: "${raw}" is not a number`);
  const n = Number(raw);
  if (n < min || n > max) throw new CronError(`cron ${field}: ${n} is outside ${min}-${max}`);
  return n;
}

/** One field: a comma list of `*`, `a`, `a-b`, each optionally `/step`
 * (`a/step` means `a-max/step`, as in Vixie cron). */
function cronField(expr: string, min: number, max: number, field: string, names?: string[], nameBase = 0): boolean[] {
  const out: boolean[] = Array.from({ length: max + 1 }, () => false);
  for (const part of expr.split(",")) {
    if (!part) throw new CronError(`cron ${field}: empty list item in "${expr}"`);
    const pieces = part.split("/");
    if (pieces.length > 2) throw new CronError(`cron ${field}: "${part}" has more than one step`);
    const [range, stepRaw] = pieces;
    let step = 1;
    if (stepRaw !== undefined) {
      if (!/^\d{1,3}$/.test(stepRaw) || Number(stepRaw) < 1) throw new CronError(`cron ${field}: step "${stepRaw}" must be a positive integer`);
      step = Number(stepRaw);
    }
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = min;
      hi = max;
    } else {
      const ends = range.split("-");
      if (ends.length > 2 || ends.some((e) => e === "")) throw new CronError(`cron ${field}: bad range "${range}"`);
      lo = cronNumber(ends[0], min, max, names, nameBase, field);
      hi = ends.length === 2 ? cronNumber(ends[1], min, max, names, nameBase, field) : stepRaw !== undefined ? max : lo;
      if (hi < lo) throw new CronError(`cron ${field}: range "${range}" runs backwards`);
    }
    for (let v = lo; v <= hi; v += step) out[v] = true;
  }
  return out;
}

/** Parse `minute hour day-of-month month day-of-week`. Lists, ranges and steps
 * are supported in every field; month and weekday names (JAN, MON) too; 7 is
 * Sunday. Macros (`@daily`), seconds and `?`/`L`/`W`/`#` are not. */
export function parseCron(expr: string): CronSpec {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5 || f[0] === "") throw new CronError(`cron "${expr}": expected 5 fields (minute hour day-of-month month day-of-week)`);
  const dow7 = cronField(f[4], 0, 7, "day-of-week", DOW_NAMES);
  const dow = dow7.slice(0, 7);
  if (dow7[7]) dow[0] = true;
  return {
    minute: cronField(f[0], 0, 59, "minute"),
    hour: cronField(f[1], 0, 23, "hour"),
    dom: cronField(f[2], 1, 31, "day-of-month"),
    month: cronField(f[3], 1, 12, "month", MONTH_NAMES, 1),
    dow,
    domStar: f[2].startsWith("*"),
    dowStar: f[4].startsWith("*"),
  };
}

/** The classic day rule: when BOTH day-of-month and day-of-week are restricted
 * the job runs when EITHER matches; when one is `*` only the other decides. */
function cronDayMatches(c: CronSpec, d: Date): boolean {
  const dom = c.dom[d.getUTCDate()];
  const dow = c.dow[d.getUTCDay()];
  return !c.domStar && !c.dowStar ? dom || dow : dom && dow;
}

/** does the cron fire in this exact UTC minute */
export function cronMatches(cron: string | CronSpec, at: Date): boolean {
  const c = typeof cron === "string" ? parseCron(cron) : cron;
  return c.month[at.getUTCMonth() + 1] && cronDayMatches(c, at) && c.hour[at.getUTCHours()] && c.minute[at.getUTCMinutes()];
}

/** The first fire time strictly after `after` (UTC), or null when the
 * expression never fires within nine years (e.g. `0 0 31 2 *`). */
export function cronNext(cron: string | CronSpec, after: Date): Date | null {
  const c = typeof cron === "string" ? parseCron(cron) : cron;
  let t = Math.floor(after.getTime() / MIN) * MIN + MIN;
  const limit = after.getTime() + 9 * 366 * DAY;
  while (t <= limit) {
    const d = new Date(t);
    const y = d.getUTCFullYear();
    const mo = d.getUTCMonth();
    if (!c.month[mo + 1]) {
      t = Date.UTC(y, mo + 1, 1);
      continue;
    }
    if (!cronDayMatches(c, d)) {
      t = Date.UTC(y, mo, d.getUTCDate() + 1);
      continue;
    }
    if (!c.hour[d.getUTCHours()]) {
      t = Date.UTC(y, mo, d.getUTCDate(), d.getUTCHours() + 1);
      continue;
    }
    if (!c.minute[d.getUTCMinutes()]) {
      t += MIN;
      continue;
    }
    return d;
  }
  return null;
}

const DOW_LABEL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pad2 = (n: number) => String(n).padStart(2, "0");
const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th")}`;
const only = (xs: boolean[]): number[] => xs.flatMap((on, i) => (on ? [i] : []));

/** Plain words for the common shapes; anything else is returned unchanged
 * (never a guess). Times are UTC. */
export function describeCron(expr: string): string {
  let c: CronSpec;
  try {
    c = parseCron(expr);
  } catch {
    return expr;
  }
  const f = expr.trim().split(/\s+/);
  const everyMinutes = /^\*\/(\d+)$/.exec(f[0]);
  if (everyMinutes && f.slice(1).every((x) => x === "*")) return Number(everyMinutes[1]) === 1 ? "every minute" : `every ${Number(everyMinutes[1])} minutes`;
  const minutes = only(c.minute);
  const hours = only(c.hour);
  if (minutes.length !== 1 || f[3] !== "*") return expr;
  if (f[1] === "*" && f[2] === "*" && f[4] === "*") return `hourly at :${pad2(minutes[0])}`;
  if (hours.length !== 1) return expr;
  const at = `${pad2(hours[0])}:${pad2(minutes[0])} UTC`;
  const days = only(c.dow).map((d) => DOW_LABEL[d]);
  const doms = only(c.dom).filter((d) => d >= 1);
  if (f[2] === "*" && f[4] === "*") return `daily at ${at}`;
  if (f[2] === "*" && !c.dowStar) return `weekly on ${days.join(", ")} at ${at}`;
  if (f[4] === "*" && !c.domStar) return `monthly on the ${doms.map(ordinal).join(", ")} at ${at}`;
  return expr;
}

// ── inputs ────────────────────────────────────────────────────────────────

/** A `LifecycleSnapshot` row without its payload. */
export type SnapshotMeta = { id: string; job: string; runId: string; ok: boolean; startedAt: Date; finishedAt: Date; createdAt: Date };
/** A `LifecycleSnapshot` row; `data` already validated on ingest. */
export type SnapshotRow = SnapshotMeta & { data: LifecycleSnapshotDoc };

/** A `LifecycleRequest` row (`params` is untrusted JSON until parsed). */
export type RequestRow = {
  id: string;
  kind: string;
  params: unknown;
  requestedBy: string;
  status: string;
  createdAt: Date;
  claimedAt: Date | null;
  finishedAt: Date | null;
  runId: string | null;
  error: string | null;
};

const newestFirst = <T extends { createdAt: Date; id: string }>(a: T, b: T) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** how many smoke snapshots the views look back over */
export const SMOKE_LOOKBACK = 30;

export type SnapshotPick<T extends SnapshotMeta> = {
  /** newest run of the job, failed or not */
  last: T | null;
  /** what the views are built from: the newest run with ok=true, else `last` */
  data: T | null;
};
export type SnapshotSelection<T extends SnapshotMeta> = {
  plan: SnapshotPick<T>;
  source: SnapshotPick<T>;
  /** `previous`: the ok cve run before `data` ("new since last scan") */
  cve: SnapshotPick<T> & { previous: T | null };
  /** newest first */
  smoke: T[];
};

/** Which rows matter, by "newest received" (createdAt). Works on metadata, so
 * the reader can decide which payloads to load before loading any. */
export function selectSnapshots<T extends SnapshotMeta>(rows: readonly T[]): SnapshotSelection<T> {
  const sorted = [...rows].sort(newestFirst);
  const pick = (job: LifecycleJob): SnapshotPick<T> & { previous: T | null } => {
    const mine = sorted.filter((r) => r.job === job);
    const last = mine[0] ?? null;
    const oks = mine.filter((r) => r.ok);
    return { last, data: oks[0] ?? last, previous: oks[1] ?? null };
  };
  const plan = pick("plan");
  const source = pick("source");
  return {
    plan: { last: plan.last, data: plan.data },
    source: { last: source.last, data: source.data },
    cve: pick("cve"),
    smoke: sorted.filter((r) => r.job === "smoke").slice(0, SMOKE_LOOKBACK),
  };
}

/** ids of the snapshots whose payload the views need */
export function neededSnapshotIds(metas: readonly SnapshotMeta[]): string[] {
  const s = selectSnapshots(metas);
  const rows = [s.plan.last, s.plan.data, s.source.last, s.source.data, s.cve.last, s.cve.data, s.cve.previous, ...s.smoke];
  return [...new Set(rows.flatMap((r) => (r ? [r.id] : [])))];
}

// ── staleness ─────────────────────────────────────────────────────────────

/** plan older than 8 days, cve older than 36 h → WATCH */
export const STALE_AFTER_MS = { plan: 8 * DAY, cve: 36 * HOUR } as const;

export type Staleness = { word: Extract<StatusWord, "OK" | "WATCH" | "UNKNOWN">; at: string | null; ageMs: number | null; limitMs: number; detail: string };

/** Age of the DATA shown (the run's own finishedAt), not of the last attempt:
 * a failed run does not make old data fresh. */
export function staleness(job: "plan" | "cve", data: SnapshotMeta | null, now: Date): Staleness {
  const limitMs = STALE_AFTER_MS[job];
  const limit = job === "plan" ? "8 days" : "36 h";
  if (!data) return { word: "UNKNOWN", at: null, ageMs: null, limitMs, detail: `no ${job} snapshot received yet` };
  const ageMs = Math.max(0, now.getTime() - data.finishedAt.getTime());
  const at = data.finishedAt.toISOString();
  if (!data.ok) return { word: "WATCH", at, ageMs, limitMs, detail: `no successful ${job} run yet; showing a failed run's partial data` };
  if (ageMs > limitMs) return { word: "WATCH", at, ageMs, limitMs, detail: `${job} data is older than ${limit}` };
  return { word: "OK", at, ageMs, limitMs, detail: `${job} data is within ${limit}` };
}

// ── schedule ──────────────────────────────────────────────────────────────

/** Section 2 of the design contract. Shown only until the first snapshot
 * arrives (every snapshot carries PLO's own `schedule`, which then wins). */
export const DEFAULT_SCHEDULE: readonly LifecycleScheduleEntry[] = [
  { job: "plan", cron: "0 6 * * 1", runner: "nebula", description: "Plan every stage: what is outdated or end-of-life across infrastructure and source", mutates: false },
  { job: "cve", cron: "30 5 * * *", runner: "nebula", description: "CVE watch over the stack (OSV, Node.js releases, CISA KEV, EPSS)", mutates: false },
  { job: "source", cron: "0 7 2 * *", runner: "nebula", description: "Open the source upgrade pull requests, then build the monthly bundle branch", mutates: true },
  { job: "dispatch", cron: "*/5 * * * *", runner: "nebula", description: "Claim and run the on-demand requests made in Nebula", mutates: false },
  { job: "sweep-staging", cron: "0 7 2 * *", runner: "github-actions", description: "Staging infrastructure sweep (runs in GitHub Actions)", mutates: true },
  { job: "promote-prod", cron: "0 7 * * 2", runner: "github-actions", description: "Production promotion (runs in GitHub Actions)", mutates: true },
];

/** jobs an operator may request on demand (lifecycle_request_run) */
export const REQUESTABLE_JOBS = ["plan", "cve"] as const;
const ACTIVE_STATUSES = ["pending", "claimed"];
export const isActiveRequest = (r: Pick<RequestRow, "status">): boolean => ACTIVE_STATUSES.includes(r.status);

export type RequestView = {
  id: string;
  kind: string;
  status: string;
  requestedBy: string;
  createdAt: string;
  claimedAt: string | null;
  finishedAt: string | null;
  runId: string | null;
  error: string | null;
  /** smoke requests only */
  scope: LifecycleSmokeScope | null;
  bundleKey: string | null;
};

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function requestView(r: RequestRow): RequestView {
  const smoke = r.kind === "smoke" ? LifecycleSmokeParams.safeParse(r.params) : null;
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    requestedBy: r.requestedBy,
    createdAt: r.createdAt.toISOString(),
    claimedAt: iso(r.claimedAt),
    finishedAt: iso(r.finishedAt),
    runId: r.runId,
    error: r.error,
    scope: smoke?.success ? smoke.data.scope : null,
    bundleKey: smoke?.success ? smoke.data.bundleKey : null,
  };
}

export type ScheduleRow = {
  job: string;
  cron: string;
  /** plain words, or the expression itself when it is not a common shape */
  cronText: string;
  runner: "nebula" | "github-actions";
  description: string;
  mutates: boolean;
  /** ISO, UTC; null when the cron is invalid or never fires */
  nextRun: string | null;
  cronError: string | null;
  /** null: never seen by Nebula (GitHub Actions jobs never report here) */
  lastRun: { at: string; ok: boolean; runId: string | null; error: string | null; requested: boolean } | null;
  requestable: boolean;
  /** the pending/claimed on-demand request for this job, if any */
  inFlight: RequestView | null;
};

export type ScheduleView = { source: "snapshot" | "default"; rows: ScheduleRow[] };

export function buildSchedule(sel: SnapshotSelection<SnapshotRow>, requests: readonly RequestRow[], now: Date): ScheduleView {
  const newest = [sel.plan.last, sel.source.last, sel.cve.last, sel.smoke[0] ?? null].filter((r): r is SnapshotRow => !!r && r.data.schedule.length > 0).sort(newestFirst)[0];
  const entries = newest ? newest.data.schedule : DEFAULT_SCHEDULE;
  const byJob: Record<string, SnapshotRow | null> = { plan: sel.plan.last, source: sel.source.last, cve: sel.cve.last };
  const reqs = [...requests].sort(newestFirst);
  const rows = entries.map((e): ScheduleRow => {
    let nextRun: string | null = null;
    let cronError: string | null = null;
    try {
      nextRun = iso(cronNext(e.cron, now));
      if (!nextRun) cronError = "this expression never fires";
    } catch (err) {
      cronError = String((err as Error).message ?? err);
    }
    let lastRun: ScheduleRow["lastRun"] = null;
    const snap = byJob[e.job];
    if (e.runner === "nebula" && snap) {
      lastRun = { at: snap.finishedAt.toISOString(), ok: snap.ok, runId: snap.runId, error: snap.data.error ?? null, requested: !!snap.data.requestId };
    } else if (e.runner === "nebula" && e.job === "dispatch") {
      // dispatch publishes nothing of its own: its trace is the last request it claimed
      const claimed = reqs.filter((r) => r.claimedAt).sort((a, b) => b.claimedAt!.getTime() - a.claimedAt!.getTime())[0];
      if (claimed) lastRun = { at: claimed.claimedAt!.toISOString(), ok: claimed.status !== "failed", runId: claimed.runId, error: claimed.error, requested: true };
    }
    const requestable = e.runner === "nebula" && (REQUESTABLE_JOBS as readonly string[]).includes(e.job);
    const active = requestable ? reqs.find((r) => r.kind === e.job && isActiveRequest(r)) : undefined;
    return { job: e.job, cron: e.cron, cronText: describeCron(e.cron), runner: e.runner, description: e.description, mutates: e.mutates, nextRun, cronError, lastRun, requestable, inFlight: active ? requestView(active) : null };
  });
  return { source: newest ? "snapshot" : "default", rows };
}

// ── tiers ─────────────────────────────────────────────────────────────────

/** dependency order: what must move first is first */
export const TIER_ORDER: readonly LifecycleTier[] = LIFECYCLE_TIERS;
export const TIER_LABEL: Record<LifecycleTier, string> = {
  "control-plane": "Control plane",
  addons: "Add-ons",
  nodes: "Nodes",
  helm: "Helm",
  "base-images": "Base images",
  "npm-direct": "npm direct",
  "npm-transitive": "npm transitive",
};

/** statuses that still need something to happen */
export const ACTIONABLE_STATUSES: readonly LifecycleComponentStatus[] = ["outdated", "pr-open", "awaiting-approval", "escalated", "failed", "blocked"];
export const isActionable = (s: LifecycleComponentStatus): boolean => ACTIONABLE_STATUSES.includes(s);

/** Component status → the closed Nebula status vocabulary (no new words). */
export const COMPONENT_STATUS_WORD: Record<LifecycleComponentStatus, StatusWord> = {
  current: "OK",
  applied: "PASS",
  outdated: "PENDING",
  "pr-open": "RUNNING",
  "awaiting-approval": "AWAITING HUMAN",
  escalated: "WATCH",
  failed: "FAIL",
  blocked: "DENIED",
  unknown: "UNKNOWN",
};

const SEVERITY_RANK: Record<LifecycleSeverity, number> = { critical: 4, high: 3, moderate: 2, low: 1, unknown: 0 };
export const severityRank = (s: LifecycleSeverity): number => SEVERITY_RANK[s];

export type ComponentAdvisories = {
  count: number;
  highest: LifecycleSeverity | null;
  /** how many of them are in CISA KEV */
  kev: number;
  /** advisory ids, worst first (capped) */
  ids: string[];
  /** "cve": joined from the cve snapshot; "plan": PLO's own count, no cve snapshot yet */
  from: "cve" | "plan";
};

export type ComponentRow = LifecycleComponent & { word: StatusWord; actionable: boolean; advisories: ComponentAdvisories; snapshot: "plan" | "source" };

export type TierView = {
  tier: LifecycleTier;
  label: string;
  total: number;
  actionable: number;
  /** distinct advisories affecting this tier */
  advisories: number;
  /** how many of them are in CISA KEV */
  kev: number;
  /** worst severity among them; null: none (or no cve scan yet) */
  highestSeverity: LifecycleSeverity | null;
  counts: Record<LifecycleComponentStatus, number>;
  /** actionable first, then by name; empty when the caller asked for counts only */
  components: ComponentRow[];
};

const MAX_ADVISORY_IDS = 50;

/** The component an advisory row is about. PLO's cve job names a repository's
 * lockfile `…:__lockfile` while its plan/source jobs name the same component
 * after its display name, so an exact id match is tried first and the
 * transitive tier then falls back to (tier, target): there is exactly one
 * lockfile component per repository. Never a guess across tiers or targets. */
export function advisoryComponentId(x: { componentId: string; tier: LifecycleTier; target: string }, components: ReadonlyArray<{ id: string; tier: LifecycleTier; target: string }>): string {
  if (components.some((c) => c.id === x.componentId)) return x.componentId;
  if (x.tier !== "npm-transitive") return x.componentId;
  const same = components.filter((c) => c.tier === "npm-transitive" && c.target === x.target);
  return same.length === 1 ? same[0].id : x.componentId;
}

/** advisory rows → per-component join (`components`: what plan/source reported, for `advisoryComponentId`) */
export function advisoriesByComponent(advisories: readonly LifecycleAdvisory[], components: ReadonlyArray<{ id: string; tier: LifecycleTier; target: string }> = []): Map<string, ComponentAdvisories> {
  const out = new Map<string, ComponentAdvisories>();
  for (const a of [...advisories].sort(compareAdvisories)) {
    for (const id of new Set(a.affected.map((x) => advisoryComponentId(x, components)))) {
      const cur = out.get(id) ?? { count: 0, highest: null, kev: 0, ids: [], from: "cve" as const };
      cur.count += 1;
      if (a.kev) cur.kev += 1;
      if (cur.highest === null || severityRank(a.severity) > severityRank(cur.highest)) cur.highest = a.severity;
      if (cur.ids.length < MAX_ADVISORY_IDS) cur.ids.push(a.id);
      out.set(id, cur);
    }
  }
  return out;
}

/** The tiers a `source` run reports: what lives in the application repositories. A source
 * snapshot is assembled next to the container that runs repository code, so its rows are taken
 * for these tiers ONLY — it can never replace (or add) a control-plane, add-on, node or Helm row,
 * whatever id it names. PLO's publisher enforces the same on its side (src/nebula/rundir.ts). */
export const SOURCE_RUN_TIERS: readonly LifecycleTier[] = ["base-images", "npm-direct", "npm-transitive"];

/** plan + source components by id; when both runs report one, the newer run wins */
export function mergeComponents(plan: SnapshotRow | null, source: SnapshotRow | null): Array<LifecycleComponent & { snapshot: "plan" | "source" }> {
  const out = new Map<string, LifecycleComponent & { snapshot: "plan" | "source" }>();
  const ordered = [
    { row: plan, snapshot: "plan" as const },
    { row: source, snapshot: "source" as const },
  ]
    .filter((x): x is { row: SnapshotRow; snapshot: "plan" | "source" } => !!x.row)
    // older first, so the newer run overwrites
    .sort((a, b) => a.row.finishedAt.getTime() - b.row.finishedAt.getTime());
  for (const { row, snapshot } of ordered) {
    for (const c of row.data.components ?? []) {
      if (snapshot === "source" && !SOURCE_RUN_TIERS.includes(c.tier)) continue;
      // …and a source row never takes the place of an infrastructure row a plan reported under that id
      if (snapshot === "source" && out.has(c.id) && !SOURCE_RUN_TIERS.includes(out.get(c.id)!.tier)) continue;
      out.set(c.id, { ...c, snapshot });
    }
  }
  return [...out.values()];
}

export function buildTiers(sel: SnapshotSelection<SnapshotRow>, opts: { components?: boolean } = {}): TierView[] {
  const cve = sel.cve.data?.data.advisories;
  const merged = mergeComponents(sel.plan.data, sel.source.data);
  const joined = cve ? advisoriesByComponent(cve, merged) : null;
  const rows = merged.map((c): ComponentRow => {
    const advisories: ComponentAdvisories = joined
      ? (joined.get(c.id) ?? { count: 0, highest: null, kev: 0, ids: [], from: "cve" })
      : { count: c.security?.advisories ?? 0, highest: null, kev: 0, ids: [], from: "plan" };
    return { ...c, word: COMPONENT_STATUS_WORD[c.status], actionable: isActionable(c.status), advisories };
  });
  return TIER_ORDER.map((tier): TierView => {
    const mine = rows.filter((c) => c.tier === tier).sort((a, b) => Number(b.actionable) - Number(a.actionable) || a.name.localeCompare(b.name) || a.target.localeCompare(b.target) || a.id.localeCompare(b.id));
    const counts = Object.fromEntries(LIFECYCLE_COMPONENT_STATUSES.map((s) => [s, 0])) as Record<LifecycleComponentStatus, number>;
    for (const c of mine) counts[c.status] += 1;
    const ids = new Set<string>(mine.map((c) => c.id));
    // an advisory counts for the tier it names even when no plan/source component joins to it:
    // a tier must never read "0 advisories" because two jobs spell a component id differently
    const advisories = cve ? cve.filter((a) => a.affected.some((x) => x.tier === tier || ids.has(x.componentId))).length : mine.reduce((n, c) => n + c.advisories.count, 0);
    const kev = cve ? cve.filter((a) => a.kev && a.affected.some((x) => x.tier === tier || ids.has(x.componentId))).length : 0;
    const worst = cve ? cve.filter((a) => a.affected.some((x) => x.tier === tier || ids.has(x.componentId))).reduce<LifecycleSeverity | null>((w, a) => (w === null || severityRank(a.severity) > severityRank(w) ? a.severity : w), null) : null;
    return { tier, label: TIER_LABEL[tier], total: mine.length, actionable: mine.filter((c) => c.actionable).length, advisories, kev, highestSeverity: worst, counts, components: opts.components === false ? [] : mine };
  });
}

// ── advisories ────────────────────────────────────────────────────────────

/** KEV first, then severity, then EPSS, then id (stable) */
export function compareAdvisories(a: LifecycleAdvisory, b: LifecycleAdvisory): number {
  return Number(b.kev) - Number(a.kev) || severityRank(b.severity) - severityRank(a.severity) || (b.epss ?? -1) - (a.epss ?? -1) || a.id.localeCompare(b.id);
}

export type AdvisoryRow = Omit<LifecycleAdvisory, "affected"> & {
  /** not in the previous scan (by id or alias); always false when there is no previous scan */
  isNew: boolean;
  affected: Array<LifecycleAdvisory["affected"][number] & { known: boolean; status: LifecycleComponentStatus | null; pr: LifecyclePrRef | null }>;
};

export type AdvisoriesView = {
  /** the cve run shown */
  scan: { runId: string; finishedAt: string; ok: boolean } | null;
  /** the run "new" is measured against; null: nothing to compare with */
  comparedTo: { runId: string; finishedAt: string } | null;
  stale: Staleness;
  total: number;
  counts: Record<LifecycleSeverity, number>;
  kev: number;
  new: number;
  /** values present, for the filters */
  facets: { tiers: LifecycleTier[]; environments: string[] };
  discoveryErrors: Array<{ domain: string; error: string }>;
  advisories: AdvisoryRow[];
};

const lower = (s: string) => s.toLowerCase();

/** Ids and aliases of a scan, lower-cased: an advisory re-keyed from a GHSA id
 * to its CVE alias between two scans is the same advisory, not a new one. */
function knownIds(advisories: readonly LifecycleAdvisory[]): Set<string> {
  return new Set(advisories.flatMap((a) => [a.id, ...a.aliases]).map(lower));
}

export function buildAdvisories(sel: SnapshotSelection<SnapshotRow>, now: Date): AdvisoriesView {
  const scan = sel.cve.data;
  const list = [...(scan?.data.advisories ?? [])].sort(compareAdvisories);
  const prev = scan?.ok && sel.cve.previous?.data.advisories ? sel.cve.previous : null;
  const before = prev ? knownIds(prev.data.advisories ?? []) : null;
  const merged = mergeComponents(sel.plan.data, sel.source.data);
  const components = new Map(merged.map((c) => [c.id, c]));
  const counts: Record<LifecycleSeverity, number> = { critical: 0, high: 0, moderate: 0, low: 0, unknown: 0 };
  const tiers = new Set<LifecycleTier>();
  const environments = new Set<string>();
  const advisories = list.map((a): AdvisoryRow => {
    counts[a.severity] += 1;
    const isNew = before ? ![a.id, ...a.aliases].some((x) => before.has(lower(x))) : false;
    return {
      ...a,
      isNew,
      affected: a.affected.map((x) => {
        tiers.add(x.tier);
        for (const e of x.environments) environments.add(e);
        const c = components.get(advisoryComponentId(x, merged));
        return { ...x, known: !!c, status: c?.status ?? null, pr: c?.pr ?? null };
      }),
    };
  });
  return {
    scan: scan ? { runId: scan.runId, finishedAt: scan.finishedAt.toISOString(), ok: scan.ok } : null,
    comparedTo: prev ? { runId: prev.runId, finishedAt: prev.finishedAt.toISOString() } : null,
    stale: staleness("cve", scan, now),
    total: advisories.length,
    counts,
    kev: advisories.filter((a) => a.kev).length,
    new: advisories.filter((a) => a.isNew).length,
    facets: { tiers: TIER_ORDER.filter((t) => tiers.has(t)), environments: [...environments].sort() },
    discoveryErrors: scan?.data.discoveryErrors ?? [],
    advisories,
  };
}

// ── overview ──────────────────────────────────────────────────────────────

export type OverviewView = {
  header: {
    /** components with status `outdated` */
    outdated: number;
    /** every status that still needs something to happen */
    actionable: number;
    components: number;
    criticalHigh: number;
    kev: number;
    newAdvisories: number;
    lastPlanAt: string | null;
    lastCveAt: string | null;
  };
  stale: { plan: Staleness; cve: Staleness };
  /** the runs the page is built from; `lastFailed` when a newer run failed and older data is shown */
  runs: Record<"plan" | "source" | "cve", { runId: string; finishedAt: string; ok: boolean; error: string | null; lastFailed: { runId: string; finishedAt: string; error: string | null } | null } | null>;
  schedule: ScheduleView;
  tiers: TierView[];
  /** environment names present, for the filter */
  environments: string[];
  discoveryErrors: Array<{ job: string; domain: string; error: string }>;
  /** newest first */
  requests: RequestView[];
};

function runOf(p: SnapshotPick<SnapshotRow>): OverviewView["runs"]["plan"] {
  if (!p.data) return null;
  const failedNewer = p.last && p.last.id !== p.data.id ? p.last : null;
  return {
    runId: p.data.runId,
    finishedAt: p.data.finishedAt.toISOString(),
    ok: p.data.ok,
    error: p.data.data.error ?? null,
    lastFailed: failedNewer ? { runId: failedNewer.runId, finishedAt: failedNewer.finishedAt.toISOString(), error: failedNewer.data.error ?? null } : null,
  };
}

export function buildOverview(input: { rows: readonly SnapshotRow[]; requests: readonly RequestRow[]; now: Date; components?: boolean }): OverviewView {
  const sel = selectSnapshots(input.rows);
  const full = buildTiers(sel);
  const all = full.flatMap((t) => t.components);
  const adv = buildAdvisories(sel, input.now);
  const environments = new Set<string>();
  for (const c of all) for (const e of c.environments) environments.add(e);
  const errs = (["plan", "source", "cve"] as const).flatMap((job) => (sel[job].data?.data.discoveryErrors ?? []).map((e) => ({ job, ...e })));
  return {
    header: {
      outdated: all.filter((c) => c.status === "outdated").length,
      actionable: all.filter((c) => c.actionable).length,
      components: all.length,
      criticalHigh: adv.counts.critical + adv.counts.high,
      kev: adv.kev,
      newAdvisories: adv.new,
      lastPlanAt: iso(sel.plan.data?.finishedAt ?? null),
      lastCveAt: iso(sel.cve.data?.finishedAt ?? null),
    },
    stale: { plan: staleness("plan", sel.plan.data, input.now), cve: adv.stale },
    runs: { plan: runOf(sel.plan), source: runOf(sel.source), cve: runOf(sel.cve) },
    schedule: buildSchedule(sel, input.requests, input.now),
    tiers: input.components === false ? full.map((t) => ({ ...t, components: [] })) : full,
    environments: [...environments].sort(),
    discoveryErrors: errs,
    requests: [...input.requests].sort(newestFirst).map(requestView),
  };
}

// ── history ───────────────────────────────────────────────────────────────

export type HistoryRow = { id: string; job: string; runId: string; ok: boolean; startedAt: string; finishedAt: string; receivedAt: string; error: string | null; requestId: string | null };

// ── preview state machine ─────────────────────────────────────────────────

export const PREVIEW_STATES = [
  "no-bundle",
  "bundle-ready",
  "preview-requested",
  "preview-up",
  "smoke-preview-pass",
  "smoke-preview-fail",
  "stg-requested",
  "stg-deployed",
  "smoke-stg-pass",
  "smoke-stg-fail",
  "awaiting-signoff",
  "signed-off",
] as const;
export type PreviewState = (typeof PREVIEW_STATES)[number];

/** Gate tool names the state machine reads back from AuditLog / the UI calls. */
export const LIFECYCLE_TOOLS = {
  requestRun: "lifecycle_request_run",
  createPreview: "lifecycle_create_preview",
  requestSmoke: "lifecycle_request_smoke",
  deployStg: "lifecycle_deploy_stg",
  signoff: "lifecycle_signoff",
} as const;
/** `gateFor` prefixes every audited action with this */
export const NEBULA_ACTION_PREFIX = "nebula.";
export const SIGNOFF_AUDIT_ACTION = `${NEBULA_ACTION_PREFIX}${LIFECYCLE_TOOLS.signoff}`;

/** Named envs created for a bundle are `plo-<yymm>-<service>` (≤ 24 chars). */
export const PLO_ENV_PREFIX = "plo-";
const ENV_NAME_MAX = 24;

/** `plo/bundle/2026-11` + `twizz-sentinel` → `plo-2611-twizz-sentinel`.
 * Deterministic, lower-case, `^[a-z][a-z0-9-]{2,23}$`. Throws when the branch
 * is not a bundle branch (never guesses a month). */
export function previewEnvName(bundleBranch: string, service: string): string {
  const m = /^plo\/bundle\/(\d{4})-(\d{2})$/.exec(bundleBranch);
  if (!m) throw new Error(`"${bundleBranch}" is not a bundle branch (plo/bundle/<yyyy-mm>)`);
  const head = `${PLO_ENV_PREFIX}${m[1].slice(2)}${m[2]}-`;
  const short = service
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, ENV_NAME_MAX - head.length)
    .replace(/-+$/g, "");
  if (!short) throw new Error(`service "${service}" has no usable name for a preview env`);
  return `${head}${short}`;
}

/** Is `tag` the central builder's image of a PLO preview env at `headSha`
 * (`nb-plo-…-<sha12>`)? Staging runs the bundle exactly when its tag says so. */
export function isBundleImageTag(tag: string | null | undefined, headSha: string): boolean {
  if (!tag || !/^[0-9a-f]{40}$/.test(headSha)) return false;
  return new RegExp(`^nb-${PLO_ENV_PREFIX}[a-z0-9-]{1,${ENV_NAME_MAX - PLO_ENV_PREFIX.length}}-${headSha.slice(0, 12)}$`).test(tag);
}

/** The ONE image tag of a bundle preview env at a commit: `nb-<envName>-<sha12>`
 * (the central builder's `nebulaTag`). Staging runs the bundle exactly when its
 * tag is this — not merely "some nb-plo-* tag at that commit". */
export function bundleImageTag(envName: string, headSha: string): string {
  return `nb-${envName}-${headSha.slice(0, 12)}`;
}

/** A Nebula registry service a bundled repository may map to. */
export type LifecycleServiceInput = {
  /** registry name, e.g. `twizz-sentinel` */
  service: string;
  /** GitHub `owner/name` (compared case-insensitively with `bundle.github`) */
  repo: string;
  /** on the release train (has a staging target) */
  promotable: boolean;
  /** staging host when promotable, e.g. `sentinel-stg.prv.twizz.com` */
  stagingHost: string | null;
};

/** A named env (deployable or pending) as the state machine needs it. */
export type PreviewEnvInput = {
  name: string;
  service: string;
  owner: string;
  /** `source.repo` / `source.ref` / `source.sha` of the manifest; null for release-image envs */
  sourceRepo: string | null;
  sourceRef: string | null;
  sourceSha: string | null;
  /** present ⇔ deployable */
  imageTag: string | null;
  /** building: in named-envs/pending and not failed; failed: its build failed; ready: deployable */
  build: "building" | "failed" | "ready";
  buildReason: string | null;
  /** Argo verdict of Application `env-<name>` (lib/nebula/status `argoWord`); null when not read */
  argo: StatusWord | null;
  /** Argo reports the env's pods on exactly `imageTag` (`argoRunsImage`); false when it reports
   * another image, no image, or was not read. Synced + Healthy alone is NOT this: right after a
   * manifest changes, Argo still says Synced + Healthy about the image it deployed before. */
  runsImage: boolean;
  /** when Argo finished the sync that put the env where it is now; null: unknown */
  rolledOutAt: string | null;
  /** the Service port the manifest records (`config.port`); null: not recorded. The preview smoke
   * calls the env's Service inside the cluster on this port. */
  port: number | null;
  /** the manifest's owner is a Nebula operator — the only people who can create a bundle preview */
  trusted: boolean;
  expiresAt: string;
  url: string;
};

/** Does an Argo Application (its `status.summary.images`) run `ecrRepo:tag` and
 * nothing else from that repository? `images` undefined/empty → false: an
 * Application that reports no image proves nothing (fail closed). */
export function argoRunsImage(images: readonly string[] | null | undefined, ecrRepo: string, tag: string | null | undefined): boolean {
  if (!images || images.length === 0 || !tag || !ecrRepo) return false;
  let seen = false;
  for (const image of images) {
    const slash = image.lastIndexOf("/");
    const rest = slash < 0 ? image : image.slice(slash + 1);
    const at = rest.indexOf("@");
    const colon = rest.indexOf(":");
    const name = at >= 0 && (colon < 0 || at < colon) ? rest.slice(0, at) : colon >= 0 ? rest.slice(0, colon) : rest;
    if (name !== ecrRepo) continue;
    // pinned by digest, untagged, or another tag of the same repository: not (only) this image
    if (at >= 0 || colon < 0 || rest.slice(colon + 1) !== tag) return false;
    seen = true;
  }
  return seen;
}

/** An OPEN promotion PR on the release train. */
export type PromotionInput = { service: string; imageTag: string; number: number; url: string; headSha: string };

/** What staging is on for one promotable service. */
export type StagingTargetInput = {
  service: string;
  host: string;
  /** `image.tag` in gitops `values-staging.yaml`; null when unset */
  currentTag: string | null;
  /** Argo verdict of `staging-<service>`; null when not read */
  argo: StatusWord | null;
  /** Argo reports staging's pods on exactly `currentTag` (see `argoRunsImage`) */
  runsImage: boolean;
  /** when Argo finished the sync that put staging where it is now; null: unknown */
  rolledOutAt: string | null;
  /** set when this service's staging state could not be read */
  error: string | null;
};

/** A recorded sign-off (one successful `nebula.lifecycle_signoff` AuditLog row). */
export type SignoffInput = { bundleKey: string; actor: string; at: Date };

/** AuditLog row → sign-off, or null. A row counts only when the gate ran the
 * action to completion: `allowed`, a `result` in the detail and no `error`
 * (the gate audits a thrown action as allowed=true with detail.error). The
 * gate field carrying the key MUST be named `bundleKey`. */
export function parseSignoffAudit(row: { action: string; actor: string; allowed: boolean; resource: string | null; detail: unknown; createdAt: Date }): SignoffInput | null {
  if (row.action !== SIGNOFF_AUDIT_ACTION || !row.allowed || !row.resource) return null;
  const detail = row.detail as Record<string, unknown> | null;
  if (!detail || typeof detail !== "object" || Array.isArray(detail) || "error" in detail || !("result" in detail)) return null;
  let fields: unknown;
  try {
    fields = JSON.parse(row.resource);
  } catch {
    return null;
  }
  const key = (fields as { bundleKey?: unknown } | null)?.bundleKey;
  if (typeof key !== "string" || !LIFECYCLE_BUNDLE_KEY_RE.test(key)) return null;
  return { bundleKey: key, actor: row.actor, at: row.createdAt };
}

export type PreviewInput = {
  /** snapshots with payload: at least what `neededSnapshotIds` asks for */
  rows: readonly SnapshotRow[];
  requests: readonly RequestRow[];
  services: readonly LifecycleServiceInput[];
  /** null: the named-env manifests could not be read */
  envs: readonly PreviewEnvInput[] | null;
  /** null: open promotion PRs could not be read */
  promotions: readonly PromotionInput[] | null;
  /** null: staging state could not be read */
  staging: readonly StagingTargetInput[] | null;
  signoffs: readonly SignoffInput[];
  now: Date;
  /** sub-source failures, shown verbatim (`envs: …`, `promotions: …`) */
  sourceErrors?: readonly string[];
};

export type SmokeVerdict = {
  /** none: never requested (or the last request expired unclaimed); running: a request is pending/claimed */
  verdict: "none" | "running" | "pass" | "fail";
  detail: string;
  /** the LATEST smoke request for this scope + bundle — its outcome is the verdict */
  request: RequestView | null;
  runId: string | null;
  finishedAt: string | null;
  results: Array<{ name: string; url: string; ok: boolean; status: number | null; ms: number; detail: string }>;
};

/** The verdict for (scope, bundleKey) is that of the LATEST request for it:
 * re-running suspends an older pass until the new run finishes.
 *
 * Who is trusted for what: the REQUEST row is Nebula's own (an operator made
 * it through the gate; its id, scope, bundle key, targets and times are
 * Nebula's). The RESULT is whatever the holder of the ingest token posted. So
 * a result counts only when it is bound to the request on every side Nebula
 * controls: it names that request (snapshot.requestId), it is the ONE run the
 * request was answered with (request.runId — bound at ingest, while the
 * request was claimed, and never rebindable), it arrived after the request was
 * claimed and not after it was completed, it names the same scope and bundle,
 * every check passed (at least one) and every check is one of the request's
 * own targets. A later snapshot can therefore never change this verdict. */
export function smokeVerdict(scope: LifecycleSmokeScope, bundleKey: string, requests: readonly RequestRow[], smokeRows: readonly SnapshotRow[]): SmokeVerdict {
  const none = { runId: null, finishedAt: null, results: [] };
  const mine = requests
    .filter((r) => {
      if (r.kind !== "smoke") return false;
      const p = LifecycleSmokeParams.safeParse(r.params);
      return p.success && p.data.scope === scope && p.data.bundleKey === bundleKey;
    })
    .sort(newestFirst);
  const req = mine[0];
  if (!req) return { verdict: "none", detail: "not requested yet", request: null, ...none };
  const request = requestView(req);
  if (isActiveRequest(req)) return { verdict: "running", detail: req.status === "pending" ? "waiting for plo-dispatch to claim the request" : "smoke checks running", request, ...none };
  if (req.status === "expired") return { verdict: "none", detail: "the last request expired before plo-dispatch claimed it", request, ...none };
  if (req.status === "failed") return { verdict: "fail", detail: req.error ? `the smoke run failed: ${req.error}` : "the smoke run failed", request, ...none };
  if (req.status !== "done") return { verdict: "none", detail: `request is in an unknown state "${req.status}"`, request, ...none };
  if (!req.runId) return { verdict: "fail", detail: "the request completed but no smoke result was received for it", request, ...none };
  const snap = smokeRows.find((s) => s.job === "smoke" && s.runId === req.runId && s.data.requestId === req.id && !!s.data.smoke);
  if (!snap || !snap.data.smoke) return { verdict: "fail", detail: "the request completed but no smoke result was received for it", request, ...none };
  const smoke = snap.data.smoke;
  const got = { runId: snap.runId, finishedAt: snap.finishedAt.toISOString(), results: smoke.results };
  if (smoke.scope !== scope || smoke.bundleKey !== bundleKey) return { verdict: "fail", detail: "the result received is for a different scope or bundle", request, ...got };
  // received = the server's own clock at ingest (createdAt), never the run's self-reported times
  const received = snap.createdAt.getTime();
  if (!req.claimedAt || received < req.claimedAt.getTime()) return { verdict: "fail", detail: "the result received predates the request it claims to answer", request, ...got };
  if (!req.finishedAt || received > req.finishedAt.getTime()) return { verdict: "fail", detail: "the result was received after the request had been completed", request, ...got };
  const params = LifecycleSmokeParams.safeParse(req.params);
  const targets = params.success ? params.data.targets : [];
  const foreign = smoke.results.filter((r) => !targets.some((t) => r.name.startsWith(`${t.name}/`) && r.url.startsWith(`${t.baseUrl}/`)));
  if (foreign.length && smoke.results.every((r) => r.ok)) return { verdict: "fail", detail: `${foreign.length} of ${smoke.results.length} checks are not checks of the requested targets`, request, ...got };
  if (!snap.ok) return { verdict: "fail", detail: snap.data.error ? `the smoke run failed: ${snap.data.error}` : "the smoke run reported a failure", request, ...got };
  if (smoke.results.length === 0) return { verdict: "fail", detail: "the smoke run checked nothing", request, ...got };
  const failed = smoke.results.filter((r) => !r.ok);
  if (failed.length) return { verdict: "fail", detail: `${failed.length} of ${smoke.results.length} checks failed`, request, ...got };
  return { verdict: "pass", detail: `${smoke.results.length} of ${smoke.results.length} checks passed`, request, ...got };
}

export type Allow = { allowed: true } | { allowed: false; reason: string };
const yes: Allow = { allowed: true };
const no = (reason: string): Allow => ({ allowed: false, reason });

export type BundleView = LifecycleBundle & {
  /** Nebula registry service for `github`; null: no preview route in Nebula */
  service: string | null;
  promotable: boolean;
  /** has a head sha AND a registry service */
  previewable: boolean;
  /** why it is not previewable / what is in the way (plain words) */
  note: string | null;
  /** name the preview env gets (`plo-<yymm>-<service>`); null when not previewable */
  envName: string | null;
  /** THE preview env of this bundle: named `envName`, built by an operator from exactly this
   * repository, bundle branch and head sha — never merely "some plo-* env on that commit" */
  env: (PreviewEnvInput & { up: boolean }) | null;
  /** promotable services only */
  staging: { host: string; currentTag: string | null; argo: StatusWord | null; runsImage: boolean; rolledOutAt: string | null; deployed: boolean; promotion: PromotionInput | null; error: string | null } | null;
};

export type PreviewStepKey = "bundle-ready" | "preview-requested" | "preview-up" | "smoke-preview" | "stg-requested" | "stg-deployed" | "smoke-stg" | "awaiting-signoff" | "signed-off";
export type PreviewStep = { key: PreviewStepKey; label: string; status: "done" | "current" | "failed" | "todo" | "skipped" };

export type PreviewView = {
  state: PreviewState;
  /** plain words for the state */
  detail: string;
  bundleKey: string | null;
  /** first 12 chars, for display */
  key12: string | null;
  /** the source run the bundle came from */
  sourceRun: { runId: string; finishedAt: string; ok: boolean } | null;
  bundles: BundleView[];
  smoke: { preview: SmokeVerdict; stg: SmokeVerdict };
  signoff: { by: string; at: string } | null;
  steps: PreviewStep[];
  /** what an operator may do now — the gated writes enforce exactly these */
  actions: { createPreview: Allow; smokePreview: Allow; deployStg: Allow; smokeStg: Allow; signoff: Allow };
  /** things that hold the flow back or could not be read (never hidden) */
  blockers: string[];
};

const STEP_LABEL: Record<PreviewStepKey, string> = {
  "bundle-ready": "Bundle ready",
  "preview-requested": "Preview requested",
  "preview-up": "Preview up",
  "smoke-preview": "Preview smoke",
  "stg-requested": "Staging requested",
  "stg-deployed": "Staging deployed",
  "smoke-stg": "Staging smoke",
  "awaiting-signoff": "Awaiting sign-off",
  "signed-off": "Signed off",
};
const STEP_ORDER = Object.keys(STEP_LABEL) as PreviewStepKey[];
const STATE_STEP: Record<Exclude<PreviewState, "no-bundle">, PreviewStepKey> = {
  "bundle-ready": "bundle-ready",
  "preview-requested": "preview-requested",
  "preview-up": "preview-up",
  "smoke-preview-pass": "smoke-preview",
  "smoke-preview-fail": "smoke-preview",
  "stg-requested": "stg-requested",
  "stg-deployed": "stg-deployed",
  "smoke-stg-pass": "smoke-stg",
  "smoke-stg-fail": "smoke-stg",
  "awaiting-signoff": "awaiting-signoff",
  "signed-off": "signed-off",
};
const STG_STEPS: PreviewStepKey[] = ["stg-requested", "stg-deployed", "smoke-stg"];

function stepsFor(state: PreviewState, hasStagingRoute: boolean): PreviewStep[] {
  const at = state === "no-bundle" ? -1 : STEP_ORDER.indexOf(STATE_STEP[state]);
  const failed = state === "smoke-preview-fail" || state === "smoke-stg-fail";
  return STEP_ORDER.map((key, i): PreviewStep => {
    if (!hasStagingRoute && STG_STEPS.includes(key)) return { key, label: STEP_LABEL[key], status: "skipped" };
    // signed-off is the end of the line: nothing is "current" after it
    const status = i < at || (i === at && state === "signed-off") ? "done" : i === at ? (failed ? "failed" : "current") : "todo";
    return { key, label: STEP_LABEL[key], status };
  });
}

const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const SHA_RE = /^[0-9a-f]{40}$/;

/** The registry service a bundle maps to and whether Nebula can preview it. */
export function bundleTargets(bundles: readonly LifecycleBundle[], services: readonly LifecycleServiceInput[]): Array<{ bundle: LifecycleBundle; service: LifecycleServiceInput | null; previewable: boolean; envName: string | null; note: string | null }> {
  return bundles.map((bundle) => {
    const service = services.find((s) => sameRepo(s.repo, bundle.github)) ?? null;
    if (!bundle.headSha) return { bundle, service, previewable: false, envName: null, note: "nothing could be bundled for this repository" };
    if (!SHA_RE.test(bundle.headSha)) return { bundle, service, previewable: false, envName: null, note: "the bundle head is not a full commit sha" };
    if (!service) return { bundle, service, previewable: false, envName: null, note: "not a Nebula registry service: no preview route in Nebula" };
    try {
      return { bundle, service, previewable: true, envName: previewEnvName(bundle.branch, service.service), note: null };
    } catch (e) {
      return { bundle, service, previewable: false, envName: null, note: String((e as Error).message ?? e) };
    }
  });
}

/** The preview state machine, as a pure function of what is recorded:
 *
 *   no-bundle → bundle-ready → preview-requested → preview-up
 *     → smoke-preview-pass|fail → stg-requested → stg-deployed
 *     → smoke-stg-pass|fail → awaiting-signoff → signed-off
 *
 * Everything is keyed by the current `bundleKey` (a hash of every bundled
 * repo's head sha): a new bundle starts again from bundle-ready, and no
 * evidence carries over. The furthest state the EVIDENCE supports wins, so a
 * preview env that has since expired does not undo a recorded smoke pass.
 * Anything that could not be read is treated as "not there" (fail closed) and
 * listed in `blockers`. `smoke-stg-pass` is reported as `awaiting-signoff` —
 * a passed staging smoke is exactly what makes the sign-off available. */
export function buildPreview(input: PreviewInput): PreviewView {
  const sel = selectSnapshots(input.rows);
  const src = sel.source.data;
  const key = src?.data.bundleKey ?? null;
  const blockers: string[] = [...(input.sourceErrors ?? [])];
  const emptySmoke: SmokeVerdict = { verdict: "none", detail: "not requested yet", request: null, runId: null, finishedAt: null, results: [] };
  const sourceRun = src ? { runId: src.runId, finishedAt: src.finishedAt.toISOString(), ok: src.ok } : null;
  const nowMs = input.now.getTime();

  const targets = bundleTargets(src?.data.bundles ?? [], input.services);
  const notMine: string[] = [];
  const bundles = targets.map((t): BundleView => {
    const { bundle, service } = t;
    // The bundle's preview env is ONE env, by its exact deterministic name. Whatever else carries
    // that name — built from another commit or branch, for another service, or created by someone
    // who is not an operator — is not adopted: it is named as a blocker and the flow stops there.
    let env: PreviewEnvInput | null = null;
    for (const e of (input.envs ?? []).filter((x) => t.previewable && !!t.envName && x.name === t.envName && !(Date.parse(x.expiresAt) <= nowMs))) {
      const why = !e.sourceRepo || !sameRepo(e.sourceRepo, bundle.github)
        ? "it is not built from this repository"
        : e.sourceSha !== bundle.headSha
          ? `it is built from ${(e.sourceSha ?? "another commit").slice(0, 7)}, not from the bundle head ${bundle.headSha!.slice(0, 7)}`
          : e.sourceRef !== bundle.branch
            ? `it is built from branch ${e.sourceRef ?? "?"}, not from ${bundle.branch}`
            : e.service !== service?.service
              ? `it runs service ${e.service}, not ${service?.service}`
              : !e.trusted
                ? `it was created by ${e.owner}, who is not a Nebula operator`
                : null;
      if (why) notMine.push(`${e.name} exists but is not this bundle's preview (${why}) — tear it down on /environments, then create the preview`);
      else env = e;
    }
    const expectedTag = t.envName && bundle.headSha ? bundleImageTag(t.envName, bundle.headSha) : null;
    const promotable = !!service?.promotable && t.previewable;
    let staging: BundleView["staging"] = null;
    if (promotable && service && bundle.headSha) {
      const st = input.staging?.find((s) => s.service === service.service) ?? null;
      const promotion = (input.promotions ?? []).find((p) => p.service === service.service && p.imageTag === expectedTag) ?? null;
      const error = input.staging === null ? "staging state could not be read" : !st ? "no staging target reported for this service" : st.error;
      staging = {
        host: st?.host ?? service.stagingHost ?? "",
        currentTag: st?.currentTag ?? null,
        argo: st?.argo ?? null,
        runsImage: !!st?.runsImage,
        rolledOutAt: st?.rolledOutAt ?? null,
        // gitops says staging is on THIS bundle's image, Argo is Synced + Healthy, AND Argo reports
        // the pods on that very image. The last part is what makes it true: for the minutes between
        // a promotion merge and Argo's next poll, Synced + Healthy still describes the previous image.
        deployed: !error && !!expectedTag && st?.currentTag === expectedTag && st?.argo === "PASS" && st.runsImage === true,
        promotion,
        error,
      };
    }
    return {
      ...bundle,
      service: service?.service ?? null,
      promotable,
      previewable: t.previewable,
      note: t.note,
      envName: t.envName,
      env: env ? { ...env, up: env.build === "ready" && !!env.imageTag && env.imageTag === expectedTag && env.argo === "PASS" && env.runsImage === true } : null,
      staging,
    };
  });

  const done = (state: PreviewState, detail: string, smoke: PreviewView["smoke"], signoff: PreviewView["signoff"], actions: PreviewView["actions"], hasStagingRoute: boolean): PreviewView => ({
    state,
    detail,
    bundleKey: key,
    key12: key ? key.slice(0, 12) : null,
    sourceRun,
    bundles,
    smoke,
    signoff,
    steps: stepsFor(state, hasStagingRoute),
    actions,
    blockers,
  });

  const bundled = bundles.filter((b) => !!b.headSha);
  // a failed source run may carry a partial bundle: it is shown, and nothing can be done with it
  const failedRun = !!src && !src.ok;
  if (failedRun) blockers.push(`the source run ${src!.runId} FAILED${src!.data.error ? ` (${src!.data.error})` : ""} and no successful one is on record — its bundle is partial and cannot be previewed, deployed or signed off; wait for the next source run`);
  else if (sel.source.last && src && sel.source.last.id !== src.id && !sel.source.last.ok) blockers.push(`the newest source run ${sel.source.last.runId} failed${sel.source.last.data.error ? ` (${sel.source.last.data.error})` : ""}; showing the bundle of the last successful run ${src.runId}`);
  if (!src || !key || bundled.length === 0 || failedRun) {
    const why = !src ? "no source run has reported yet" : failedRun ? "the last source run failed, so there is no bundle to act on" : !key ? "the last source run produced no bundle" : "the last source run bundled nothing";
    const refuse = no(`there is no bundle: ${why}`);
    return done("no-bundle", why, { preview: emptySmoke, stg: emptySmoke }, null, { createPreview: refuse, smokePreview: refuse, deployStg: refuse, smokeStg: refuse, signoff: refuse }, true);
  }

  const expected = bundles.filter((b) => b.previewable);
  const promotable = expected.filter((b) => b.promotable);
  const hasStagingRoute = promotable.length > 0;
  const smoke = { preview: smokeVerdict("preview", key, input.requests, sel.smoke), stg: smokeVerdict("stg", key, input.requests, sel.smoke) };

  const conflicts = bundles.reduce((n, b) => n + b.conflicts.length, 0);
  if (conflicts) blockers.push(`${conflicts} pull request${conflicts === 1 ? "" : "s"} could not be merged into the bundle (conflicts)`);
  for (const b of bundles) if (!b.previewable && b.note && b.headSha) blockers.push(`${b.github}: ${b.note}`);
  blockers.push(...notMine);
  if (expected.length === 0) blockers.push("no bundled repository maps to a Nebula service, so there is nothing to preview or sign off here");

  const withEnv = expected.filter((b) => b.env);
  const missing = expected.filter((b) => !b.env);
  const failedBuilds = expected.filter((b) => b.env?.build === "failed");
  const previewUp = expected.length > 0 && expected.every((b) => b.env?.up);
  for (const b of failedBuilds) blockers.push(`${b.env!.name}: build failed${b.env!.buildReason ? ` (${b.env!.buildReason})` : ""}`);
  for (const b of expected) {
    if (!b.env || b.env.build !== "ready" || b.env.up) continue;
    if (b.env.argo !== "PASS") blockers.push(`${b.env.name}: Argo reports ${b.env.argo ?? "nothing"} — not confirmed up`);
    else blockers.push(`${b.env.name}: Argo is Synced + Healthy but does not report the pods on ${b.env.imageTag ?? "the bundle image"} yet — not confirmed up`);
  }

  const stgDeployed = hasStagingRoute && promotable.every((b) => b.staging?.deployed);
  const onBundleTag = (b: BundleView) => !!b.staging && !!b.envName && b.staging.currentTag === bundleImageTag(b.envName, b.headSha!);
  const stgStarted = promotable.some((b) => b.staging && (b.staging.deployed || !!b.staging.promotion || onBundleTag(b)));
  for (const b of promotable) {
    if (b.staging?.error) blockers.push(`${b.service} staging: ${b.staging.error}`);
    else if (b.staging && !b.staging.deployed && onBundleTag(b))
      blockers.push(
        b.staging.argo === "PASS"
          ? `${b.service} staging: gitops is on the bundle image but Argo does not report the pods on it yet (it has not rolled out)`
          : `${b.service} staging: gitops is on the bundle image but Argo reports ${b.staging.argo ?? "nothing"}`,
      );
  }

  const signed = [...input.signoffs].filter((s) => s.bundleKey === key).sort((a, b) => a.at.getTime() - b.at.getTime())[0];
  const signoff = signed ? { by: signed.actor, at: signed.at.toISOString() } : null;

  // A pass is evidence about what runs NOW only when it was requested after that last rolled out.
  // Unknown rollout time = not evidence (fail closed). A preview env that has since expired keeps
  // its recorded pass: the request was made by Nebula for exactly this bundle key.
  const requestedAt = (v: SmokeVerdict) => (v.request ? Date.parse(v.request.createdAt) : NaN);
  const after = (v: SmokeVerdict, rolledOutAt: string | null) => {
    const r = rolledOutAt ? Date.parse(rolledOutAt) : NaN;
    return Number.isFinite(r) && Number.isFinite(requestedAt(v)) && requestedAt(v) > r;
  };
  const previewStale = smoke.preview.verdict === "pass" ? expected.filter((b) => b.env && !after(smoke.preview, b.env.rolledOutAt)) : [];
  const stgStale = smoke.stg.verdict === "pass" ? promotable.filter((b) => !after(smoke.stg, b.staging?.rolledOutAt ?? null)) : [];
  const stale = (label: string, env: string, at: string | null) => (at ? `${env} rolled out at ${at}, after the ${label} smoke was requested — run the ${label} smoke again` : `Argo does not say when ${env} rolled out, so the ${label} smoke cannot be tied to what runs now — run the ${label} smoke again`);
  const previewStaleWhy = previewStale.length ? stale("preview", previewStale[0].env!.name, previewStale[0].env!.rolledOutAt) : null;
  const stgStaleWhy = stgStale.length ? stale("staging", `${stgStale[0].service} staging`, stgStale[0].staging?.rolledOutAt ?? null) : null;
  if (previewStaleWhy) blockers.push(previewStaleWhy);
  if (stgStaleWhy && stgDeployed) blockers.push(stgStaleWhy);

  const previewPass = smoke.preview.verdict === "pass" && !previewStaleWhy;
  const stgPass = smoke.stg.verdict === "pass" && !stgStaleWhy;
  // EVERY bundled service must have passed its preview smoke: the staging smoke only ever
  // calls the release-train services, so it can never stand in for the others.
  const signoffReady = expected.length > 0 && previewPass && (hasStagingRoute ? stgDeployed && stgPass : true);

  let state: PreviewState;
  let detail: string;
  if (signoff) {
    state = "signed-off";
    detail = `signed off by ${signoff.by}`;
  } else if (signoffReady) {
    state = "awaiting-signoff";
    detail = hasStagingRoute ? "the staging smoke passed — waiting for an operator to sign off" : "the preview smoke passed and nothing here has a staging route in Nebula — waiting for an operator to sign off";
  } else if (hasStagingRoute && stgDeployed && stgPass && !previewPass) {
    state = "smoke-preview-fail";
    detail = `the staging smoke passed, but the preview smoke for this bundle has not (${previewStaleWhy ?? smoke.preview.detail}) — every bundled service must pass its preview smoke before the sign-off`;
  } else if (stgDeployed && smoke.stg.verdict === "fail") {
    state = "smoke-stg-fail";
    detail = smoke.stg.detail;
  } else if (stgDeployed) {
    state = "stg-deployed";
    detail = smoke.stg.verdict === "running" ? smoke.stg.detail : (stgStaleWhy ?? "staging runs the bundle — run the staging smoke");
  } else if (stgStarted) {
    state = "stg-requested";
    detail = "the staging promotion is open or rolling out";
  } else if (previewPass) {
    state = "smoke-preview-pass";
    detail = smoke.preview.detail;
  } else if (smoke.preview.verdict === "fail") {
    state = "smoke-preview-fail";
    detail = smoke.preview.detail;
  } else if (previewUp) {
    state = "preview-up";
    detail = smoke.preview.verdict === "running" ? smoke.preview.detail : (previewStaleWhy ?? "every preview env is up — run the preview smoke");
  } else if (withEnv.length > 0) {
    state = "preview-requested";
    detail = `${withEnv.filter((b) => b.env!.up).length} of ${expected.length} preview envs up`;
  } else {
    state = "bundle-ready";
    detail = expected.length ? "the bundle is built — create the preview" : "the bundle is built, but nothing in it can be previewed in Nebula";
  }

  const closed = signoff ? no("this bundle is already signed off") : null;
  const envsUnknown = input.envs === null ? no("the named-env manifests could not be read") : null;
  const nothing = expected.length === 0 ? no("no bundled repository maps to a Nebula service") : null;
  const noTagFor = promotable.filter((b) => !b.staging?.deployed && !b.staging?.promotion && !(b.env?.build === "ready" && b.env.imageTag));
  const toPromote = promotable.filter((b) => !b.staging?.deployed && !b.staging?.promotion);
  const actions: PreviewView["actions"] = {
    createPreview: closed ?? envsUnknown ?? nothing ?? (missing.length === 0 ? no("every bundled service already has a preview env for this bundle") : yes),
    smokePreview: closed ?? envsUnknown ?? nothing ?? (!previewUp ? no("the preview envs are not all up yet") : smoke.preview.verdict === "running" ? no("a preview smoke run is already in flight") : yes),
    deployStg:
      closed ??
      (!hasStagingRoute
        ? no("no bundled service is on the release train: no staging route in Nebula (deploys via the repo's own pipeline on merge)")
        : !previewPass
          ? no(previewStaleWhy ?? "the latest preview smoke for this bundle has not passed")
          : input.staging === null || input.promotions === null
            ? no("staging state could not be read")
            : toPromote.length === 0
              ? no("every promotable service is already promoted or deployed for this bundle")
              : noTagFor.length
                ? no(`no built preview image for ${noTagFor.map((b) => b.service).join(", ")} (the preview env is gone or not built)`)
                : yes),
    smokeStg: closed ?? (!hasStagingRoute ? no("no bundled service has a staging route in Nebula") : !stgDeployed ? no("staging is not running this bundle yet") : smoke.stg.verdict === "running" ? no("a staging smoke run is already in flight") : yes),
    signoff:
      closed ??
      nothing ??
      (signoffReady
        ? yes
        : hasStagingRoute && !stgDeployed
          ? no("staging is not running this bundle")
          : hasStagingRoute && !stgPass
            ? no(stgStaleWhy ?? "the latest staging smoke for this bundle has not passed")
            : no(previewStaleWhy ?? "the latest preview smoke for this bundle has not passed")),
  };
  return done(state, detail, smoke, signoff, actions, hasStagingRoute);
}
