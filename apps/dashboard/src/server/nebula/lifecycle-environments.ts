// Lifecycle (docs/NEBULA.md §N9, "Environments"): the same snapshots as the
// Tiers pane, turned ninety degrees — one row of facts per ENVIRONMENT instead
// of per component. Pure (no Prisma, no GitHub, no kube, no node built-ins),
// unit-tested, READ ONLY by construction.
//
// The one rule this file exists for: an environment is never shown as fine
// because nothing was said about it. Every fixed environment of PLO's
// inventory is always listed; what a run really read of it comes from the
// snapshot's `coverage` (PLO `coverageOf`); and a tier that was not read, a
// cluster that did not answer, a run that is older than its schedule allows or
// a snapshot that does not say what it covered each take the green away, with
// the reason in words.
import {
  LIFECYCLE_ENVIRONMENTS,
  type LifecycleComponent,
  type LifecycleCoverageState,
  type LifecycleEnvironmentCoverage,
  type LifecyclePrRef,
  type LifecycleSeverity,
  type LifecycleTier,
} from "@twizz-idp/shared";
import type { StatusWord } from "@/lib/nebula/status";
import { PLO_ENV_PREFIX, SOURCE_RUN_TIERS, STALE_AFTER_MS, TIER_LABEL, TIER_ORDER, mergeComponents, selectSnapshots, severityRank, staleness, weakerRunFirst, type PreviewView, type SmokeVerdict, type SnapshotRow, type SnapshotSelection } from "./lifecycle-model";

const DAY = 24 * 60 * 60_000;

/** A source run is monthly; its rows are also in every weekly plan, so this
 * only bites when the plan job has stopped reporting them. */
export const SOURCE_STALE_AFTER_MS = 32 * DAY;

/** the cluster every bundle preview env (`plo-*`) runs on */
export const PREVIEW_CLUSTER = LIFECYCLE_ENVIRONMENTS[0].clusters[0];

/** the discovery domains behind a tier (PLO `TIER_DOMAINS`), for snapshots that carry no coverage list */
const TIER_DOMAINS: Record<LifecycleTier, readonly string[]> = {
  "control-plane": ["eks-control-plane"],
  addons: ["eks-addon"],
  nodes: ["eks-nodegroup"],
  helm: ["helm-release"],
  "base-images": ["base-image", "node-runtime"],
  "npm-direct": ["npm-dependency"],
  "npm-transitive": ["npm-dependency"],
};

/** A plan run's coverage without its payload (the reader selects only this key). */
export type CoverageHistoryRow = { job: string; runId: string; ok: boolean; finishedAt: Date; coverage: LifecycleEnvironmentCoverage[] | null };

export type EnvironmentsInput = {
  /** the same rows the overview is built from */
  rows: readonly SnapshotRow[];
  now: Date;
  /** recent plan runs, newest first; absent: only the run shown can vouch for "last observed" */
  planHistory?: readonly CoverageHistoryRow[];
  /** the bundle's state machine; null: not read (see `previewError`) */
  preview?: PreviewView | null;
  previewError?: string | null;
  /** false: the named-env manifests could not be read, so "no preview env" is not known (default true) */
  previewEnvsRead?: boolean;
};

export type EnvObservationState = "observed" | "partial" | "stale" | "not-observed";

export type EnvCounts = {
  total: number;
  /** current or applied */
  current: number;
  /** outdated, upgrade PR open or awaiting approval */
  behind: number;
  blocked: number;
  escalated: number;
  failed: number;
  unknown: number;
  awaitingApproval: number;
  /** past end of life */
  eol: number;
};

export type EnvTierView = EnvCounts & {
  tier: LifecycleTier;
  label: string;
  /** what the run read of this tier here */
  state: LifecycleCoverageState;
  /** why the state is not "observed" */
  reasons: string[];
  /** the run the rows and the coverage are from; null: no run */
  from: { job: "plan" | "source"; runId: string; finishedAt: string } | null;
  /** distinct advisories naming a component of this tier in this environment; null: no CVE scan */
  advisories: number | null;
  kev: number;
  /** null: the tier does not apply to this environment (no pill) */
  word: StatusWord | null;
};

export type EnvChangeSet = {
  id: string;
  tier: LifecycleTier;
  target: string;
  /** PLO's own status text (planned, pr-opened, awaiting-approval, …) */
  status: string;
  word: StatusWord;
  components: number;
  pr: LifecyclePrRef | null;
  escalationUrl: string | null;
  from: "plan" | "source";
};

export type EnvFreshness = { job: "plan" | "source" | "cve"; runId: string | null; at: string | null; word: Extract<StatusWord, "OK" | "WATCH" | "UNKNOWN">; detail: string };

export type EnvStageLine = { label: string; word: StatusWord; detail: string };

export type EnvironmentView = {
  name: string;
  /** fixed: in PLO's inventory, always listed; reported: named by a snapshot only; preview: a live bundle preview env */
  kind: "fixed" | "reported" | "preview";
  clusters: string[];
  /** worst of everything below; never OK unless the environment was observed, fresh and clean */
  word: StatusWord;
  /** the reason for the word, in one line */
  headline: string;
  observation: {
    state: EnvObservationState;
    word: Extract<StatusWord, "OK" | "WATCH" | "UNKNOWN">;
    reasons: string[];
    /** the newest run that read this environment; `job: "live"` for a preview env read from gitops and Argo */
    lastObserved: { at: string; job: "plan" | "source" | "live"; runId: string | null } | null;
  };
  counts: EnvCounts;
  /** empty for a preview env */
  tiers: EnvTierView[];
  /** `gaps`: what the CVE scan says it could not read of this environment (its own discovery errors, or that it
   * failed). Non-empty means "none open" is NOT known here, whatever `total` says. */
  advisories: { scanned: boolean; total: number; counts: Record<LifecycleSeverity, number>; kev: number; gaps: string[] };
  /** change sets that still need something to happen, most urgent first (capped) */
  changeSets: EnvChangeSet[];
  changeSetsTotal: number;
  /** where the monthly bundle stands for this environment; empty: no bundle touches it */
  stage: EnvStageLine[];
  freshness: EnvFreshness[];
  /** the /monitor tier that shows this environment's runtime health; null: none */
  monitor: "production" | "staging" | null;
  /** preview envs only */
  preview: { service: string; url: string; expiresAt: string | null; bundleKey12: string | null } | null;
};

