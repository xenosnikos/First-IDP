// Lifecycle tab (docs/NEBULA.md §N9): the pure, client-safe half of the UI.
// Everything the /lifecycle panes decide — which word a state carries, how a
// time reads, what a filter keeps, what the ONE next action is — lives here so
// it can be unit-tested (the dashboard has no component test harness).
//
// Types come from the router (inferRouterOutputs); nothing here re-declares a
// server DTO, and every import from the server side is type-only.
import type { inferRouterOutputs } from "@trpc/server";
import { lifecycleSafeLink } from "@twizz-idp/shared";
import type { AppRouter } from "@/server/routers/_app";
import { fmtDuration, type StatusWord } from "./status";

type Out = inferRouterOutputs<AppRouter>["lifecycle"];
type OkOf<T> = T extends { ok: infer U } ? U : never;

export type LifecycleOverview = OkOf<Out["overview"]["data"]>;
export type BundleSummary = OkOf<Out["overview"]["bundle"]>;
export type LifecycleEnvironments = OkOf<Out["overview"]["environments"]>;
export type EnvironmentView = LifecycleEnvironments["environments"][number];
export type EnvTierView = EnvironmentView["tiers"][number];
export type EnvChangeSet = EnvironmentView["changeSets"][number];
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

export const LIFECYCLE_TABS = ["schedule", "environments", "tiers", "advisories", "preview", "history"] as const;
export type LifecycleTab = (typeof LIFECYCLE_TABS)[number];
export const TAB_LABEL: Record<LifecycleTab, string> = { schedule: "Schedule", environments: "Environments", tiers: "Tiers", advisories: "Advisories", preview: "Preview", history: "History" };

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

/** The pill and line of a smoke verdict. A pass that is stale (what runs now rolled out after it, or it cannot be
 * tied to its env any more) opens no gate, so it is never shown as PASS — the same rule as the Environments tab. */
export function smokePill(v: Pick<SmokeVerdict, "verdict" | "detail" | "stale">): { word: StatusWord; detail: string } {
  if (v.verdict === "pass" && v.stale) return { word: "WATCH", detail: `${v.detail}, but that is no longer evidence: ${v.stale}` };
  return { word: verdictWord(v.verdict), detail: v.detail };
}

/** What the Advisories pane says when the scan lists nothing. "None" is a claim about a scan that ran and read
 * everything: a scan that failed, a newer one that failed, or a source that did not answer makes it "none found". */
