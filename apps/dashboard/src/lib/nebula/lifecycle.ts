// Lifecycle tab (docs/NEBULA.md §N9): the pure, client-safe half of the UI.
// Everything the /lifecycle panes decide — which word a state carries, how a
// time reads, what a filter keeps, what the ONE next action is — lives here so
// it can be unit-tested (the dashboard has no component test harness).
//
// Types come from the router (inferRouterOutputs); nothing here re-declares a
// server DTO, and every import from the server side is type-only.
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@/server/routers/_app";
import { fmtDuration, type StatusWord } from "./status";

type Out = inferRouterOutputs<AppRouter>["lifecycle"];
type OkOf<T> = T extends { ok: infer U } ? U : never;

export type LifecycleOverview = OkOf<Out["overview"]["data"]>;
export type BundleSummary = OkOf<Out["overview"]["bundle"]>;
export type LifecycleAdvisories = OkOf<Out["advisories"]["data"]>;
export type LifecyclePreview = OkOf<Out["preview"]["data"]>;
export type LifecycleHistory = OkOf<Out["history"]["data"]>;

export type TierView = LifecycleOverview["tiers"][number];
export type ComponentRow = TierView["components"][number];
export type ScheduleRow = LifecycleOverview["schedule"]["rows"][number];
export type RequestView = LifecycleOverview["requests"][number];
export type Staleness = LifecycleOverview["stale"]["plan"];
export type AdvisoryRow = LifecycleAdvisories["advisories"][number];
export type BundleView = LifecyclePreview["bundles"][number];
export type SmokeVerdict = LifecyclePreview["smoke"]["preview"];
export type PreviewStep = LifecyclePreview["steps"][number];
export type PreviewState = LifecyclePreview["state"];
export type HistoryRow = LifecycleHistory["snapshots"][number];

export type ComponentStatus = ComponentRow["status"];
export type Severity = AdvisoryRow["severity"];
export type Tier = TierView["tier"];

export const LIFECYCLE_TABS = ["schedule", "tiers", "advisories", "preview", "history"] as const;
export type LifecycleTab = (typeof LIFECYCLE_TABS)[number];
export const TAB_LABEL: Record<LifecycleTab, string> = { schedule: "Schedule", tiers: "Tiers", advisories: "Advisories", preview: "Preview", history: "History" };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ── time ──────────────────────────────────────────────────────────────────

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (n: number) => String(n).padStart(2, "0");

/** "3h 12m ago" / "in 4d 2h" / "just now". Empty for a missing or bad date. */
export function relTime(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const ms = t - nowMs;
  if (Math.abs(ms) < MIN) return ms > 0 ? "in under a minute" : "just now";
  return ms > 0 ? `in ${fmtDuration(ms)}` : `${fmtDuration(-ms)} ago`;
}

/** "Mon 30 Nov 06:00 UTC" — always UTC, never the browser's zone or locale. */
export function fmtUtc(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
}

/** "2026-11-25 05:30 UTC" — for logs and history, where the year matters. */
export function fmtUtcStamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
}