export type EnvironmentsView = {
  environments: EnvironmentView[];
  /** how many fixed environments are observed (state observed or partial or stale) */
  observed: number;
  fixed: number;
  /** things that could not be read and so are missing above (never hidden) */
  notes: string[];
};

export const MAX_ENV_CHANGE_SETS = 30;

// ── words ─────────────────────────────────────────────────────────────────

/** worst first: the word an environment (or one of its tiers) carries is the first of these that applies.
 * UNKNOWN stands before PENDING and RUNNING: work that is merely waiting or under way must never be the word
 * over something that is not known (no CVE scan, a component nobody could assess, an Argo that did not answer). */
export const ENV_WORD_RANK: readonly StatusWord[] = ["FAIL", "DENIED", "AWAITING HUMAN", "WATCH", "UNKNOWN", "PENDING", "RUNNING", "DEPLOYED", "PASS", "PLANNED", "OK"];

export function worstWord(words: readonly StatusWord[]): StatusWord {
  let best: StatusWord = "OK";
  let at = ENV_WORD_RANK.indexOf("OK");
  for (const w of words) {
    const i = ENV_WORD_RANK.indexOf(w);
    // a word outside the list is not one this derivation makes; it must never read better than OK
    const rank = i < 0 ? ENV_WORD_RANK.indexOf("UNKNOWN") : i;
    if (rank < at) {
      at = rank;
      best = i < 0 ? "UNKNOWN" : w;
    }
  }
  return best;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function emptyCounts(): EnvCounts {
  return { total: 0, current: 0, behind: 0, blocked: 0, escalated: 0, failed: 0, unknown: 0, awaitingApproval: 0, eol: 0 };
}

export function countComponents(rows: ReadonlyArray<Pick<LifecycleComponent, "status" | "eol">>): EnvCounts {
  const c = emptyCounts();
  for (const r of rows) {
    c.total += 1;
    if (r.status === "current" || r.status === "applied") c.current += 1;
    else if (r.status === "outdated" || r.status === "pr-open" || r.status === "awaiting-approval") c.behind += 1;
    else if (r.status === "blocked") c.blocked += 1;
    else if (r.status === "escalated") c.escalated += 1;
    else if (r.status === "failed") c.failed += 1;
    else c.unknown += 1;
    if (r.status === "awaiting-approval") c.awaitingApproval += 1;
    if (r.eol?.eol) c.eol += 1;
  }
  return c;
}

/** The words a set of counts and advisories brings (each with its reason), worst-of is taken by the caller. */
function findings(c: EnvCounts, adv: { scanned: boolean; total: number; kev: number; criticalHigh: number }): Array<{ word: StatusWord; why: string }> {
  const out: Array<{ word: StatusWord; why: string }> = [];
  if (c.failed > 0) out.push({ word: "FAIL", why: `${plural(c.failed, "upgrade")} failed` });
  if (c.blocked > 0) out.push({ word: "DENIED", why: `${plural(c.blocked, "component")} blocked` });
  if (c.awaitingApproval > 0) out.push({ word: "AWAITING HUMAN", why: `${plural(c.awaitingApproval, "upgrade")} awaiting approval` });
  if (adv.kev > 0) out.push({ word: "WATCH", why: `${plural(adv.kev, "known-exploited advisory", "known-exploited advisories")}` });
  if (adv.criticalHigh > 0) out.push({ word: "WATCH", why: `${plural(adv.criticalHigh, "critical or high advisory", "critical or high advisories")}` });
  if (c.escalated > 0) out.push({ word: "WATCH", why: `${plural(c.escalated, "component")} escalated to a human` });
  if (c.eol > 0) out.push({ word: "WATCH", why: `${plural(c.eol, "component")} past end of life` });
  if (adv.total > 0 && adv.kev === 0 && adv.criticalHigh === 0) out.push({ word: "WATCH", why: `${plural(adv.total, "open advisory", "open advisories")}` });
  const waiting = c.behind - c.awaitingApproval;
  if (waiting > 0) out.push({ word: "PENDING", why: `${plural(waiting, "component")} behind` });
  if (c.unknown > 0) out.push({ word: "UNKNOWN", why: `${plural(c.unknown, "component")} could not be assessed` });
  return out;
}

/** PLO's change-set status → word. `ignore` autonomy (an audit-only environment) is reported, never acted on. */
export function changeSetWord(status: string, autonomy: string): StatusWord {
  if (autonomy === "ignore") return "OBSERVE ONLY";
  switch (status) {
    case "planned":
    case "dry-run":
      return "PENDING";
    case "pr-opened":
      return "RUNNING";
    case "awaiting-approval":
      return "AWAITING HUMAN";
    case "escalated":
      return "WATCH";
    case "rolled-back":
    case "rollback-failed":
      return "FAIL";
    case "blocked-precheck":
      return "DENIED";
    default:
      return "UNKNOWN";
  }
}
const CHANGE_SET_DONE = ["applied", "skipped"];

// ── coverage ──────────────────────────────────────────────────────────────

type TierRead = { state: LifecycleCoverageState; reasons: string[]; from: SnapshotRow | null; job: "plan" | "source" | null };

const isSourceTier = (t: LifecycleTier) => SOURCE_RUN_TIERS.includes(t);
/** when a run lists one tier of one environment twice, the entry that claims least wins */
const COVERAGE_WORST_FIRST: readonly LifecycleCoverageState[] = ["not-observed", "partial", "observed", "not-applicable"];

/** What ONE run says about (environment, tier). `rows`: that run's own components of the tier in the environment. */
export function tierCoverage(run: SnapshotRow, env: { name: string; clusters: readonly string[] }, tier: LifecycleTier, rows: number): { state: LifecycleCoverageState; reasons: string[] } {
  const label = `${run.job} run ${run.runId}`;
  const cov = run.data.coverage;
  if (cov) {
    // An environment (or a tier of it) listed more than once cannot be right every time: the worst entry counts,
    // so a second entry can never talk a "not read" away.
    const mine = cov.filter((e) => e.environment === env.name);
    if (mine.length === 0) return { state: "not-observed", reasons: [`the ${label} does not list this environment`] };
    const listed = mine.flatMap((e) => e.tiers.filter((x) => x.tier === tier));
    if (listed.length === 0) return { state: "not-observed", reasons: [`the ${label} did not survey this tier`] };
    const t = [...listed].sort((a, b) => COVERAGE_WORST_FIRST.indexOf(a.state) - COVERAGE_WORST_FIRST.indexOf(b.state))[0];
    const twice = listed.length > 1 ? [`the ${label} lists this tier ${listed.length} times for this environment; the worst entry is shown`] : [];
    if (t.state === "not-applicable") return { state: "not-applicable", reasons: [] };
    if (t.state === "not-observed") return { state: "not-observed", reasons: [...(t.gaps.length ? t.gaps : [`the ${label} gives no reason`]), ...twice] };
    // The run says how many components it read here. Fewer rows in the snapshot means rows were left out on the
    // way (PLO drops rows to fit the size limits and keeps the coverage list): the counts understate, so the
    // tier is never a clean "observed" — whatever the coverage entry says.
    const short = rows < t.components ? [`the ${label} read ${t.components} components of this tier here but its snapshot carries ${rows}: rows were left out to fit the size limit, so the counts understate`] : [];
    // the run vouches for what it read; a failed run's word is never a clean "observed"
    const failed = !run.ok ? [`from a failed run (${run.data.error ?? "no reason given"}); what it did read may be incomplete`] : [];
    const reasons = [...t.gaps, ...short, ...failed, ...twice];
    if (t.state === "observed" && reasons.length === 0) return { state: "observed", reasons: [] };
    return { state: "partial", reasons: reasons.length ? reasons : [`the ${label} gives no reason`] };
  }
  // No coverage list (a snapshot from a PLO that predates it): rows are the only evidence there is.
  if (rows === 0) return { state: "not-observed", reasons: [`the ${label} has no rows for this tier here and carries no coverage list, so "nothing there" cannot be told from "not read"`] };
  const gaps = run.data.discoveryErrors.filter((e) => TIER_DOMAINS[tier].includes(e.domain)).map((e) => e.error);
  if (!run.ok) return { state: "partial", reasons: [`from a failed run (${run.data.error ?? "no reason given"})`, ...gaps] };
  return gaps.length ? { state: "partial", reasons: gaps } : { state: "observed", reasons: [] };
}

/** Which run speaks for a tier: the plan for what lives in a cluster; for the
 * repository tiers the newer of plan and source (the same rule as `mergeComponents`). */
function readTier(sel: SnapshotSelection<SnapshotRow>, env: { name: string; clusters: readonly string[] }, tier: LifecycleTier): TierRead {
  const plan = sel.plan.data;
  const source = sel.source.data;
  // the same order as `mergeComponents`: the newer run speaks, but a failed run never instead of a successful one
  const candidates = (isSourceTier(tier) ? [plan, source] : [plan]).filter((r): r is SnapshotRow => !!r).sort((a, b) => weakerRunFirst(b, a));
  if (candidates.length === 0) return { state: "not-observed", reasons: [isSourceTier(tier) ? "no plan or source snapshot received yet" : "no plan snapshot received yet"], from: null, job: null };
  const run = candidates[0];
  const mine = (run.data.components ?? []).filter((c) => c.tier === tier && c.environments.includes(env.name));
  const said = tierCoverage(run, env, tier, mine.length);
  const from = { from: run, job: run.job === "source" ? ("source" as const) : ("plan" as const) };
  // An environment that has a cluster has a control plane: "does not apply" is not an answer a run can give for it
  // (PLO's `coverageOf` only says it of an environment with no cluster). Taken at its word it would drop the tier
  // from what must be read, and the environment would read as observed on its repository tiers alone.
  if (tier === "control-plane" && env.clusters.length > 0 && said.state === "not-applicable")
    return { state: "not-observed", reasons: [`the ${run.job} run ${run.runId} says the control plane does not apply to ${env.name}, which has the cluster ${env.clusters.join(", ")} — that is not an answer for a cluster, so it was not read`], ...from };
  // A cluster that answered has a control plane (PLO `coverageOf` holds the same). Whatever a coverage entry
  // says, a cluster of this environment with no control-plane row in the run was not read: "asked, nothing
  // there" is never an answer for this tier, and a row filed under another cluster is not this environment's.
  if (tier === "control-plane" && said.state !== "not-applicable" && said.state !== "not-observed") {
    const headless = env.clusters.filter((cluster) => !mine.some((c) => c.target === cluster));
    if (headless.length) {
      const why = `the ${run.job} run ${run.runId} carries no control-plane row for ${headless.join(", ")}`;
      return { state: headless.length === env.clusters.length ? "not-observed" : "partial", reasons: [why, ...said.reasons], ...from };
    }
  }
  return { ...said, ...from };
}

/** Did this run read the environment at all: its cluster answered and no tier that applies went unread. */
function historyObserved(row: CoverageHistoryRow, env: { name: string; clusters: readonly string[] }): boolean {
  if (!row.ok || !row.coverage) return false;
  // every entry for the environment counts (one listed twice must be read every time), and EVERY tier must be
  // spoken for: a `plan --only <domain>` run lists the tiers it surveyed and is silent about the rest, and
  // silence is not an observation.
  const tiers = row.coverage.filter((e) => e.environment === env.name).flatMap((e) => e.tiers);
  if (!TIER_ORDER.every((tier) => tiers.some((t) => t.tier === tier))) return false;
  const applies = tiers.filter((t) => t.state !== "not-applicable");
  if (applies.length === 0) return false;
  // a cluster that answered has a control plane: one component per cluster, at least (the rule `readTier` holds
  // against the rows of the run shown; an earlier run is known by its coverage counts only)
  if (env.clusters.length > 0 && !applies.some((t) => t.tier === "control-plane" && t.state !== "not-observed" && t.components >= env.clusters.length)) return false;
  return applies.every((t) => t.state !== "not-observed");
}

// ── the bundle, per environment ───────────────────────────────────────────

const VERDICT_WORD: Record<SmokeVerdict["verdict"], StatusWord> = { pass: "PASS", fail: "FAIL", running: "RUNNING", none: "PLANNED" };

/** A bundle-wide smoke verdict as one line. A pass that is stale (what runs now rolled out after it) opens no
 * gate (`buildPreview`), so it is never shown as PASS here either. */
function smokeStageLine(label: string, v: SmokeVerdict): EnvStageLine {
  if (v.verdict === "pass" && v.stale) return { label, word: "WATCH", detail: `the last smoke passed but is no longer evidence: ${v.stale}` };
  return { label, word: VERDICT_WORD[v.verdict], detail: v.detail };
}

function stageLines(env: string, kind: EnvironmentView["kind"], p: PreviewView | null | undefined, previewError: string | null | undefined, envsRead = true): EnvStageLine[] {
  if (p === undefined) return [];
  if (p === null) return previewError ? [{ label: "bundle", word: "UNKNOWN", detail: `the bundle state could not be read: ${previewError}` }] : [];
  if (p.state === "no-bundle" || !p.key12) return [];
  const out: EnvStageLine[] = [];
  const key = `bundle ${p.key12}`;
  const previewable = p.bundles.filter((b) => b.previewable);
  if (env === LIFECYCLE_ENVIRONMENTS[0].name && kind === "fixed") {
    // the bundle's preview envs run on this cluster
    const withEnv = previewable.filter((b) => b.env);
    const up = withEnv.filter((b) => b.env!.up).length;
    const failed = withEnv.filter((b) => b.env!.build === "failed").length;
    if (!envsRead) out.push({ label: "preview", word: "UNKNOWN", detail: `${key}: the named-env manifests could not be read, so whether its preview envs exist is not known` });
    else if (previewable.length === 0) out.push({ label: "preview", word: "PLANNED", detail: `${key}: nothing in it can be previewed in Nebula` });
    else if (withEnv.length === 0) out.push({ label: "preview", word: "PLANNED", detail: `${key}: no preview env created yet (${plural(previewable.length, "service")} to preview)` });
    else out.push({ label: "preview", word: failed > 0 ? "FAIL" : up === previewable.length ? "PASS" : "RUNNING", detail: `${key}: ${up} of ${previewable.length} preview envs up${failed ? `, ${failed} build${failed === 1 ? "" : "s"} failed` : ""}` });
    out.push(smokeStageLine("preview smoke", p.smoke.preview));
    return out;
  }
  const touches = p.bundles.some((b) => b.environments.includes(env));
  if (!touches) return [];
  const promotable = p.bundles.filter((b) => b.staging && b.environments.includes(env));
  if (env === LIFECYCLE_ENVIRONMENTS[1].name) {
    if (promotable.length === 0) {
      out.push({ label: "bundle", word: "PLANNED", detail: `${key}: no bundled service has a staging route in Nebula; staging gets it from each repository's own pipeline once the pull requests merge` });
      return out;
    }
    const unread = promotable.filter((b) => b.staging!.error);
    if (unread.length) {
      // what staging runs is not known: never "0 of n deployed"
      out.push({ label: "bundle", word: "UNKNOWN", detail: `${key}: staging state could not be read for ${unread.map((b) => b.service).join(", ")} (${unread[0].staging!.error})` });
      out.push(smokeStageLine("staging smoke", p.smoke.stg));
      return out;
    }
    const deployed = promotable.filter((b) => b.staging!.deployed).length;
    const open = promotable.filter((b) => !b.staging!.deployed && b.staging!.promotion).length;
    out.push({
      label: "bundle",
      word: deployed === promotable.length ? "DEPLOYED" : open > 0 ? "RUNNING" : "PLANNED",
      detail: `${key}: ${deployed} of ${plural(promotable.length, "service")} run the bundle image${open ? `, ${plural(open, "promotion")} open` : ""}`,
    });
    out.push(smokeStageLine("staging smoke", p.smoke.stg));
    return out;
  }
  // every other environment the bundle reaches (prod): it gets there only after the sign-off and a human merge
  if (p.signoff) out.push({ label: "sign-off", word: "PASS", detail: `${key} signed off by ${p.signoff.by}; merging the bundled pull requests is a human action in GitHub` });
  else if (p.state === "awaiting-signoff") out.push({ label: "sign-off", word: "AWAITING HUMAN", detail: `${key}: ${p.detail}` });
  else out.push({ label: "sign-off", word: "PLANNED", detail: `${key} is not signed off: ${p.detail}` });
  return out;
}

// ── build ─────────────────────────────────────────────────────────────────

/** Ids of the change sets the plan reports for an infrastructure tier. A source run is assembled next to
 * repository code: it may finish or replace a REPOSITORY-tier change set, never one of these — not by naming the
 * id under a repository tier either (the rule `mergeComponents` holds for rows). Read from the plan itself, so
 * it holds whichever of the two runs is laid over the other. */
function planInfraChangeSetIds(sel: SnapshotSelection<SnapshotRow>): Set<string> {
  return new Set((sel.plan.data?.data.changeSets ?? []).filter((cs) => !isSourceTier(cs.tier)).map((cs) => cs.id));
}

function pendingChangeSets(sel: SnapshotSelection<SnapshotRow>, env: string, componentEnvs: Map<string, readonly string[]>): EnvChangeSet[] {
  const byId = new Map<string, EnvChangeSet>();
  const infra = planInfraChangeSetIds(sel);
  const ordered = [
    { row: sel.plan.data, from: "plan" as const },
    { row: sel.source.data, from: "source" as const },
  ]
    .filter((x): x is { row: SnapshotRow; from: "plan" | "source" } => !!x.row)
    .sort((a, b) => weakerRunFirst(a.row, b.row));
  for (const { row, from } of ordered) {
    for (const cs of row.data.changeSets ?? []) {
      // a source run speaks for the repository tiers only (the rule of `mergeComponents`)
      if (from === "source" && !isSourceTier(cs.tier)) continue;
      // …and never for an infrastructure change set a plan reported under that id, whatever tier it now claims
      if (from === "source" && infra.has(cs.id)) continue;
      const envs = cs.stage === env ? [env] : [...new Set(cs.componentIds.flatMap((id) => componentEnvs.get(id) ?? []))];
      if (!envs.includes(env)) continue;
      if (CHANGE_SET_DONE.includes(cs.status)) {
        byId.delete(cs.id);
        continue;
      }
      byId.set(cs.id, { id: cs.id, tier: cs.tier, target: cs.target, status: cs.status, word: changeSetWord(cs.status, cs.autonomy), components: cs.componentIds.length, pr: cs.pr ?? null, escalationUrl: cs.escalationUrl ?? null, from });
    }
  }
  const rank = (w: StatusWord) => (w === "OBSERVE ONLY" ? ENV_WORD_RANK.length : ENV_WORD_RANK.indexOf(w));
  return [...byId.values()].sort((a, b) => rank(a.word) - rank(b.word) || TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) || a.id.localeCompare(b.id));
}