export function advisoriesEmptyLine(view: Pick<LifecycleAdvisories, "scan" | "discoveryErrors" | "lastFailed">): { word: StatusWord; text: string } {
  if (view.scan && !view.scan.ok) return { word: "WATCH", text: "None listed — but the scan itself failed, so the list may be incomplete." };
  if (view.lastFailed) return { word: "WATCH", text: `None found by the scan shown — but the latest scan (${view.lastFailed.runId}) failed, so what has changed since is not known.` };
  if (view.discoveryErrors.length > 0) return { word: "WATCH", text: `None found — but ${plural(view.discoveryErrors.length, "source")} did not answer, so advisories may be missing.` };
  return { word: "OK", text: "No known advisory affects anything in the inventory." };
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

/** The word a whole tier carries in its plate header: the most urgent thing
 * in it. Advisories count — a tier whose components are all "current" is not
 * OK while one of them carries a known-exploited, critical or high advisory
 * (a zero-day with no fix yet, or a plan that lags the daily CVE scan), and
 * never green while it carries any advisory at all. */
export function tierWord(t: Pick<TierView, "total" | "actionable" | "counts"> & Partial<Pick<TierView, "advisories" | "kev" | "highestSeverity">>): StatusWord {
  const advisories = t.advisories ?? 0;
  if (t.total === 0) return advisories > 0 ? "WATCH" : "UNKNOWN";
  if (t.counts.failed > 0) return "FAIL";
  if (t.counts.blocked > 0) return "DENIED";
  if (t.counts["awaiting-approval"] > 0) return "AWAITING HUMAN";
  if (t.counts.escalated > 0) return "WATCH";
  if ((t.kev ?? 0) > 0 || t.highestSeverity === "critical" || t.highestSeverity === "high") return "WATCH";
  if (t.counts.outdated > 0) return "PENDING";
  if (t.counts["pr-open"] > 0) return "RUNNING";
  if (advisories > 0) return "WATCH";
  return "OK";
}

// ── environments ──────────────────────────────────────────────────────────

/** How well an environment was read, in the words the pane uses. */
export const OBSERVATION_TEXT: Record<EnvironmentView["observation"]["state"], string> = {
  observed: "observed",
  partial: "observed in part",
  stale: "stale",
  "not-observed": "not observed",
};

/** What a run read of one tier of one environment (the per-tier column). */
export const COVERAGE_TEXT: Record<EnvTierView["state"], string> = {
  observed: "read",
  partial: "read in part",
  "not-observed": "not read",
  "not-applicable": "does not apply",
};

const JOB_TEXT: Record<NonNullable<EnvironmentView["observation"]["lastObserved"]>["job"], string> = { plan: "the plan job", source: "the source job", live: "a live read of twizz-gitops and Argo" };

/** "observed 1d 0h ago by the plan job" — and, for an environment that was
 * NOT read by the run shown, when it last was (or that it never was). Never
 * reads as fresh when it is not: the state leads the sentence. */
export function observationLine(e: Pick<EnvironmentView, "observation" | "kind">, nowMs: number): string {
  const o = e.observation;
  const last = o.lastObserved;
  const when = last ? `${relTime(last.at, Math.max(nowMs, Date.parse(last.at) || nowMs))} by ${JOB_TEXT[last.job]}` : null;
  // a preview env is read live; when Argo did not answer, only gitops was read — never "and Argo"
  if (e.kind === "preview") return o.state === "observed" ? "read live from twizz-gitops and Argo" : "read in part: twizz-gitops was read, Argo could not be";
  if (o.state === "not-observed") return when ? `not observed by the run shown · last observed ${when}` : "not observed · never read by a run Nebula has";
  return when ? `${OBSERVATION_TEXT[o.state]} ${when}` : OBSERVATION_TEXT[o.state];
}

/** "34 components · 30 current · 3 behind · 1 blocked" — zeros dropped; the
 * order is fixed (current first) so three environments read down a column. */
export function envCountsLine(c: EnvironmentView["counts"]): string {
  if (c.total === 0) return "no components reported";
  const parts: Array<[number, string]> = [
    [c.current, "current"],
    [c.behind, "behind"],
    [c.blocked, "blocked"],
    [c.escalated, "escalated"],
    [c.failed, "failed"],
    [c.unknown, "unknown"],
    [c.eol, "end of life"],
  ];
  return [plural(c.total, "component"), ...parts.filter(([n]) => n > 0).map(([n, what]) => `${n} ${what}`)].join(" · ");
}

/** "2 critical · 1 high · 3 moderate" (worst first), or why there is no number. */
export function envAdvisoriesLine(a: EnvironmentView["advisories"]): string {
  if (!a.scanned) return "no CVE scan yet";
  // the scan says it could not read part of this environment: "none" is then only "none found"
  const incomplete = a.gaps.length > 0;
  if (a.total === 0) return incomplete ? "none found · the scan did not cover all of it" : "none open";
  const line = SEVERITIES.filter((s) => a.counts[s] > 0)
    .map((s) => `${a.counts[s]} ${s}`)
    .join(" · ");
  return incomplete ? `${line} · the scan did not cover all of it` : line;
}

/** The worst severity word an environment's open advisories carry (null: none, or no scan). */
export function envSeverityWord(a: EnvironmentView["advisories"]): StatusWord | null {
  const worst = SEVERITIES.find((s) => a.counts[s] > 0);
  return a.scanned && worst ? SEVERITY_WORD[worst] : null;
}

/** The environment a reader should look at first: the worst-standing fixed
 * one (the server's order breaks ties), so the detail plate never opens on a
 * healthy environment while another one is not known. */
export function defaultEnvironment(view: Pick<LifecycleEnvironments, "environments">): string | null {
  const rank = (w: StatusWord) => {
    const i = ["UNKNOWN", "FAIL", "DENIED", "AWAITING HUMAN", "WATCH", "PENDING", "RUNNING"].indexOf(w);
    return i < 0 ? 99 : i;
  };
  const fixed = view.environments.filter((e) => e.kind !== "preview");
  const pool = fixed.length ? fixed : view.environments;
  return [...pool].sort((a, b) => rank(a.word) - rank(b.word))[0]?.name ?? null;
}

/** Names for the environment filter of the Tiers and Advisories panes: every
 * fixed environment (even with nothing reported, so a focused-but-empty one
 * still shows as the active filter), then whatever else the data names. */
export function environmentFilterNames(envs: Pick<LifecycleEnvironments, "environments"> | null, present: readonly string[], active: string | null = null): string[] {
  const fixed = (envs?.environments ?? []).filter((e) => e.kind !== "preview").map((e) => e.name);
  return [...new Set([...fixed, ...present, ...(active ? [active] : [])])];
}

// ── links ─────────────────────────────────────────────────────────────────

const PREVIEW_HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.prv\.twizz\.com$/;

/** The `href` an outbound link on /lifecycle may carry, or null (render the
 * label as plain text). Two kinds of target exist: the hosts a snapshot may
 * link to (GitHub, the advisory databases — the shared allowlist, enforced at
 * ingest too) and Nebula's own preview-domain hosts. `https:` only, exact
 * host, no credentials, no port. A `javascript:` or look-alike URL can
 * therefore neither crash the render nor send an operator somewhere else. */
export function safeExternalHref(raw: unknown): string | null {
  const listed = lifecycleSafeLink(raw);
  if (listed) return listed;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2000) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f\\]/.test(raw)) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port || !PREVIEW_HOST_RE.test(u.hostname)) return null;
  if (!raw.toLowerCase().startsWith(`https://${u.hostname}/`) && raw.toLowerCase() !== `https://${u.hostname}`) return null;
  return u.href;
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