/** How long a run took: "42s", "3m 05s", "1h 4m". */
export function fmtTook(startIso: string, endIso: string): string {
  const ms = Date.parse(endIso) - Date.parse(startIso);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad2(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// ── cron ──────────────────────────────────────────────────────────────────

/** The schedule's cron cell. The server puts plain words in `cronText`
 * (lifecycle-model `describeCron`) and falls back to the expression itself
 * when the shape is unusual; this decides what is the headline and whether the
 * raw expression still needs showing next to it. */
export function cronLabel(row: Pick<ScheduleRow, "cron" | "cronText" | "cronError">): { text: string; raw: string | null; error: string | null } {
  if (row.cronError) return { text: row.cron, raw: null, error: row.cronError };
  const human = row.cronText && row.cronText !== row.cron;
  return { text: human ? row.cronText : row.cron, raw: human ? row.cron : null, error: null };
}

// ── words ─────────────────────────────────────────────────────────────────

/** What PLO calls a component's status, in plain words (shown next to the pill). */
export const STATUS_TEXT: Record<ComponentStatus, string> = {
  current: "up to date",
  outdated: "outdated",
  "pr-open": "upgrade PR open",
  "awaiting-approval": "awaiting approval",
  escalated: "escalated to a human",
  applied: "applied",
  failed: "upgrade failed",
  blocked: "blocked",
  unknown: "unknown",
};

/** most urgent first — the order of a tier's summary line and of the status filter */
export const STATUS_URGENCY: readonly ComponentStatus[] = ["failed", "blocked", "escalated", "awaiting-approval", "outdated", "pr-open", "applied", "current", "unknown"];

export const SEVERITY_WORD: Record<Severity, StatusWord> = { critical: "CRITICAL", high: "HIGH", moderate: "MODERATE", low: "LOW", unknown: "UNKNOWN" };
const SEVERITY_RANK: Record<Severity, number> = { critical: 4, high: 3, moderate: 2, low: 1, unknown: 0 };
export const SEVERITIES: readonly Severity[] = ["critical", "high", "moderate", "low", "unknown"];

export const AUTONOMY_TEXT: Record<ComponentRow["autonomy"], string> = {
  auto: "applied automatically by PLO",
  pr: "PLO opens a pull request; a human merges it",
  approval: "needs a human approval before PLO applies it",
  escalate: "escalated: PLO will not apply this, a human decides",
  ignore: "ignored by policy",
};

export const ROLLBACK_TEXT: Record<ComponentRow["rollback"], string> = {
  supported: "supported",
  limited: "limited (not every part can be reverted)",
  none: "none (cannot be rolled back)",
};

/** An on-demand request's status → word. */
export function requestWord(status: string): StatusWord {
  switch (status) {
    case "pending":
      return "PENDING";
    case "claimed":
      return "RUNNING";
    case "done":
      return "PASS";
    case "failed":
      return "FAIL";
    case "expired":
      return "EXPIRED";
    default:
      return "UNKNOWN";
  }
}

/** What an on-demand request's status means for the person who asked. */
export function requestText(r: Pick<RequestView, "status" | "requestedBy" | "createdAt" | "error">, nowMs: number): string {
  // a request is never in the future: the server clock can be a moment ahead of the page's tick
  const who = `requested by ${r.requestedBy} ${relTime(r.createdAt, Math.max(nowMs, Date.parse(r.createdAt) || nowMs))}`;
  switch (r.status) {
    case "pending":
      return `${who} · waiting for plo-dispatch (runs every 5 minutes)`;
    case "claimed":
      return `${who} · running`;
    case "done":
      return `${who} · finished`;
    case "failed":
      return `${who} · failed${r.error ? `: ${r.error}` : ""}`;
    case "expired":
      return `${who} · expired: plo-dispatch never claimed it`;
    default:
      return `${who} · ${r.status}`;
  }
}

/** A stepper step → word (null: no pill, the step does not apply). */
export function stepWord(status: PreviewStep["status"]): StatusWord | null {
  switch (status) {
    case "done":
      return "PASS";
    case "current":
      return "RUNNING";
    case "failed":
      return "FAIL";
    case "todo":
      return "PLANNED";
    case "skipped":
      return null;
  }
}

/** The step the flow is at reads differently when it waits for a person. */
export function currentStepWord(step: PreviewStep, state: PreviewState): StatusWord | null {
  if (step.status === "current" && state === "awaiting-signoff") return "AWAITING HUMAN";
  // these states ARE the step's achievement (the bundle is ready, the preview is up…): reached, not in progress
  if (step.status === "current" && (state === "bundle-ready" || state === "preview-up" || state === "stg-deployed" || state === "smoke-preview-pass")) return "PASS";
  return stepWord(step.status);
}

export const PREVIEW_STATE_LABEL: Record<PreviewState, string> = {
  "no-bundle": "no bundle",
  "bundle-ready": "bundle ready",
  "preview-requested": "preview building",
  "preview-up": "preview up",
  "smoke-preview-pass": "preview smoke passed",
  "smoke-preview-fail": "preview smoke failed",
  "stg-requested": "staging requested",
  "stg-deployed": "on staging",
  "smoke-stg-pass": "staging smoke passed",
  "smoke-stg-fail": "staging smoke failed",
  "awaiting-signoff": "awaiting sign-off",
  "signed-off": "signed off",
};

export function previewStateWord(state: PreviewState): StatusWord {
  switch (state) {
    case "no-bundle":
      return "PLANNED";
    case "bundle-ready":
    case "preview-up":
      return "PENDING";
    case "preview-requested":
    case "stg-requested":
      return "RUNNING";
    case "stg-deployed":
      return "DEPLOYED";
    case "smoke-preview-pass":
    case "smoke-stg-pass":
    case "signed-off":
      return "PASS";
    case "smoke-preview-fail":
    case "smoke-stg-fail":
      return "FAIL";
    case "awaiting-signoff":
      return "AWAITING HUMAN";
  }
}

export function verdictWord(verdict: SmokeVerdict["verdict"]): StatusWord {
  return verdict === "pass" ? "PASS" : verdict === "fail" ? "FAIL" : verdict === "running" ? "RUNNING" : "PLANNED";
}

/** A preview env's build → word. */
export function envBuildWord(build: NonNullable<BundleView["env"]>["build"]): StatusWord {
  return build === "ready" ? "PASS" : build === "failed" ? "FAIL" : "RUNNING";
}

/** Stale flag of a pane's data → what to say about it (null: nothing to say). */
export function staleNote(job: "plan" | "cve", s: Staleness, nowMs: number): string | null {
  if (s.word === "OK") return null;
  if (s.word === "UNKNOWN") return null; // "no snapshot yet" is the empty state's job
  const what = job === "plan" ? "Plan" : "CVE";
  return `${what} data may be out of date: ${s.detail}${s.at ? ` (finished ${relTime(s.at, nowMs)})` : ""}. Request a new run on the Schedule tab.`;
}

// ── versions, risk ────────────────────────────────────────────────────────

/** `current → desired (latest x)`: what the row's version cell says. */
export function versionChange(c: Pick<ComponentRow, "current" | "desired" | "latest">): { from: string; to: string | null; latest: string | null } {
  const to = c.desired && c.desired !== c.current ? c.desired : null;
  const latest = c.latest && c.latest !== c.current && c.latest !== c.desired ? c.latest : null;
  return { from: c.current, to, latest };
}

/** EPSS probability (0..1) → "12.3%"; under 0.1% reads "<0.1%". */
export function epssPct(epss: number | undefined): string {
  if (epss === undefined || Number.isNaN(epss)) return "—";
  const pct = epss * 100;
  if (pct > 0 && pct < 0.1) return "<0.1%";
  return `${pct >= 10 ? pct.toFixed(0) : pct.toFixed(1)}%`;
}

/** The word a component's advisories carry: KEV beats any severity. */
export function advisoryWord(a: { kev: number | boolean; highest?: Severity | null; severity?: Severity }): StatusWord {
  if (a.kev) return "KEV";
  const sev = a.severity ?? a.highest ?? null;
  return sev ? SEVERITY_WORD[sev] : "UNKNOWN";
}

function riskRank(c: ComponentRow): number {
  return (c.advisories.kev > 0 ? 100 : 0) + (c.advisories.count > 0 ? 10 + (c.advisories.highest ? SEVERITY_RANK[c.advisories.highest] : 0) : 0) + (c.eol?.eol ? 5 : 0);
}

export type EolNote = { word: StatusWord | null; text: string };

/** End-of-life: past → EXPIRED, within 90 days → EXPIRING, else a plain date. */
export function eolNote(eol: ComponentRow["eol"], nowMs: number): EolNote | null {
  if (!eol) return null;
  const t = eol.date ? Date.parse(eol.date) : NaN;
  const date = eol.date && !Number.isNaN(t) ? eol.date.slice(0, 10) : null;
  if (eol.eol) return { word: "EXPIRED", text: date ? `end of life since ${date}` : "end of life" };
  if (date === null) return { word: null, text: "supported (no end-of-life date known)" };
  if (t <= nowMs) return { word: "EXPIRED", text: `end of life since ${date}` };
  if (t - nowMs < 90 * DAY) return { word: "EXPIRING", text: `end of life on ${date} (in ${plural(Math.ceil((t - nowMs) / DAY), "day")})` };
  return { word: null, text: `supported until ${date}` };
}

// ── tiers: filter, sort, summarise ────────────────────────────────────────

export type ComponentFilter = { environment: string | null; status: ComponentStatus | null; actionableOnly: boolean; text: string };
export const DEFAULT_COMPONENT_FILTER: ComponentFilter = { environment: null, status: null, actionableOnly: true, text: "" };

/** A row is kept by "only actionable" when its status still needs something
 * to happen OR it carries an advisory (a current-but-vulnerable component
 * must never be hidden by the default view). */
export function needsAttention(c: Pick<ComponentRow, "actionable" | "advisories" | "eol">): boolean {
  return c.actionable || c.advisories.count > 0 || !!c.eol?.eol;
}

export function filterComponents(rows: readonly ComponentRow[], f: ComponentFilter): ComponentRow[] {
  const text = f.text.trim().toLowerCase();
  return rows.filter(
    (c) =>
      (!f.environment || c.environments.includes(f.environment)) &&
      (!f.status || c.status === f.status) &&
      (!f.actionableOnly || needsAttention(c)) &&
      (!text || c.name.toLowerCase().includes(text) || c.target.toLowerCase().includes(text) || c.id.toLowerCase().includes(text)),
  );
}

/** Riskiest first: known-exploited, then advisory severity, then end-of-life,
 * then the server's order (actionable first, by name) — the sort is stable. */
export function sortByRisk(rows: readonly ComponentRow[]): ComponentRow[] {
  return rows.map((c, i) => ({ c, i, r: riskRank(c) })).sort((a, b) => b.r - a.r || a.i - b.i).map((x) => x.c);
}

/** "34 components · 3 outdated · 1 upgrade PR open · 30 up to date" — most urgent first, zeros dropped. */
export function tierSummary(t: Pick<TierView, "total" | "counts" | "advisories">): string {
  if (t.total === 0) return "nothing reported for this tier";
  const parts = STATUS_URGENCY.filter((s) => t.counts[s] > 0).map((s) => `${t.counts[s]} ${STATUS_TEXT[s]}`);
  return [plural(t.total, "component"), ...parts, ...(t.advisories > 0 ? [plural(t.advisories, "advisory", "advisories")] : [])].join(" · ");
}

/** The word a whole tier carries in its plate header. */
export function tierWord(t: Pick<TierView, "total" | "actionable" | "counts">): StatusWord {
  if (t.total === 0) return "UNKNOWN";
  if (t.counts.failed > 0) return "FAIL";
  if (t.counts.blocked > 0) return "DENIED";
  if (t.counts["awaiting-approval"] > 0) return "AWAITING HUMAN";
  if (t.counts.escalated > 0) return "WATCH";
  if (t.counts.outdated > 0) return "PENDING";
  if (t.counts["pr-open"] > 0) return "RUNNING";
  return "OK";
}

// ── advisories: filter ────────────────────────────────────────────────────

export type AdvisoryFilter = { severity: Severity | null; tier: Tier | null; environment: string | null; kevOnly: boolean; newOnly: boolean; text: string };
export const DEFAULT_ADVISORY_FILTER: AdvisoryFilter = { severity: null, tier: null, environment: null, kevOnly: false, newOnly: false, text: "" };

/** Tier and environment must hold for the SAME affected component: "npm
 * direct on prod" must not match an advisory that is npm-direct on staging
 * and base-image on prod. Text matches the id, an alias or a package name. */
export function filterAdvisories(rows: readonly AdvisoryRow[], f: AdvisoryFilter): AdvisoryRow[] {
  const text = f.text.trim().toLowerCase();
  return rows.filter((a) => {
    if (f.severity && a.severity !== f.severity) return false;
    if (f.kevOnly && !a.kev) return false;
    if (f.newOnly && !a.isNew) return false;
    if ((f.tier || f.environment) && !a.affected.some((x) => (!f.tier || x.tier === f.tier) && (!f.environment || x.environments.includes(f.environment)))) return false;
    if (text && ![a.id, ...a.aliases, ...a.affected.map((x) => x.name)].some((s) => s.toLowerCase().includes(text))) return false;
    return true;
  });
}

/** every advisory that names this component, in the server's order (KEV first) */
export function advisoriesForComponent(rows: readonly AdvisoryRow[], componentId: string): AdvisoryRow[] {
  return rows.filter((a) => a.affected.some((x) => x.componentId === componentId));
}

/** distinct environments an advisory touches, sorted */
export function advisoryEnvironments(a: Pick<AdvisoryRow, "affected">): string[] {
  return [...new Set(a.affected.flatMap((x) => x.environments))].sort();
}

/** Is this the name of a production environment? Only used for emphasis. */
export function isProdEnv(name: string): boolean {
  return /^prod(uction)?$/i.test(name) || /(^|[-_ ])prod(uction)?($|[-_ ])/i.test(name);
}

// ── the header: tiles, empty state, the one next action ───────────────────

/** Has PLO ever reported anything? */
export function hasAnySnapshot(o: Pick<LifecycleOverview, "runs">): boolean {
  return !!(o.runs.plan || o.runs.source || o.runs.cve);
}

export type EmptyLine = { job: string; fills: string; nextRun: string | null; cronText: string };

/** Before the first snapshot: which job fills which pane, and when it runs next. */
export function emptyStateLines(o: Pick<LifecycleOverview, "runs" | "schedule">): EmptyLine[] {
  const fills: Array<{ job: "plan" | "cve" | "source"; fills: string }> = [
    { job: "plan", fills: "Tiers: every component, what is outdated or end-of-life" },
    { job: "cve", fills: "Advisories: known vulnerabilities in what runs, known-exploited first" },
    { job: "source", fills: "Preview: the monthly bundle of upgrade pull requests" },
  ];
  return fills
    .filter((f) => !o.runs[f.job])
    .map((f) => {
      const row = o.schedule.rows.find((r) => r.job === f.job);
      return { job: f.job, fills: f.fills, nextRun: row?.nextRun ?? null, cronText: row ? cronLabel(row).text : "not scheduled" };
    });
}

export type HeaderTile = { key: string; label: string; word: StatusWord; value: string; detail: string; tab: LifecycleTab };

export function headerTiles(o: LifecycleOverview, bundle: { state: PreviewState; detail: string; key12: string | null } | { error: string } | null, nowMs: number): HeaderTile[] {
  const h = o.header;
  const noPlan = !o.runs.plan && !o.runs.source;
  const noCve = !o.runs.cve;
  // the same count the Tiers pane's default filter keeps (an up-to-date but vulnerable component counts)
  const attention = o.tiers.reduce((n, t) => n + t.components.filter(needsAttention).length, 0);
  const tiles: HeaderTile[] = [
    {
      key: "outdated",
      label: "outdated",
      word: noPlan ? "UNKNOWN" : h.outdated > 0 ? "PENDING" : "OK",
      value: noPlan ? "—" : String(h.outdated),
      detail: noPlan ? "no plan snapshot yet" : `of ${plural(h.components, "component")} · ${attention} need${attention === 1 ? "s" : ""} attention`,
      tab: "tiers",
    },
    {
      key: "critical-high",
      label: "critical / high",
      // the header counts critical + high together (the split is on the pane), so the word is "act now", not one severity
      word: noCve ? "UNKNOWN" : h.criticalHigh > 0 ? "HOT" : "OK",
      value: noCve ? "—" : String(h.criticalHigh),
      detail: noCve ? "no CVE scan yet" : `advisories · ${h.newAdvisories > 0 ? `${h.newAdvisories} new since the previous scan` : "none new since the previous scan"}`,
      tab: "advisories",
    },
    {
      key: "kev",
      label: "known exploited",
      word: noCve ? "UNKNOWN" : h.kev > 0 ? "KEV" : "OK",
      value: noCve ? "—" : String(h.kev),
      detail: noCve ? "no CVE scan yet" : h.kev > 0 ? "in CISA's catalogue of vulnerabilities exploited in the wild" : "nothing here is in CISA's exploited catalogue",
      tab: "advisories",
    },
    bundle === null
      ? { key: "bundle", label: "bundle", word: "PENDING", value: "…", detail: "reading the bundle state", tab: "preview" }
      : "error" in bundle
        ? { key: "bundle", label: "bundle", word: "UNKNOWN", value: "unreadable", detail: bundle.error, tab: "preview" }
        : { key: "bundle", label: bundle.key12 ? `bundle ${bundle.key12}` : "bundle", word: previewStateWord(bundle.state), value: PREVIEW_STATE_LABEL[bundle.state], detail: bundle.detail, tab: "preview" },
    {
      key: "plan-age",
      label: "last plan",
      word: o.stale.plan.word,
      value: h.lastPlanAt ? relTime(h.lastPlanAt, nowMs) : "never",
      detail: o.stale.plan.detail,
      tab: "schedule",
    },
    {
      key: "cve-age",
      label: "last CVE scan",
      word: o.stale.cve.word,
      value: h.lastCveAt ? relTime(h.lastCveAt, nowMs) : "never",
      detail: o.stale.cve.detail,
      tab: "schedule",
    },
  ];
  return tiles;
}

export type NextAction = {
  word: StatusWord;
  /** imperative, one line */
  title: string;
  detail: string;
  /** where on this page it is done */
  tab: LifecycleTab | null;
  /** set when it is done on another Nebula page or outside Nebula */
  href: string | null;
  /** an operator has to do it (a reader can only watch) */
  operatorOnly: boolean;
};

const act = (word: StatusWord, title: string, detail: string, tab: LifecycleTab | null, extra: Partial<Pick<NextAction, "href" | "operatorOnly">> = {}): NextAction => ({ word, title, detail, tab, href: extra.href ?? null, operatorOnly: extra.operatorOnly ?? false });

/** The ONE thing to do next, from what the server says is allowed
 * (`preview.actions` are the same checks the gated writes enforce). The
 * bundle's pipeline comes first — it is how a vulnerable dependency actually
 * gets fixed; with no bundle in flight the riskiest open finding leads. */
export function nextAction(input: { overview: LifecycleOverview; preview: LifecyclePreview | null; previewError?: string | null }): NextAction {
  const { overview: o, preview: p } = input;
  if (!hasAnySnapshot(o)) {
    const first = o.schedule.rows.filter((r) => r.runner === "nebula" && r.nextRun && ["plan", "cve", "source"].includes(r.job)).sort((a, b) => Date.parse(a.nextRun!) - Date.parse(b.nextRun!))[0];
    return act("PLANNED", "Wait for the first PLO run", first ? `nothing has reported yet; the ${first.job} job runs next, ${fmtUtc(first.nextRun)}. An operator can request a plan or CVE run now.` : "nothing has reported yet and no scheduled run is known", "schedule");
  }
  if (p && p.state !== "no-bundle") {
    const key = p.key12 ?? "";
    const a = p.actions;
    if (p.state === "signed-off") return act("PASS", "Merge the bundled pull requests in GitHub", `bundle ${key} is ${p.detail}. Nebula never merges application pull requests — that stays a human action in GitHub.`, "preview");
    if (a.signoff.allowed) return act("AWAITING HUMAN", `Sign off bundle ${key}`, p.detail, "preview", { operatorOnly: true });
    if (p.smoke.stg.verdict === "running") return act("RUNNING", "Wait for the staging smoke", p.smoke.stg.detail, "preview");
    if (a.smokeStg.allowed) {
      return p.state === "smoke-stg-fail"
        ? act("FAIL", "Staging smoke failed: look at the failing checks, then run it again", p.smoke.stg.detail, "preview", { operatorOnly: true })
        : act("PENDING", "Run the staging smoke", p.detail, "preview", { operatorOnly: true });
    }
    // a service still without a promotion comes before merging the ones already open (same order as the pane's buttons)
    if (a.deployStg.allowed) return act("PENDING", `Deploy bundle ${key} to staging`, `${p.smoke.preview.detail} in the preview smoke; this opens the staging promotion pull request(s)`, "preview", { operatorOnly: true });
    if (p.state === "stg-requested") return act("AWAITING HUMAN", "Merge the staging promotion on the release train", "the promotion pull request is open or rolling out; merging it is the existing gate on /releases", "preview", { href: "/releases", operatorOnly: true });
    if (p.smoke.preview.verdict === "running") return act("RUNNING", "Wait for the preview smoke", p.smoke.preview.detail, "preview");
    if (a.smokePreview.allowed) {
      return p.state === "smoke-preview-fail"
        ? act("FAIL", "Preview smoke failed: look at the failing checks, then run it again", p.smoke.preview.detail, "preview", { operatorOnly: true })
        : act("PENDING", "Run the preview smoke", p.detail, "preview", { operatorOnly: true });
    }
    if (a.createPreview.allowed) return act("PENDING", `Create the preview for bundle ${key}`, p.detail, "preview", { operatorOnly: true });
    if (p.state === "preview-requested") return act("RUNNING", "Wait for the preview envs to come up", p.detail, "preview");
    return act("WATCH", "The bundle is held back", p.blockers[0] ?? p.detail, "preview");
  }
  if (!p && input.previewError) return act("UNKNOWN", "The bundle state could not be read", input.previewError, "preview");
  const h = o.header;
  if (h.kev > 0) return act("KEV", `Review ${plural(h.kev, "known-exploited advisory", "known-exploited advisories")}`, "these are being exploited in the wild (CISA KEV); check which environments run the affected versions and whether an upgrade pull request is open", "advisories");
  if (h.criticalHigh > 0) return act("HOT", `Review ${plural(h.criticalHigh, "critical or high advisory", "critical or high advisories")}`, "see which components and environments are affected and what version fixes each", "advisories");
  if (o.stale.plan.word === "WATCH" || o.stale.cve.word === "WATCH") {
    const which = o.stale.plan.word === "WATCH" ? o.stale.plan.detail : o.stale.cve.detail;
    return act("WATCH", "Refresh stale data", `${which}; request a new run on the Schedule tab`, "schedule", { operatorOnly: true });
  }
  if (h.actionable > 0) {
    const src = o.schedule.rows.find((r) => r.job === "source");
    return act("PENDING", `${plural(h.actionable, "component")} need${h.actionable === 1 ? "s" : ""} attention`, src?.nextRun ? `the next source run (${fmtUtc(src.nextRun)}) opens the upgrade pull requests and bundles them for a preview` : "see what is outdated per tier", "tiers");
  }
  return act("OK", "Nothing to do", "everything reported is up to date and no advisory is open", null);
}

// ── small formatters ──────────────────────────────────────────────────────

export const shortSha = (sha: string | null | undefined, n = 7): string => (sha ? sha.slice(0, n) : "—");

/** `nb-plo-2611-twizz-sentinel-0123456789ab` → shorter, still recognisable */
export function shortTag(tag: string | null | undefined): string {
  if (!tag) return "(no tag)";
  return tag.length > 36 ? `${tag.slice(0, 34)}…` : tag;
}

export { plural };