function freshnessOf(job: "plan" | "source" | "cve", row: SnapshotRow | null, now: Date): EnvFreshness {
  if (job === "source") {
    if (!row) return { job, runId: null, at: null, word: "UNKNOWN", detail: "no source snapshot received yet" };
    const age = Math.max(0, now.getTime() - row.finishedAt.getTime());
    const at = row.finishedAt.toISOString();
    if (!row.ok) return { job, runId: row.runId, at, word: "WATCH", detail: "no successful source run yet; showing a failed run's partial data" };
    return age > SOURCE_STALE_AFTER_MS ? { job, runId: row.runId, at, word: "WATCH", detail: "source data is older than 32 days" } : { job, runId: row.runId, at, word: "OK", detail: "source data is within 32 days" };
  }
  const s = staleness(job, row, now);
  return { job, runId: row?.runId ?? null, at: s.at, word: s.word, detail: s.detail };
}

/** What the CVE scan says it did NOT read of an environment. A cve snapshot carries no coverage list, only PLO's
 * `discoveryErrors`. PLO starts an error with `<cluster or repository>:` when it concerns one target (the rule of
 * its `coverageOf`); such an error concerns the environment owning that cluster, or the environments that
 * repository's components are in. EVERY other error — an advisory source that did not answer, a snapshot cut to
 * fit, a name this dashboard cannot place — concerns every environment: a gap is never dropped because it could
 * not be attributed. `subjects`: every cluster and target name the dashboard knows, with its environments. */