/** The environments tile: how many of the fixed environments the data covers.
 * Its word is the worst observation, so one unread cluster is visible from the header. */
export function environmentsTile(envs: LifecycleEnvironments | { error: string } | null): HeaderTile {
  const base = { key: "environments", label: "environments", tab: "environments" as const };
  if (envs === null) return { ...base, word: "PENDING", value: "…", detail: "reading how each environment stands" };
  if ("error" in envs) return { ...base, word: "UNKNOWN", value: "unreadable", detail: envs.error };
  const fixed = envs.environments.filter((e) => e.kind === "fixed");
  const unread = fixed.filter((e) => e.observation.state === "not-observed");
  const shaky = fixed.filter((e) => e.observation.state === "partial" || e.observation.state === "stale");
  const word: StatusWord = unread.length > 0 ? "UNKNOWN" : shaky.length > 0 ? "WATCH" : "OK";
  const detail = unread.length > 0 ? `not observed: ${unread.map((e) => e.name).join(", ")}` : shaky.length > 0 ? `${shaky.map((e) => `${e.name} ${OBSERVATION_TEXT[e.observation.state]}`).join(", ")}` : "every environment was read by the latest runs";
  return { ...base, word, value: `${envs.observed} of ${envs.fixed} read`, detail };
}

export function headerTiles(o: LifecycleOverview, bundle: { state: PreviewState; detail: string; key12: string | null } | { error: string } | null, nowMs: number, envs?: LifecycleEnvironments | { error: string } | null): HeaderTile[] {
  const h = o.header;
  const noPlan = !o.runs.plan && !o.runs.source;
  const noCve = !o.runs.cve;
  // the same count the Tiers pane's default filter keeps (an up-to-date but vulnerable component counts)
  const attention = o.tiers.reduce((n, t) => n + t.components.filter(needsAttention).length, 0);
  // A zero is green only when the run behind it is good. "0 outdated" over a failed plan, or next to components
  // that failed, are blocked or could not be assessed, is not OK; nor is "0 advisories" from a scan that failed,
  // is stale, was followed by a failed one, or says a source did not answer.
  const runShaky = (r: LifecycleOverview["runs"]["plan"]) => !!r && (!r.ok || !!r.lastFailed);
  const stuck = o.tiers.reduce((n, t) => n + t.counts.failed + t.counts.blocked + t.counts.escalated + t.counts.unknown, 0);
  const planShaky = runShaky(o.runs.plan) || runShaky(o.runs.source) || stuck > 0;
  const cveWhy = noCve
    ? null
    : !o.runs.cve!.ok
      ? "the scan shown failed, so the list may be incomplete"
      : o.runs.cve!.lastFailed
        ? `the latest scan (${o.runs.cve!.lastFailed.runId}) failed; this is the scan from before it`
        : o.discoveryErrors.some((e) => e.job === "cve")
          ? `${plural(o.discoveryErrors.filter((e) => e.job === "cve").length, "source")} did not answer, so advisories may be missing`
          : o.stale.cve.word !== "OK"
            ? o.stale.cve.detail
            : null;
  const tiles: HeaderTile[] = [
    {
      key: "outdated",
      label: "outdated",
      // nothing outdated, but upgrades still open or waiting for approval: work is pending, which is not OK either
      word: noPlan ? "UNKNOWN" : h.outdated > 0 ? "PENDING" : planShaky ? "WATCH" : h.actionable > 0 ? "PENDING" : "OK",
      value: noPlan ? "—" : String(h.outdated),
      detail: noPlan ? "no plan snapshot yet" : `of ${plural(h.components, "component")} · ${attention} need${attention === 1 ? "s" : ""} attention`,
      tab: "tiers",
    },
    {
      key: "critical-high",
      label: "critical / high",
      // the header counts critical + high together (the split is on the pane), so the word is "act now", not one severity
      word: noCve ? "UNKNOWN" : h.criticalHigh > 0 ? "HOT" : cveWhy ? "WATCH" : "OK",
      value: noCve ? "—" : String(h.criticalHigh),
      detail: noCve ? "no CVE scan yet" : h.criticalHigh === 0 && cveWhy ? `none found — ${cveWhy}` : `advisories · ${h.newAdvisories > 0 ? `${h.newAdvisories} new since the previous scan` : "none new since the previous scan"}`,
      tab: "advisories",
    },
    {
      key: "kev",
      label: "known exploited",
      word: noCve ? "UNKNOWN" : h.kev > 0 ? "KEV" : cveWhy ? "WATCH" : "OK",
      value: noCve ? "—" : String(h.kev),
      detail: noCve ? "no CVE scan yet" : h.kev > 0 ? "in CISA's catalogue of vulnerabilities exploited in the wild" : cveWhy ? `none found — ${cveWhy}` : "nothing here is in CISA's exploited catalogue",
      tab: "advisories",
    },
    ...(envs === undefined ? [] : [environmentsTile(envs)]),
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
export function nextAction(input: {
  overview: LifecycleOverview;
  preview: LifecyclePreview | null;
  previewError?: string | null;
  /** the per-environment part; `{ error }`: it could not be read; absent: the caller does not have it */
  environments?: LifecycleEnvironments | { error: string } | null;
}): NextAction {
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
  // "Nothing to do" is a claim about every environment. One that was not read, or read in part, or whose
  // standing is not known, takes it away — the header never says OK over an environment that is UNKNOWN.
  const envs = input.environments;
  if (envs && "error" in envs) return act("UNKNOWN", "The environments could not be read", `${envs.error}; whether every environment was observed is not known`, "environments");
  if (envs) {
    const fixed = envs.environments.filter((e) => e.kind !== "preview");
    const names = (xs: typeof fixed) => xs.map((e) => e.name).join(", ");
    const unread = fixed.filter((e) => e.observation.state === "not-observed");
    if (unread.length) return act("UNKNOWN", `${names(unread)} ${unread.length === 1 ? "was" : "were"} not observed`, `${unread[0].observation.reasons[0] ?? unread[0].headline}; nothing is known about ${unread.length === 1 ? "it" : "them"} until a plan run reads ${unread.length === 1 ? "it" : "them"}`, "environments");
    const inPart = fixed.filter((e) => e.observation.state !== "observed");
    if (inPart.length) return act("WATCH", `${names(inPart)} ${inPart.length === 1 ? "was" : "were"} not fully observed`, inPart[0].observation.reasons[0] ?? inPart[0].headline, "environments");
    const notOk = fixed.filter((e) => e.word !== "OK");
    if (notOk.length) return act(notOk[0].word === "UNKNOWN" ? "UNKNOWN" : "WATCH", `Look at ${names(notOk)}`, notOk[0].headline, "environments");
  }
  // …and a claim that every job ran. A source run that failed (with or without an older good one behind it) opened
  // no upgrade pull requests and built no bundle this month: that is something to look at, not nothing to do.
  const src = o.runs.source;
  const srcFailed = src && !src.ok ? { runId: src.runId, error: src.error } : (src?.lastFailed ?? null);
  if (srcFailed) return act("WATCH", "The last source run failed", `source run ${srcFailed.runId} failed${srcFailed.error ? `: ${srcFailed.error}` : ""}; no upgrade pull requests or bundle came out of it — see its log, the next scheduled run tries again`, "schedule");
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