export function cveGapsFor(env: { name: string }, cve: SnapshotRow | null, subjects: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  if (!cve) return [];
  const out: string[] = [];
  if (!cve.ok) out.push(`the CVE scan shown (run ${cve.runId}) failed${cve.data.error ? `: ${cve.data.error}` : ""}; what it lists may be incomplete`);
  for (const e of cve.data.discoveryErrors) {
    const named = [...subjects.keys()].filter((s) => e.error.startsWith(`${s}:`));
    // a subject the dashboard knows by name but can place in NO environment is as good as unknown: everybody's
    const placed = named.length > 0 && named.every((s) => subjects.get(s)!.size > 0);
    if (!placed || named.some((s) => subjects.get(s)!.has(env.name))) out.push(e.error);
  }
  return [...new Set(out)];
}

/** cluster and component-target names → the environments they belong to (for `cveGapsFor`) */
function cveSubjects(sel: SnapshotSelection<SnapshotRow>, known: ReadonlyArray<{ name: string; clusters: readonly string[] }>): Map<string, Set<string>> {
  const subjects = new Map<string, Set<string>>();
  const add = (subject: string, envs: readonly string[]) => {
    if (!subject) return;
    const set = subjects.get(subject) ?? new Set<string>();
    for (const e of envs) set.add(e);
    subjects.set(subject, set);
  };
  for (const e of known) for (const c of e.clusters) add(c, [e.name]);
  // The PLAN's word only. A subject narrows who sees a gap, so it must come from a run that does not sit next to
  // repository code: a source run naming an advisory source ("OSV") as one of its targets would otherwise keep
  // that source's failure away from every other environment. What only a source run knows is unplaced → everybody.
  const row = sel.plan.data;
  for (const c of row?.data.coverage ?? []) for (const cluster of c.clusters) add(cluster, [c.environment]);
  for (const c of row?.data.components ?? []) add(c.target, c.environments);
  for (const a of sel.cve.data?.data.advisories ?? []) for (const x of a.affected) add(x.target, x.environments);
  return subjects;
}

function fixedEnvironment(env: { name: string; clusters: readonly string[] }, kind: "fixed" | "reported", sel: SnapshotSelection<SnapshotRow>, input: EnvironmentsInput, subjects: ReadonlyMap<string, ReadonlySet<string>>): EnvironmentView {
  const merged = mergeComponents(sel.plan.data, sel.source.data);
  const mine = merged.filter((c) => c.environments.includes(env.name));
  const cve = sel.cve.data?.data.advisories ?? null;
  const here = (cve ?? []).filter((a) => a.affected.some((x) => x.environments.includes(env.name)));
  const advCounts: Record<LifecycleSeverity, number> = { critical: 0, high: 0, moderate: 0, low: 0, unknown: 0 };
  for (const a of here) advCounts[a.severity] += 1;
  const cveGaps = cveGapsFor(env, sel.cve.data, subjects);
  const advisories = { scanned: cve !== null, total: here.length, counts: advCounts, kev: here.filter((a) => a.kev).length, gaps: cveGaps };

  const tiers = TIER_ORDER.map((tier): EnvTierView => {
    const read = readTier(sel, env, tier);
    const rows = mine.filter((c) => c.tier === tier);
    const counts = countComponents(rows);
    const tierAdv = here.filter((a) => a.affected.some((x) => x.tier === tier && x.environments.includes(env.name)));
    const kev = tierAdv.filter((a) => a.kev).length;
    const criticalHigh = tierAdv.filter((a) => !a.kev && severityRank(a.severity) >= severityRank("high")).length;
    let word: StatusWord | null;
    if (read.state === "not-applicable") word = null;
    else if (read.state === "not-observed") word = "UNKNOWN";
    else
      word = worstWord([
        ...findings(counts, { scanned: cve !== null, total: tierAdv.length, kev, criticalHigh }).map((f) => f.word),
        ...(read.state === "partial" ? (["WATCH"] as const) : []),
        // read and current is not "OK" while what is open against it is not known: no scan at all, or a scan that
        // says it could not read all of this environment (its advisory count is then "none found", not "none")
        ...(cve === null ? (["UNKNOWN"] as const) : cveGaps.length > 0 ? (["WATCH"] as const) : []),
      ]);
    return {
      ...counts,
      tier,
      label: TIER_LABEL[tier],
      state: read.state,
      reasons: read.reasons,
      from: read.from && read.job ? { job: read.job, runId: read.from.runId, finishedAt: read.from.finishedAt.toISOString() } : null,
      advisories: cve ? tierAdv.length : null,
      kev,
      word,
    };
  });

  // ── was it observed? ──
  const applies = tiers.filter((t) => t.state !== "not-applicable");
  const unread = applies.filter((t) => t.state === "not-observed");
  const partial = applies.filter((t) => t.state === "partial");
  const controlPlane = tiers.find((t) => t.tier === "control-plane")!;
  const clusterUnread = env.clusters.length > 0 && controlPlane.state === "not-observed";
  const freshness: EnvFreshness[] = [freshnessOf("plan", sel.plan.data, input.now)];
  if (sel.source.data && tiers.some((t) => t.from?.job === "source")) freshness.push(freshnessOf("source", sel.source.data, input.now));
  const cveFreshness = freshnessOf("cve", sel.cve.data, input.now);
  // A newer CVE run that failed: the scan shown is not the latest attempt, and what changed since is not known.
  const cveFailedNewer = sel.cve.last && sel.cve.data && sel.cve.last.id !== sel.cve.data.id ? sel.cve.last : null;
  if (cveFailedNewer && cveFreshness.word === "OK") {
    cveFreshness.word = "WATCH";
    cveFreshness.detail = `the latest cve run (${cveFailedNewer.runId}) failed${cveFailedNewer.data.error ? `: ${cveFailedNewer.data.error}` : ""}; showing run ${sel.cve.data!.runId} from before it`;
  }
  freshness.push(cveFreshness);
  // only the runs that actually supply this environment's rows can make it stale
  const supplying = freshness.filter((f) => f.job !== "cve" && tiers.some((t) => t.from?.job === f.job));
  const staleRuns = supplying.filter((f) => f.word === "WATCH" && f.at !== null && input.now.getTime() - Date.parse(f.at) > (f.job === "plan" ? STALE_AFTER_MS.plan : SOURCE_STALE_AFTER_MS));

  let state: EnvObservationState;
  const reasons: string[] = [];
  const tierWhy = (t: EnvTierView) => `${t.label}: ${t.reasons[0] ?? "not read"}${t.reasons.length > 1 ? ` (+${t.reasons.length - 1} more)` : ""}`;
  if (applies.length === 0) {
    state = "not-observed";
    reasons.push("no run says anything about this environment");
  } else if (unread.length === applies.length || clusterUnread) {
    state = "not-observed";
    if (clusterUnread) reasons.push(`${env.clusters.join(", ")} was not read — ${tierWhy(controlPlane)}`);
    for (const t of unread.filter((t) => t !== controlPlane || !clusterUnread).slice(0, 3)) reasons.push(tierWhy(t));
    if (unread.length > 4) reasons.push(`${unread.length - 3} more tiers were not read`);
  } else if (unread.length > 0 || partial.length > 0) {
    state = "partial";
    for (const t of [...unread, ...partial]) reasons.push(`${t.state === "not-observed" ? "not read" : "incomplete"} — ${tierWhy(t)}`);
  } else if (staleRuns.length > 0) {
    state = "stale";
  } else {
    state = "observed";
  }
  for (const f of staleRuns) reasons.push(`${f.detail} (run ${f.runId}); a newer run has not reported`);
  // a newer run that failed does not make the older data wrong, but it is why nothing newer is shown
  const failedNewer = sel.plan.last && sel.plan.data && sel.plan.last.id !== sel.plan.data.id ? sel.plan.last : null;
  if (failedNewer) reasons.push(`the latest plan run (${failedNewer.runId}) failed${failedNewer.data.error ? `: ${failedNewer.data.error}` : ""}; showing run ${sel.plan.data!.runId} from before it`);

  const observedNow = state !== "not-observed";
  // "Last observed" names a run that actually read something here: of the runs supplying a tier that was read
  // (in full or in part), the OLDEST — so the line never claims the environment is fresher than its oldest part,
  // and never credits a run that did not look at it.
  const speaking = tiers
    .filter((t) => (t.state === "observed" || t.state === "partial") && t.from)
    .map((t) => t.from!)
    .sort((a, b) => Date.parse(a.finishedAt) - Date.parse(b.finishedAt))[0];
  let lastObserved: EnvironmentView["observation"]["lastObserved"] = null;
  if (observedNow && speaking) lastObserved = { at: speaking.finishedAt, job: speaking.job, runId: speaking.runId };
  else {
    const earlier = (input.planHistory ?? []).find((r) => historyObserved(r, env));
    if (earlier) lastObserved = { at: earlier.finishedAt.toISOString(), job: "plan", runId: earlier.runId };
  }
  const obsWord = state === "observed" ? "OK" : state === "not-observed" ? "UNKNOWN" : "WATCH";

  // ── the word ──
  const counts = countComponents(mine);
  const criticalHigh = here.filter((a) => !a.kev && severityRank(a.severity) >= severityRank("high")).length;
  const found = findings(counts, { scanned: advisories.scanned, total: advisories.total, kev: advisories.kev, criticalHigh });
  const cveFresh = freshness.find((f) => f.job === "cve")!;
  if (cveFresh.word !== "OK") found.push({ word: cveFresh.word, why: cveFresh.word === "UNKNOWN" ? "no CVE scan yet, so open advisories are not known" : cveFresh.detail });
  // the scan ran but says it could not read part of this environment: "no open advisory" is not known here
  if (cveGaps.length > 0) found.push({ word: "WATCH", why: `the CVE scan did not cover all of this environment: ${cveGaps[0]}${cveGaps.length > 1 ? ` (+${cveGaps.length - 1} more)` : ""}` });
  let word: StatusWord;
  let headline: string;
  if (state === "not-observed") {
    // whatever older rows say, an environment nobody read is not known to be anything
    word = "UNKNOWN";
    headline = `not observed: ${reasons[0] ?? "no run has read it"}`;
  } else {
    if (state === "partial") found.push({ word: "WATCH", why: `observed in part: ${reasons[0]}` });
    if (state === "stale") found.push({ word: "WATCH", why: `stale: ${reasons[0]}` });
    if (failedNewer && state === "observed") found.push({ word: "WATCH", why: reasons[reasons.length - 1] });
    word = worstWord(found.map((f) => f.word));
    const lead = found.filter((f) => f.word === word).map((f) => f.why);
    headline = word === "OK" ? `observed and current: ${plural(counts.total, "component")} up to date, no open advisory` : lead.slice(0, 3).join(" · ");
  }

  const componentEnvs = new Map(merged.map((c) => [c.id, c.environments] as const));
  const changeSets = pendingChangeSets(sel, env.name, componentEnvs);

  return {
    name: env.name,
    kind,
    clusters: [...env.clusters],
    word,
    headline,
    observation: { state, word: obsWord, reasons, lastObserved },
    counts,
    tiers,
    advisories,
    changeSets: changeSets.slice(0, MAX_ENV_CHANGE_SETS),
    changeSetsTotal: changeSets.length,
    stage: stageLines(env.name, kind, input.preview, input.previewError, input.previewEnvsRead ?? true),
    freshness,
    monitor: env.name === "prod" ? "production" : env.name === "staging" ? "staging" : null,
    preview: null,
  };
}

function previewEnvironments(p: PreviewView, now: Date): EnvironmentView[] {
  return p.bundles.flatMap((b): EnvironmentView[] => {
    const e = b.env;
    if (!e) return [];
    const smoke = p.smoke.preview;
    // PLO names a check `<service>/<check>` and a target it refused or had no check for exactly `<service>`.
    const own = smoke.results.filter((r) => r.name === e.service || r.name.startsWith(`${e.service}/`));
    const failed = own.filter((r) => !r.ok);
    // evidence about what runs NOW only when the smoke was requested after this env last rolled out (the rule of `buildPreview`)
    const requested = smoke.request ? Date.parse(smoke.request.createdAt) : NaN;
    const rolled = e.rolledOutAt ? Date.parse(e.rolledOutAt) : NaN;
    const current = Number.isFinite(requested) && Number.isFinite(rolled) && requested > rolled;
    // Argo was asked what this (deployable) env runs and did not answer. `e.argo` cannot tell: the reader gives an
    // unreachable Argo the word UNKNOWN, and null to an env that is still building (nothing to read there yet).
    const argoUnread = e.build === "ready" && (e.argoUnread || e.argo === null);
    let smokeLine: EnvStageLine;
    // no result to read a row of: the bundle-wide verdict (not requested, running, failed without a result)
    if (smoke.results.length === 0) smokeLine = smokeStageLine("preview smoke", smoke);
    // a result that is not the request's own (wrong scope or bundle, outside the request's window, rows nobody
    // asked for): no row of it is worth a PASS, whatever the row says
    else if (!smoke.trusted) smokeLine = { label: "preview smoke", word: "FAIL", detail: smoke.detail };
    // the smoke ran and said nothing about this service: it is not verified, which is not "fine"
    else if (own.length === 0) smokeLine = { label: "preview smoke", word: "WATCH", detail: `the latest preview smoke had no check for ${e.service}, so it is not verified` };
    else if (failed.length > 0) smokeLine = { label: "preview smoke", word: "FAIL", detail: `${own.length - failed.length} of ${plural(own.length, "check")} passed for ${e.service}: ${failed[0].detail || failed[0].name}` };
    else if (!current)
      smokeLine = {
        label: "preview smoke",
        word: "WATCH",
        detail: `the checks for ${e.service} passed but are no longer evidence: ${e.rolledOutAt ? `${e.name} rolled out at ${e.rolledOutAt}, after the smoke was requested` : `Argo does not say when ${e.name} rolled out`} — run the preview smoke again`,
      };
    else smokeLine = { label: "preview smoke", word: "PASS", detail: `${own.length} of ${plural(own.length, "check")} passed for ${e.service}` };
    const lines: EnvStageLine[] = [
      { label: "build", word: e.build === "ready" ? "PASS" : e.build === "failed" ? "FAIL" : "RUNNING", detail: e.build === "ready" ? `image ${e.imageTag ?? "(no tag)"}` : (e.buildReason ?? (e.build === "failed" ? "the build failed" : "building")) },
      { label: "rollout", word: e.build !== "ready" ? "PLANNED" : e.up ? "DEPLOYED" : argoUnread ? "UNKNOWN" : e.argo === "PASS" ? "RUNNING" : e.argo!, detail: e.build !== "ready" ? "waits for the build" : e.up ? "Argo runs the bundle image" : argoUnread ? "Argo could not be read" : "Argo has not rolled the bundle image out yet" },
      smokeLine,
    ];
    // a step that is done, or not due yet, is not a finding against the env
    const word = worstWord(lines.map((l) => (l.word === "PLANNED" || l.word === "PASS" || l.word === "DEPLOYED" ? "OK" : l.word)));
    const lead = lines.find((l) => l.word === word) ?? lines.find((l) => l.word !== "PASS" && l.word !== "DEPLOYED");
    return [
      {
        name: e.name,
        kind: "preview",
        clusters: [PREVIEW_CLUSTER],
        word: word === "OK" ? "DEPLOYED" : word,
        headline: word === "OK" ? `up: runs bundle ${p.key12 ?? ""} of ${b.github}`.trim() : `${lead?.label ?? "preview"}: ${lead?.detail ?? p.detail}`,
        // gitops was read (the env is listed); what RUNS is Argo's word, and without it the env was read in part
        observation:
          argoUnread
            ? { state: "partial", word: "WATCH", reasons: ["Argo could not be read, so what this env runs is not known"], lastObserved: { at: now.toISOString(), job: "live", runId: null } }
            : { state: "observed", word: "OK", reasons: [], lastObserved: { at: now.toISOString(), job: "live", runId: null } },
        counts: emptyCounts(),
        tiers: [],
        advisories: { scanned: false, total: 0, counts: { critical: 0, high: 0, moderate: 0, low: 0, unknown: 0 }, kev: 0, gaps: [] },
        changeSets: [],
        changeSetsTotal: 0,
        stage: lines,
        freshness: [],
        monitor: null,
        preview: { service: e.service, url: e.url, expiresAt: e.expiresAt ?? null, bundleKey12: p.key12 },
      },
    ];
  });
}

/** Every environment, how it stands, and whether that is known. The fixed
 * environments first (promotion order), then any other name a snapshot uses,
 * then the live preview envs of the current bundle. */
export function buildEnvironments(input: EnvironmentsInput): EnvironmentsView {
  const sel = selectSnapshots(input.rows);
  const fixedNames: string[] = LIFECYCLE_ENVIRONMENTS.map((e) => e.name);
  const subjects = cveSubjects(sel, LIFECYCLE_ENVIRONMENTS);
  const environments: EnvironmentView[] = LIFECYCLE_ENVIRONMENTS.map((e) => fixedEnvironment(e, "fixed", sel, input, subjects));

  // a name PLO reports that the inventory constant does not know: shown, never dropped
  const reported = new Map<string, Set<string>>();
  for (const row of [sel.plan.data, sel.source.data]) {
    for (const c of row?.data.coverage ?? []) if (!fixedNames.includes(c.environment)) reported.set(c.environment, new Set([...(reported.get(c.environment) ?? []), ...c.clusters]));
    for (const c of row?.data.components ?? []) for (const e of c.environments) if (!fixedNames.includes(e) && !e.startsWith(PLO_ENV_PREFIX) && !reported.has(e)) reported.set(e, new Set());
  }
  for (const [name, clusters] of [...reported].sort((a, b) => a[0].localeCompare(b[0]))) environments.push(fixedEnvironment({ name, clusters: [...clusters] }, "reported", sel, input, subjects));

  const notes: string[] = [];
  if (input.preview) {
    environments.push(...previewEnvironments(input.preview, input.now));
    for (const b of input.preview.blockers) if (/could not be read|unreachable|did not parse/i.test(b)) notes.push(b);
  } else if (input.preview === null && input.previewError) {
    notes.push(`preview environments could not be read: ${input.previewError}`);
  }
  // What names no environment is in no row above. Say so: a row must not read as complete because of it.
  const listed = new Set(environments.map((e) => e.name));
  const componentEnvs = new Map(mergeComponents(sel.plan.data, sel.source.data).map((c) => [c.id, c.environments] as const));
  const adrift = new Map<string, boolean>();
  const planInfra = planInfraChangeSetIds(sel);
  for (const { row, from } of [
    { row: sel.plan.data, from: "plan" as const },
    { row: sel.source.data, from: "source" as const },
  ]
    .filter((x): x is { row: SnapshotRow; from: "plan" | "source" } => !!x.row)
    .sort((a, b) => weakerRunFirst(a.row, b.row))) {
    for (const cs of row.data.changeSets ?? []) {
      if (from === "source" && (!isSourceTier(cs.tier) || planInfra.has(cs.id))) continue;
      const placed = listed.has(cs.stage) || cs.componentIds.some((id) => (componentEnvs.get(id) ?? []).some((e) => listed.has(e)));
      adrift.set(cs.id, !placed && !CHANGE_SET_DONE.includes(cs.status));
    }
  }
  const lost = [...adrift].filter(([, is]) => is).map(([id]) => id);
  if (lost.length) notes.push(`${plural(lost.length, "pending change set")} could not be placed in any environment (${lost.slice(0, 3).join(", ")}${lost.length > 3 ? ", …" : ""}): the snapshot has no row for their components, so no environment above counts them`);
  const nowhere = (sel.cve.data?.data.advisories ?? []).filter((a) => !a.affected.some((x) => x.environments.some((e) => listed.has(e))));
  if (nowhere.length) notes.push(`${plural(nowhere.length, "open advisory", "open advisories")} of the CVE scan ${nowhere.length === 1 ? "names" : "name"} no environment listed here, so no environment above counts ${nowhere.length === 1 ? "it" : "them"}: see the Advisories tab`);
  if (!input.planHistory) notes.push("earlier plan runs could not be read, so \"last observed\" is known only from the run shown");

  const fixed = environments.filter((e) => e.kind === "fixed");
  return { environments, observed: fixed.filter((e) => e.observation.state !== "not-observed").length, fixed: fixed.length, notes };
}
