import * as React from "react";
import { Ext } from "@/components/lifecycle/parts";
import { describe, expect, it } from "vitest";
import { STATUS_WORDS, toneOf } from "../status";
import { buildAdvisories, buildOverview, buildPreview, selectSnapshots, type LifecycleServiceInput, type PreviewInput, type StagingTargetInput } from "@/server/nebula/lifecycle-model";
import { buildEnvironments } from "@/server/nebula/lifecycle-environments";
import { LIFECYCLE_ENVIRONMENTS, LIFECYCLE_TIERS, type LifecycleEnvironmentCoverage } from "@twizz-idp/shared";
import { DAY, HOUR, KEY, NOW, SHA_BACKEND, SHA_SENTINEL, advisory, affects, ago, bundle, component, env, pr, request, smokeRequest, smokeSnap, snap } from "@/server/nebula/__tests__/lifecycle-fixtures";
import {
  DEFAULT_ADVISORY_FILTER,
  DEFAULT_COMPONENT_FILTER,
  COVERAGE_TEXT,
  OBSERVATION_TEXT,
  defaultEnvironment,
  envAdvisoriesLine,
  envCountsLine,
  envSeverityWord,
  environmentFilterNames,
  environmentsTile,
  observationLine,
  LIFECYCLE_TABS,
  PREVIEW_STATE_LABEL,
  SEVERITIES,
  SEVERITY_WORD,
  STATUS_TEXT,
  STATUS_URGENCY,
  TAB_LABEL,
  advisoriesForComponent,
  advisoryEnvironments,
  advisoryWord,
  cronLabel,
  currentStepWord,
  emptyStateLines,
  envBuildWord,
  eolNote,
  epssPct,
  filterAdvisories,
  filterComponents,
  fmtTook,
  fmtUtc,
  fmtUtcStamp,
  hasAnySnapshot,
  headerTiles,
  advisoriesEmptyLine,
  smokePill,
  isProdEnv,
  needsAttention,
  nextAction,
  previewStateWord,
  relTime,
  requestText,
  requestWord,
  shortSha,
  shortTag,
  sortByRisk,
  staleNote,
  stepWord,
  tierSummary,
  safeExternalHref,
  tierWord,
  verdictWord,
  versionChange,
  type ComponentRow,
  type LifecyclePreview,
  type PreviewState,
} from "../lifecycle";

const now = NOW.getTime();
const SENTINEL = "twizz-app/twizz-sentinel";
const BACKEND = "twizz-app/Moly-backend";
const SERVICES: LifecycleServiceInput[] = [
  { service: "twizz-sentinel", repo: SENTINEL, promotable: true, stagingHost: "sentinel-stg.prv.twizz.com" },
  { service: "moly-backend", repo: BACKEND, promotable: false, stagingHost: null },
];
const ENV_S = "plo-2611-twizz-sentinel";
const ENV_B = "plo-2611-moly-backend";
const TAG_S = `nb-${ENV_S}-${SHA_SENTINEL.slice(0, 12)}`;

const planSnap = (components = COMPONENTS, at = ago(DAY)) => snap("plan", at, { components });
const COMPONENTS = [
  component("staging:eks:control-plane", { tier: "control-plane", name: "kubernetes", target: "EKS-Moly-staging", environments: ["staging"], current: "1.31", desired: "1.32", latest: "1.33", status: "awaiting-approval", autonomy: "approval" }),
  component("prod:eks:control-plane", { tier: "control-plane", name: "kubernetes", target: "EKS-Moly-Prod", environments: ["prod"], current: "1.31", desired: "1.32", latest: "1.33", status: "outdated", autonomy: "escalate" }),
  component("sentinel:npm:express", { name: "express", environments: ["staging", "prod"], status: "pr-open", pr: pr(SENTINEL, 41) }),
  component("sentinel:npm:zod", { name: "zod", current: "3.24.1", desired: null, latest: "3.24.1", bump: "none", status: "current" }),
  component("sentinel:npm:lodash", { name: "lodash", current: "4.17.20", desired: null, latest: "4.17.20", bump: "none", status: "current", environments: ["staging", "prod"] }),
  component("backend:image:node", { tier: "base-images", name: "node", target: "Moly-backend", environments: ["prod"], current: "18.20.4", desired: "22.11.0", latest: "24.1.0", bump: "major", status: "failed", eol: { eol: true, date: "2025-04-30" } }),
];
const ADVISORIES = [
  advisory("GHSA-low-0001", { severity: "low", affected: [affects("sentinel:npm:zod")] }),
  advisory("CVE-2026-1000", { severity: "high", kev: true, epss: 0.92, aliases: ["GHSA-kev-0001"], affected: [affects("sentinel:npm:lodash", { name: "lodash", environments: ["staging", "prod"], version: "4.17.20", fixedIn: "4.17.21" })] }),
  advisory("CVE-2026-2000", { severity: "critical", epss: 0.4, affected: [affects("backend:image:node", { name: "node", tier: "base-images", target: "Moly-backend", environments: ["prod"], version: "18.20.4", fixedIn: "22.11.0" }), affects("sentinel:npm:express", { name: "express", environments: ["staging"] })] }),
  advisory("GHSA-mod-0002", { severity: "moderate", affected: [affects("sentinel:npm:express", { name: "express", environments: ["staging"] })] }),
];
const cveSnap = (advisories = ADVISORIES, at = ago(2 * HOUR)) => snap("cve", at, { advisories });

function overviewOf(rows = [planSnap(), cveSnap()], requests: PreviewInput["requests"] = [], at = NOW) {
  return buildOverview({ rows, requests, now: at });
}
const allRows = (o: ReturnType<typeof overviewOf>): ComponentRow[] => o.tiers.flatMap((t) => t.components);

const source = () => snap("source", ago(DAY), { runId: "source-1", bundles: [bundle(SENTINEL, SHA_SENTINEL), bundle(BACKEND, SHA_BACKEND)], bundleKey: KEY });
const stagingOn = (tag: string | null): StagingTargetInput[] => [{ service: "twizz-sentinel", host: "sentinel-stg.prv.twizz.com", currentTag: tag, argo: "PASS", runsImage: true, rolledOutAt: ago(3 * 3_600_000).toISOString(), error: null }];
function previewOf(over: Partial<PreviewInput> = {}): LifecyclePreview {
  return buildPreview({ rows: [source()], requests: [], services: SERVICES, envs: [], promotions: [], staging: stagingOn("main-" + "1".repeat(40)), signoffs: [], envChanges: [], now: NOW, ...over });
}
const envsUp = () => [env(ENV_S, SENTINEL, SHA_SENTINEL), env(ENV_B, BACKEND, SHA_BACKEND)];
function smoked(scope: "preview" | "stg", ok: boolean, minutesAgo = 10) {
  const req = smokeRequest(scope, KEY, { status: "done", createdAt: ago((minutesAgo + 5) * 60_000), claimedAt: ago((minutesAgo + 2) * 60_000), finishedAt: ago(minutesAgo * 60_000), runId: `smoke-${scope}` });
  return { req, row: smokeSnap(req, scope, KEY, [{ ok: true }, { ok }], ago(minutesAgo * 60_000)) };
}

describe("time", () => {
  it("relTime reads both directions and never says 0m", () => {
    expect(relTime(ago(5 * 60_000).toISOString(), now)).toBe("5m ago");
    expect(relTime(ago(3 * HOUR + 12 * 60_000).toISOString(), now)).toBe("3h 12m ago");
    expect(relTime(new Date(now + 4 * DAY + 2 * HOUR).toISOString(), now)).toBe("in 4d 2h");
    expect(relTime(ago(20_000).toISOString(), now)).toBe("just now");
    expect(relTime(new Date(now + 20_000).toISOString(), now)).toBe("in under a minute");
  });
  it("relTime is empty for a missing or invalid date", () => {
    expect(relTime(null, now)).toBe("");
    expect(relTime(undefined, now)).toBe("");
    expect(relTime("not-a-date", now)).toBe("");
  });
  it("fmtUtc and fmtUtcStamp are UTC whatever the host zone is", () => {
    expect(fmtUtc("2026-11-30T06:00:00.000Z")).toBe("Mon 30 Nov 06:00 UTC");
    expect(fmtUtc("2026-12-02T07:00:00+02:00")).toBe("Wed 2 Dec 05:00 UTC");
    expect(fmtUtcStamp("2026-01-05T23:07:59.000Z")).toBe("2026-01-05 23:07 UTC");
    for (const bad of [null, undefined, "", "nope"]) {
      expect(fmtUtc(bad)).toBe("—");
      expect(fmtUtcStamp(bad)).toBe("—");
    }
  });
  it("fmtTook", () => {
    expect(fmtTook("2026-11-25T12:00:00Z", "2026-11-25T12:00:42Z")).toBe("42s");
    expect(fmtTook("2026-11-25T12:00:00Z", "2026-11-25T12:03:05Z")).toBe("3m 05s");
    expect(fmtTook("2026-11-25T12:00:00Z", "2026-11-25T13:04:00Z")).toBe("1h 4m");
    expect(fmtTook("2026-11-25T12:00:00Z", "2026-11-25T11:00:00Z")).toBe("—");
    expect(fmtTook("x", "y")).toBe("—");
  });
});

describe("cronLabel", () => {
  it("leads with the plain words and keeps the expression next to them", () => {
    const row = overviewOf().schedule.rows.find((r) => r.job === "plan")!;
    expect(cronLabel(row)).toEqual({ text: "weekly on Monday at 06:00 UTC", raw: "0 6 * * 1", error: null });
  });
  it("shows only the expression when the server could not put it in words", () => {
    expect(cronLabel({ cron: "5 4 1-7 * 2", cronText: "5 4 1-7 * 2", cronError: null })).toEqual({ text: "5 4 1-7 * 2", raw: null, error: null });
  });
  it("carries a cron error instead of pretending it is a schedule", () => {
    expect(cronLabel({ cron: "bogus", cronText: "bogus", cronError: 'cron "bogus": expected 5 fields' })).toEqual({ text: "bogus", raw: null, error: 'cron "bogus": expected 5 fields' });
  });
});

describe("words", () => {
  it("every word the tab can show is in the closed vocabulary, and none is ember except the human gate", () => {
    const words = [
      ...Object.values(SEVERITY_WORD),
      ...["pending", "claimed", "done", "failed", "expired", "weird"].map(requestWord),
      ...(Object.keys(PREVIEW_STATE_LABEL) as PreviewState[]).map(previewStateWord),
      ...(["none", "running", "pass", "fail"] as const).map(verdictWord),
      ...(["ready", "building", "failed"] as const).map(envBuildWord),
      advisoryWord({ kev: 1, highest: "low" }),
    ];
    for (const w of words) expect(STATUS_WORDS).toContain(w);
    expect(words.filter((w) => toneOf(w) === "ember")).toEqual(["AWAITING HUMAN"]);
    expect(previewStateWord("awaiting-signoff")).toBe("AWAITING HUMAN");
  });
  it("a severity is its own word; critical, high and KEV are fail-toned", () => {
    expect(SEVERITY_WORD).toEqual({ critical: "CRITICAL", high: "HIGH", moderate: "MODERATE", low: "LOW", unknown: "UNKNOWN" });
    for (const w of ["CRITICAL", "HIGH", "KEV"] as const) expect(toneOf(w)).toBe("fail");
    expect(toneOf("MODERATE")).toBe("pending");
    expect(toneOf("LOW")).toBe("muted");
  });
  it("KEV beats any severity", () => {
    expect(advisoryWord({ kev: true, severity: "low" })).toBe("KEV");
    expect(advisoryWord({ kev: 0, highest: "critical" })).toBe("CRITICAL");
    expect(advisoryWord({ kev: false, highest: null })).toBe("UNKNOWN");
  });
  it("every component status has plain words and a place in the urgency order", () => {
    expect([...STATUS_URGENCY].sort()).toEqual(Object.keys(STATUS_TEXT).sort());
    expect(STATUS_URGENCY[0]).toBe("failed");
  });
  it("requestWord / requestText", () => {
    expect(["pending", "claimed", "done", "failed", "expired", "??"].map(requestWord)).toEqual(["PENDING", "RUNNING", "PASS", "FAIL", "EXPIRED", "UNKNOWN"]);
    const base = { requestedBy: "nick", createdAt: ago(10 * 60_000).toISOString(), error: null };
    expect(requestText({ ...base, status: "pending" }, now)).toBe("requested by nick 10m ago · waiting for plo-dispatch (runs every 5 minutes)");
    expect(requestText({ ...base, status: "failed", error: "boom" }, now)).toBe("requested by nick 10m ago · failed: boom");
    expect(requestText({ ...base, status: "expired" }, now)).toContain("never claimed");
    // server clock a moment ahead of the page: still "just now", never "in …"
    expect(requestText({ ...base, createdAt: new Date(now + 4_000).toISOString(), status: "pending" }, now)).toContain("requested by nick just now");
  });
  it("stepper: done/current/failed/todo have a word, skipped has none", () => {
    expect((["done", "current", "failed", "todo", "skipped"] as const).map(stepWord)).toEqual(["PASS", "RUNNING", "FAIL", "PLANNED", null]);
  });
  it("the current step waits for a person where the state says so", () => {
    const cur = { key: "awaiting-signoff", label: "Awaiting sign-off", status: "current" } as const;
    expect(currentStepWord(cur, "awaiting-signoff")).toBe("AWAITING HUMAN");
    expect(currentStepWord({ key: "bundle-ready", label: "Bundle ready", status: "current" }, "bundle-ready")).toBe("PASS"); // reached, not in progress
    expect(currentStepWord({ key: "preview-requested", label: "Preview requested", status: "current" }, "preview-requested")).toBe("RUNNING");
    expect(currentStepWord({ key: "smoke-preview", label: "Preview smoke", status: "failed" }, "smoke-preview-fail")).toBe("FAIL");
    expect(currentStepWord({ key: "bundle-ready", label: "Bundle ready", status: "done" }, "awaiting-signoff")).toBe("PASS");
  });
  it("tabs", () => {
    expect(LIFECYCLE_TABS.map((t) => TAB_LABEL[t])).toEqual(["Schedule", "Environments", "Tiers", "Advisories", "Preview", "History"]);
  });
});

describe("versions and risk", () => {
  it("versionChange drops what adds nothing", () => {
    expect(versionChange({ current: "1.0.0", desired: "1.1.0", latest: "2.0.0" })).toEqual({ from: "1.0.0", to: "1.1.0", latest: "2.0.0" });
    expect(versionChange({ current: "1.0.0", desired: "1.1.0", latest: "1.1.0" })).toEqual({ from: "1.0.0", to: "1.1.0", latest: null });
    expect(versionChange({ current: "1.0.0", desired: null, latest: "1.0.0" })).toEqual({ from: "1.0.0", to: null, latest: null });
    expect(versionChange({ current: "1.0.0", desired: "1.0.0", latest: "3.0.0" })).toEqual({ from: "1.0.0", to: null, latest: "3.0.0" });
  });
  it("epssPct", () => {
    expect(epssPct(0.92)).toBe("92%");
    expect(epssPct(0.0423)).toBe("4.2%");
    expect(epssPct(0.0004)).toBe("<0.1%");
    expect(epssPct(0)).toBe("0.0%");
    expect(epssPct(undefined)).toBe("—");
  });
  it("eolNote: past, soon, later, undated, untracked", () => {
    expect(eolNote(undefined, now)).toBeNull();
    expect(eolNote({ eol: true, date: "2025-04-30" }, now)).toEqual({ word: "EXPIRED", text: "end of life since 2025-04-30" });
    expect(eolNote({ eol: true }, now)).toEqual({ word: "EXPIRED", text: "end of life" });
    expect(eolNote({ eol: false, date: "2026-01-01" }, now)?.word).toBe("EXPIRED"); // the date passed even though the flag lags
    expect(eolNote({ eol: false, date: "2026-12-25" }, now)).toEqual({ word: "EXPIRING", text: "end of life on 2026-12-25 (in 30 days)" });
    expect(eolNote({ eol: false, date: "2026-11-26" }, now)?.text).toBe("end of life on 2026-11-26 (in 1 day)");
    expect(eolNote({ eol: false, date: "2028-04-30" }, now)).toEqual({ word: null, text: "supported until 2028-04-30" });
    expect(eolNote({ eol: false }, now)).toEqual({ word: null, text: "supported (no end-of-life date known)" });
    expect(eolNote({ eol: false, date: "garbage" }, now)?.word).toBeNull();
  });
  it("isProdEnv", () => {
    for (const n of ["prod", "production", "Prod", "moly-prod", "prod-shift4"]) expect(isProdEnv(n)).toBe(true);
    for (const n of ["staging", "preview", "nonprod", "product"]) expect(isProdEnv(n)).toBe(false);
  });
  it("shortSha / shortTag", () => {
    expect(shortSha(SHA_SENTINEL)).toBe(SHA_SENTINEL.slice(0, 7));
    expect(shortSha(null)).toBe("—");
    expect(shortTag(null)).toBe("(no tag)");
    expect(shortTag("main-abc")).toBe("main-abc");
    expect(shortTag(`nb-plo-2611-twizz-sentinel-${"a".repeat(40)}`)).toHaveLength(35);
  });
});

describe("tiers: filter, sort, summarise", () => {
  const o = overviewOf();
  const rows = allRows(o);

  it("the default view keeps what needs attention — including an up-to-date component with an advisory", () => {
    const kept = filterComponents(rows, DEFAULT_COMPONENT_FILTER).map((c) => c.id).sort();
    // zod is current but has a (low) advisory; lodash is current but KEV-affected
    expect(kept).toEqual(["backend:image:node", "prod:eks:control-plane", "sentinel:npm:express", "sentinel:npm:lodash", "sentinel:npm:zod", "staging:eks:control-plane"]);
    const lodash = rows.find((c) => c.id === "sentinel:npm:lodash")!;
    expect(lodash.actionable).toBe(false);
    expect(needsAttention(lodash)).toBe(true);
  });
  it("a current component without advisories is hidden by default and shown when the toggle is off", () => {
    const clean = overviewOf([planSnap([component("a:npm:ok", { status: "current", bump: "none" }), component("a:npm:old")]), cveSnap([])]);
    const all = allRows(clean);
    expect(filterComponents(all, DEFAULT_COMPONENT_FILTER).map((c) => c.id)).toEqual(["a:npm:old"]);
    expect(filterComponents(all, { ...DEFAULT_COMPONENT_FILTER, actionableOnly: false })).toHaveLength(2);
  });
  it("filters by environment, status and text, combined", () => {
    const off = { ...DEFAULT_COMPONENT_FILTER, actionableOnly: false };
    expect(filterComponents(rows, { ...off, environment: "prod" }).map((c) => c.id).sort()).toEqual(["backend:image:node", "prod:eks:control-plane", "sentinel:npm:express", "sentinel:npm:lodash"]);
    expect(filterComponents(rows, { ...off, status: "current" }).map((c) => c.name).sort()).toEqual(["lodash", "zod"]);
    expect(filterComponents(rows, { ...off, text: "  KUBERN " })).toHaveLength(2);
    expect(filterComponents(rows, { ...off, text: "eks-moly-prod" }).map((c) => c.id)).toEqual(["prod:eks:control-plane"]);
    expect(filterComponents(rows, { ...off, environment: "prod", status: "outdated", text: "kube" }).map((c) => c.id)).toEqual(["prod:eks:control-plane"]);
    expect(filterComponents(rows, { ...off, environment: "nowhere" })).toEqual([]);
  });
  it("sortByRisk puts known-exploited first, then severity, then end of life, and is stable", () => {
    const npm = o.tiers.find((t) => t.tier === "npm-direct")!.components;
    expect(sortByRisk(npm).map((c) => c.name)).toEqual(["lodash", "express", "zod"]);
    const noRisk = allRows(overviewOf([planSnap(), cveSnap([])])).filter((c) => c.tier === "npm-direct");
    expect(sortByRisk(noRisk).map((c) => c.id)).toEqual(noRisk.map((c) => c.id));
  });
  it("tierSummary counts everything, most urgent first, zeros dropped", () => {
    const npm = o.tiers.find((t) => t.tier === "npm-direct")!;
    expect(tierSummary(npm)).toBe("3 components · 1 upgrade PR open · 2 up to date · 4 advisories");
    const cp = o.tiers.find((t) => t.tier === "control-plane")!;
    expect(tierSummary(cp)).toBe("2 components · 1 awaiting approval · 1 outdated");
    expect(tierSummary(o.tiers.find((t) => t.tier === "helm")!)).toBe("nothing reported for this tier");
    const one = overviewOf([planSnap([component("a:npm:x")])]).tiers.find((t) => t.tier === "npm-direct")!;
    expect(tierSummary(one)).toBe("1 component · 1 outdated");
  });
  it("tierWord is the most urgent thing in the tier", () => {
    const word = (tier: string) => tierWord(o.tiers.find((t) => t.tier === tier)!);
    expect(word("base-images")).toBe("FAIL");
    expect(word("control-plane")).toBe("AWAITING HUMAN");
    // (external review 2026-11-25, idp #14) was RUNNING: the tier carries a known-exploited / high advisory,
    // which outranks "an upgrade PR is open"
    expect(word("npm-direct")).toBe("WATCH");
    expect(word("helm")).toBe("UNKNOWN");
    const fine = overviewOf([planSnap([component("a:npm:ok", { status: "current" })])]).tiers.find((t) => t.tier === "npm-direct")!;
    expect(tierWord(fine)).toBe("OK");
    // every component "current", and yet: never green with an advisory in the tier
    const counts = { ...fine.counts };
    expect(tierWord({ total: 3, actionable: 0, counts, advisories: 0, kev: 0, highestSeverity: null })).toBe("OK");
    expect(tierWord({ total: 3, actionable: 0, counts, advisories: 1, kev: 1, highestSeverity: "low" })).toBe("WATCH");
    expect(tierWord({ total: 3, actionable: 0, counts, advisories: 1, kev: 0, highestSeverity: "critical" })).toBe("WATCH");
    expect(tierWord({ total: 3, actionable: 0, counts, advisories: 2, kev: 0, highestSeverity: "moderate" })).toBe("WATCH");
    expect(tierWord({ total: 3, actionable: 1, counts: { ...counts, "pr-open": 1 }, advisories: 0, kev: 0, highestSeverity: null })).toBe("RUNNING");
    expect(tierWord({ total: 3, actionable: 1, counts: { ...counts, failed: 1 }, advisories: 5, kev: 2, highestSeverity: "critical" })).toBe("FAIL");
    // advisories filed under a tier nothing was reported for are not "unknown"
    expect(tierWord({ total: 0, actionable: 0, counts, advisories: 1, kev: 0, highestSeverity: "high" })).toBe("WATCH");
  });
});

describe("advisories: filter", () => {
  const view = buildAdvisories(selectSnapshots([planSnap(), cveSnap()]), NOW);
  const ids = (f: Partial<typeof DEFAULT_ADVISORY_FILTER>) => filterAdvisories(view.advisories, { ...DEFAULT_ADVISORY_FILTER, ...f }).map((a) => a.id);

  it("keeps the server's order (KEV first) when nothing is filtered", () => {
    expect(ids({})).toEqual(["CVE-2026-1000", "CVE-2026-2000", "GHSA-mod-0002", "GHSA-low-0001"]);
  });
  it("severity, KEV-only and text (id, alias or package)", () => {
    expect(ids({ severity: "critical" })).toEqual(["CVE-2026-2000"]);
    expect(ids({ kevOnly: true })).toEqual(["CVE-2026-1000"]);
    expect(ids({ text: "ghsa-kev" })).toEqual(["CVE-2026-1000"]);
    expect(ids({ text: "EXPRESS" })).toEqual(["CVE-2026-2000", "GHSA-mod-0002"]);
    expect(ids({ text: "nothing-like-this" })).toEqual([]);
  });
  it("tier and environment must hold for the same affected component", () => {
    expect(ids({ tier: "base-images" })).toEqual(["CVE-2026-2000"]);
    expect(ids({ environment: "prod" })).toEqual(["CVE-2026-1000", "CVE-2026-2000"]);
    // CVE-2026-2000 is base-image on prod and npm-direct on staging — not npm-direct on prod
    expect(ids({ tier: "npm-direct", environment: "prod" })).toEqual(["CVE-2026-1000"]);
    expect(ids({ tier: "base-images", environment: "staging" })).toEqual([]);
  });
  it("new-only compares with the previous scan", () => {
    const prev = cveSnap(ADVISORIES.filter((a) => a.id !== "CVE-2026-2000"), ago(26 * HOUR));
    const v = buildAdvisories(selectSnapshots([planSnap(), prev, cveSnap()]), NOW);
    expect(filterAdvisories(v.advisories, { ...DEFAULT_ADVISORY_FILTER, newOnly: true }).map((a) => a.id)).toEqual(["CVE-2026-2000"]);
    expect(ids({ newOnly: true })).toEqual([]); // a first scan has nothing to compare with
  });
  it("advisoriesForComponent / advisoryEnvironments", () => {
    expect(advisoriesForComponent(view.advisories, "sentinel:npm:express").map((a) => a.id)).toEqual(["CVE-2026-2000", "GHSA-mod-0002"]);
    expect(advisoriesForComponent(view.advisories, "nope")).toEqual([]);
    expect(advisoryEnvironments(view.advisories.find((a) => a.id === "CVE-2026-2000")!)).toEqual(["prod", "staging"]);
  });
  it("the severity filter list covers every severity", () => {
    expect([...SEVERITIES].sort()).toEqual(Object.keys(SEVERITY_WORD).sort());
  });
});

describe("stale and empty states", () => {
  it("staleNote says nothing when fresh or when there is no data at all", () => {
    const o = overviewOf();
    expect(staleNote("plan", o.stale.plan, now)).toBeNull();
    expect(staleNote("cve", overviewOf([]).stale.cve, now)).toBeNull();
  });
  it("staleNote names the job, the age and where to refresh it", () => {
    const o = overviewOf([planSnap(COMPONENTS, ago(9 * DAY)), cveSnap(ADVISORIES, ago(40 * HOUR))]);
    expect(staleNote("plan", o.stale.plan, now)).toBe("Plan data may be out of date: plan data is older than 8 days (finished 9d 0h ago). Request a new run on the Schedule tab.");
    expect(staleNote("cve", o.stale.cve, now)).toContain("CVE data may be out of date: cve data is older than 36 h (finished 1d 16h ago)");
  });
  it("before any snapshot: each job, what it fills and when it runs next", () => {
    const o = overviewOf([]);
    expect(hasAnySnapshot(o)).toBe(false);
    const lines = emptyStateLines(o);
    expect(lines.map((l) => l.job)).toEqual(["plan", "cve", "source"]);
    expect(lines[0]).toMatchObject({ cronText: "weekly on Monday at 06:00 UTC", nextRun: "2026-11-30T06:00:00.000Z" });
    expect(lines[1]).toMatchObject({ cronText: "daily at 05:30 UTC", nextRun: "2026-11-26T05:30:00.000Z" });
    expect(lines[2]).toMatchObject({ cronText: "monthly on the 2nd at 07:00 UTC", nextRun: "2026-12-02T07:00:00.000Z" });
    for (const l of lines) expect(l.fills.length).toBeGreaterThan(10);
  });
  it("once a job has reported it is no longer listed as missing", () => {
    const o = overviewOf([cveSnap()]);
    expect(hasAnySnapshot(o)).toBe(true);
    expect(emptyStateLines(o).map((l) => l.job)).toEqual(["plan", "source"]);
  });
});

describe("headerTiles", () => {
  const tile = (tiles: ReturnType<typeof headerTiles>, key: string) => tiles.find((t) => t.key === key)!;

  it("summarises outdated, critical/high, KEV, the bundle and data age, each linked to its tab", () => {
    const tiles = headerTiles(overviewOf(), { state: "bundle-ready", detail: "the bundle is built — create the preview", key12: KEY.slice(0, 12) }, now);
    expect(tiles.map((t) => t.key)).toEqual(["outdated", "critical-high", "kev", "bundle", "plan-age", "cve-age"]);
    expect(tile(tiles, "outdated")).toMatchObject({ word: "PENDING", value: "1", detail: "of 6 components · 6 need attention", tab: "tiers" });
    expect(tile(tiles, "critical-high")).toMatchObject({ word: "HOT", value: "2", tab: "advisories" });
    expect(tile(tiles, "kev")).toMatchObject({ word: "KEV", value: "1", tab: "advisories" });
    expect(tile(tiles, "bundle")).toMatchObject({ word: "PENDING", value: "bundle ready", label: `bundle ${KEY.slice(0, 12)}`, tab: "preview" });
    expect(tile(tiles, "plan-age")).toMatchObject({ word: "OK", value: "1d 0h ago", tab: "schedule" });
    expect(tile(tiles, "cve-age")).toMatchObject({ word: "OK", value: "2h 0m ago" });
    for (const t of tiles) expect(STATUS_WORDS).toContain(t.word);
  });
  it("says UNKNOWN, never 0, before the first snapshot", () => {
    const tiles = headerTiles(overviewOf([]), { state: "no-bundle", detail: "no source run has reported yet", key12: null }, now);
    expect(tile(tiles, "outdated")).toMatchObject({ word: "UNKNOWN", value: "—" });
    expect(tile(tiles, "critical-high")).toMatchObject({ word: "UNKNOWN", value: "—" });
    expect(tile(tiles, "kev")).toMatchObject({ word: "UNKNOWN", value: "—" });
    expect(tile(tiles, "bundle")).toMatchObject({ word: "PLANNED", value: "no bundle", label: "bundle" });
    expect(tile(tiles, "plan-age")).toMatchObject({ word: "UNKNOWN", value: "never" });
  });
  it("all clear reads OK", () => {
    const tiles = headerTiles(overviewOf([planSnap([component("a:npm:ok", { status: "current" })]), cveSnap([])]), null, now);
    expect(tile(tiles, "outdated")).toMatchObject({ word: "OK", value: "0" });
    expect(tile(tiles, "critical-high").word).toBe("OK");
    expect(tile(tiles, "kev").word).toBe("OK");
    expect(tile(tiles, "bundle")).toMatchObject({ word: "PENDING", value: "…" });
  });
  it("stale data and an unreadable bundle are shown as such", () => {
    const tiles = headerTiles(overviewOf([planSnap(COMPONENTS, ago(9 * DAY)), cveSnap()]), { error: "GitHub 502" }, now);
    expect(tile(tiles, "plan-age")).toMatchObject({ word: "WATCH", value: "9d 0h ago" });
    expect(tile(tiles, "bundle")).toMatchObject({ word: "UNKNOWN", value: "unreadable", detail: "GitHub 502" });
  });
});

describe("nextAction: the one thing to do", () => {
  const o = overviewOf([planSnap(), cveSnap(), source()]);
  const next = (p: LifecyclePreview | null, overview = o, previewError: string | null = null) => nextAction({ overview, preview: p, previewError });

  it("before any snapshot: wait, and say which job runs first", () => {
    const n = next(previewOf({ rows: [] }), overviewOf([]));
    expect(n).toMatchObject({ word: "PLANNED", title: "Wait for the first PLO run", tab: "schedule", operatorOnly: false });
    expect(n.detail).toContain("the cve job runs next, Thu 26 Nov 05:30 UTC");
  });
  it("walks the pipeline in order", () => {
    // bundle-ready
    expect(next(previewOf())).toMatchObject({ word: "PENDING", title: `Create the preview for bundle ${KEY.slice(0, 12)}`, tab: "preview", operatorOnly: true });
    // preview-requested (one env still building)
    expect(next(previewOf({ envs: [env(ENV_S, SENTINEL, SHA_SENTINEL), env(ENV_B, BACKEND, SHA_BACKEND, { build: "building", imageTag: null, argo: null })] }))).toMatchObject({ word: "RUNNING", title: "Wait for the preview envs to come up", operatorOnly: false });
    // preview-up
    expect(next(previewOf({ envs: envsUp() }))).toMatchObject({ word: "PENDING", title: "Run the preview smoke", operatorOnly: true });
    // preview smoke in flight
    expect(next(previewOf({ envs: envsUp(), requests: [smokeRequest("preview", KEY)] }))).toMatchObject({ word: "RUNNING", title: "Wait for the preview smoke" });
    // preview smoke failed
    const bad = smoked("preview", false);
    expect(next(previewOf({ envs: envsUp(), requests: [bad.req], rows: [source(), bad.row] }))).toMatchObject({ word: "FAIL", title: "Preview smoke failed: look at the failing checks, then run it again" });
    // preview smoke passed → staging
    const good = smoked("preview", true, 30);
    expect(next(previewOf({ envs: envsUp(), requests: [good.req], rows: [source(), good.row] }))).toMatchObject({ word: "PENDING", title: `Deploy bundle ${KEY.slice(0, 12)} to staging`, operatorOnly: true });
    // promotion PR open → merge on /releases
    const promotions = [{ service: "twizz-sentinel", imageTag: TAG_S, number: 77, url: "https://github.com/TwizzyNicky/twizz-gitops/pull/77", headSha: "d".repeat(40) }];
    expect(next(previewOf({ envs: envsUp(), requests: [good.req], rows: [source(), good.row], promotions }))).toMatchObject({ word: "AWAITING HUMAN", title: "Merge the staging promotion on the release train", href: "/releases" });
    // staging runs the bundle → staging smoke
    expect(next(previewOf({ envs: envsUp(), requests: [good.req], rows: [source(), good.row], staging: stagingOn(TAG_S) }))).toMatchObject({ word: "PENDING", title: "Run the staging smoke" });
    // staging smoke in flight
    expect(next(previewOf({ envs: envsUp(), requests: [good.req, smokeRequest("stg", KEY)], rows: [source(), good.row], staging: stagingOn(TAG_S) }))).toMatchObject({ word: "RUNNING", title: "Wait for the staging smoke" });
    // staging smoke failed
    const stgBad = smoked("stg", false, 5);
    expect(next(previewOf({ envs: envsUp(), requests: [good.req, stgBad.req], rows: [source(), good.row, stgBad.row], staging: stagingOn(TAG_S) }))).toMatchObject({ word: "FAIL", title: "Staging smoke failed: look at the failing checks, then run it again" });
    // staging smoke passed → the human gate
    const stgGood = smoked("stg", true, 5);
    const ready = previewOf({ envs: envsUp(), requests: [good.req, stgGood.req], rows: [source(), good.row, stgGood.row], staging: stagingOn(TAG_S) });
    expect(ready.state).toBe("awaiting-signoff");
    expect(next(ready)).toMatchObject({ word: "AWAITING HUMAN", title: `Sign off bundle ${KEY.slice(0, 12)}`, tab: "preview", operatorOnly: true });
    // signed off → GitHub
    const signed = previewOf({ envs: envsUp(), requests: [good.req, stgGood.req], rows: [source(), good.row, stgGood.row], staging: stagingOn(TAG_S), signoffs: [{ bundleKey: KEY, actor: "nick", at: ago(60_000) }] });
    expect(next(signed)).toMatchObject({ word: "PASS", title: "Merge the bundled pull requests in GitHub", operatorOnly: false });
  });
  it("a bundle nothing can act on is reported as held back, with the first blocker", () => {
    const stuck = previewOf({ envs: null, sourceErrors: ["named envs could not be read: GitHub 502"] });
    expect(next(stuck)).toMatchObject({ word: "WATCH", title: "The bundle is held back", detail: "named envs could not be read: GitHub 502" });
  });
  it("with no bundle in flight the riskiest finding leads: KEV, then critical/high, then stale, then outdated", () => {
    const none = previewOf({ rows: [] });
    const base = overviewOf();
    expect(next(none, base)).toMatchObject({ word: "KEV", title: "Review 1 known-exploited advisory", tab: "advisories" });
    const noKev = overviewOf([planSnap(), cveSnap(ADVISORIES.map((a) => ({ ...a, kev: false })))]);
    expect(next(none, noKev)).toMatchObject({ word: "HOT", title: "Review 2 critical or high advisories", tab: "advisories" });
    const stale = overviewOf([planSnap(COMPONENTS, ago(9 * DAY)), cveSnap([])]);
    expect(next(none, stale)).toMatchObject({ word: "WATCH", title: "Refresh stale data", tab: "schedule", operatorOnly: true });
    const outdated = overviewOf([planSnap(), cveSnap([])]);
    const n = next(none, outdated);
    expect(n).toMatchObject({ word: "PENDING", title: "4 components need attention", tab: "tiers" });
    expect(n.detail).toContain("Wed 2 Dec 07:00 UTC");
    const fine = overviewOf([planSnap([component("a:npm:ok", { status: "current" })]), cveSnap([])]);
    expect(next(none, fine)).toMatchObject({ word: "OK", title: "Nothing to do", tab: null });
  });
  it("an unreadable bundle state is said, not guessed", () => {
    expect(next(null, overviewOf(), "GitHub 502")).toMatchObject({ word: "UNKNOWN", title: "The bundle state could not be read", detail: "GitHub 502", tab: "preview" });
  });
  it("only ever uses brand words", () => {
    for (const p of [null, previewOf(), previewOf({ rows: [] })]) expect(STATUS_WORDS).toContain(next(p).word);
  });
  it("an in-flight plan request does not change the next action", () => {
    const withReq = overviewOf([planSnap(), cveSnap(), source()], [request("plan")]);
    expect(next(previewOf(), withReq).title).toBe(`Create the preview for bundle ${KEY.slice(0, 12)}`);
  });
});

// ── external review 2026-11-25, idp #9: nothing from a snapshot becomes a link unless it is https on a host Nebula links to ──
describe("outbound links", () => {
  it("safeExternalHref: https on an allowlisted host or a preview-domain host, nothing else", () => {
    for (const ok of [
      "https://github.com/twizz-app/twizz-sentinel/pull/41",
      "https://osv.dev/vulnerability/GHSA-rv95-896h-c2vc",
      "https://nodejs.org/en/blog/release/v22.11.0",
      "https://plo-2611-twizz-sentinel.prv.twizz.com",
      "https://sentinel-stg.prv.twizz.com/health",
    ]) expect(safeExternalHref(ok), ok).toBe(new URL(ok).href);
    for (const bad of [
      "javascript:alert(1)",
      "JAVASCRIPT:alert(1)",
      "java\nscript:alert(1)",
      "data:text/html;base64,PHNjcmlwdD4=",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "http://github.com/a/b/pull/1",
      "https://evil.example/login",
      "https://github.com.evil.example/",
      "https://github.com@evil.example/",
      "https://x.prv.twizz.com.evil.example/",
      "https://x.prv.twizz.com:8443/",
      "http://x.prv.twizz.com/",
      "https://a.b.prv.twizz.com/",
      "https://twizz.com/",
      "//github.com/x",
      "/lifecycle",
      "",
      null,
      undefined,
      42,
    ]) expect(safeExternalHref(bad), String(bad)).toBeNull();
  });

  it("<Ext> renders an anchor only for a safe target; anything else is plain text — it never throws and never links", () => {
    // vitest compiles the component's JSX with the classic runtime, which expects a global React
    (globalThis as { React?: unknown }).React = React;
    type El = { type: string; props: { href?: string; rel?: string; target?: string; children?: unknown } };
    const render = (href: unknown) => Ext({ href: href as string, children: "#41" }) as unknown as El;
    const link = render("https://github.com/twizz-app/twizz-sentinel/pull/41");
    expect(link.type).toBe("a");
    expect(link.props).toMatchObject({ href: "https://github.com/twizz-app/twizz-sentinel/pull/41", target: "_blank", rel: "noopener noreferrer" });
    for (const bad of ["javascript:alert(document.cookie)", "https://evil.example/login", "data:text/html,x", "", null, undefined]) {
      const out = render(bad);
      expect(out.type, String(bad)).toBe("span");
      expect(out.props.href, String(bad)).toBeUndefined();
      expect(JSON.stringify(out.props.children), String(bad)).toBe('"#41"');
    }
  });
});

describe("environments (the view model)", () => {
  /** PLO's coverage for a full plan; `unread` names environments whose cluster did not answer. `components` claims no
   * row: a count above the rows the snapshot carries reads as rows left out (lifecycle-environments.ts tierCoverage) */
  const coverage = (unread: string[] = []): LifecycleEnvironmentCoverage[] =>
    LIFECYCLE_ENVIRONMENTS.map((e) => ({
      environment: e.name,
      clusters: [...e.clusters],
      tiers: LIFECYCLE_TIERS.map((tier) => {
        const source = ["base-images", "npm-direct", "npm-transitive"].includes(tier);
        if (source) return { tier, state: e.name === "nonprod" ? ("not-applicable" as const) : ("observed" as const), components: 0, gaps: [] };
        return unread.includes(e.name) ? { tier, state: "not-observed" as const, components: 0, gaps: [`${e.clusters[0]}: cluster API not reachable`] } : { tier, state: "observed" as const, components: tier === "control-plane" ? e.clusters.length : 0, gaps: [] }; // a real plan counts one control plane per cluster
      }),
    }));
  const nonprodCp = component("nonprod:eks:control-plane", { tier: "control-plane", name: "kubernetes", target: "EKS-Twizz-NonProd", environments: ["nonprod"], desired: null, bump: "none", status: "current" });
  const envsOf = (unread: string[] = [], history: Parameters<typeof buildEnvironments>[0]["planHistory"] = []) =>
    buildEnvironments({ rows: [snap("plan", ago(DAY), { runId: "plan-now", components: [...COMPONENTS, nonprodCp], coverage: coverage(unread) }), cveSnap()], now: NOW, planHistory: history });
  const one = (view: ReturnType<typeof envsOf>, name: string) => view.environments.find((e) => e.name === name)!;

  it("every state has words, and none of them reads as a status pill word", () => {
    expect(Object.keys(OBSERVATION_TEXT).sort()).toEqual(["not-observed", "observed", "partial", "stale"]);
    expect(Object.keys(COVERAGE_TEXT).sort()).toEqual(["not-applicable", "not-observed", "observed", "partial"]);
    for (const text of [...Object.values(OBSERVATION_TEXT), ...Object.values(COVERAGE_TEXT)]) expect(STATUS_WORDS as readonly string[]).not.toContain(text.toUpperCase());
  });

  it("observationLine leads with the state, and says when an unread environment last WAS read", () => {
    const view = envsOf(["prod"], [{ job: "plan", runId: "plan-old", ok: true, finishedAt: ago(9 * DAY), coverage: coverage() }]);
    expect(observationLine(one(view, "staging"), now)).toBe("observed 1d 0h ago by the plan job");
    expect(observationLine(one(view, "prod"), now)).toBe("not observed by the run shown · last observed 9d 0h ago by the plan job");
    expect(observationLine(one(envsOf(["prod"]), "prod"), now)).toBe("not observed · never read by a run Nebula has");
    expect(observationLine({ kind: "preview", observation: { state: "observed", word: "OK", reasons: [], lastObserved: { at: NOW.toISOString(), job: "live", runId: null } } }, now)).toBe("read live from twizz-gitops and Argo");
  });

  it("the count and advisory lines read the same way down a column, zeros dropped", () => {
    const view = envsOf();
    expect(envCountsLine(one(view, "prod").counts)).toBe("4 components · 1 current · 2 behind · 1 failed · 1 end of life");
    expect(envCountsLine(one(view, "nonprod").counts)).toBe("1 component · 1 current");
    expect(envCountsLine({ total: 0, current: 0, behind: 0, blocked: 0, escalated: 0, failed: 0, unknown: 0, awaitingApproval: 0, eol: 0 })).toBe("no components reported");
    expect(envAdvisoriesLine(one(view, "prod").advisories)).toBe("1 critical · 1 high");
    expect(envSeverityWord(one(view, "prod").advisories)).toBe("CRITICAL");
    expect(envAdvisoriesLine(one(view, "nonprod").advisories)).toBe("none open");
    expect(envSeverityWord(one(view, "nonprod").advisories)).toBeNull();
    const noScan = { scanned: false, total: 0, kev: 0, counts: { critical: 0, high: 0, moderate: 0, low: 0, unknown: 0 }, gaps: [] };
    // a scan that could not read all of the environment found none; it does not know there is none
    expect(envAdvisoriesLine({ ...noScan, scanned: true, gaps: ["EKS-Moly-Prod: cluster API not reachable"] })).toBe("none found · the scan did not cover all of it");
    expect(envAdvisoriesLine({ ...one(view, "prod").advisories, gaps: ["x"] })).toBe("1 critical · 1 high · the scan did not cover all of it");
    expect(envAdvisoriesLine(noScan)).toBe("no CVE scan yet");
    expect(envSeverityWord(noScan)).toBeNull();
  });

  // second review round 2026-11-25, #10.3: the banner said "OK — Nothing to do" over an unread prod
  it("nextAction never says Nothing to do over an environment that was not read, read in part, or not OK", () => {
    const clean = [component("eks-control-plane:EKS-Twizz-NonProd", { tier: "control-plane", domain: "eks-control-plane", name: "control-plane", target: "EKS-Twizz-NonProd", environments: ["nonprod"], status: "current", desired: null, bump: "none" }), component("eks-control-plane:EKS-Moly-staging", { tier: "control-plane", domain: "eks-control-plane", name: "control-plane", target: "EKS-Moly-staging", environments: ["staging"], status: "current", desired: null, bump: "none" })];
    const prodCp = component("eks-control-plane:EKS-Moly-Prod", { tier: "control-plane", domain: "eks-control-plane", name: "control-plane", target: "EKS-Moly-Prod", environments: ["prod"], status: "current", desired: null, bump: "none" });
    const rows = (unread: string[], components = [...clean, prodCp], cveDoc = {}) => [snap("plan", ago(DAY), { runId: "plan-now", components, coverage: coverage(unread) }), snap("cve", ago(2 * HOUR), { runId: "cve-now", advisories: [], ...cveDoc })];
    const act = (r: ReturnType<typeof rows>, environments?: Parameters<typeof nextAction>[0]["environments"]) =>
      nextAction({ overview: buildOverview({ rows: r, requests: [], now: NOW }), preview: null, environments: environments === undefined ? buildEnvironments({ rows: r, now: NOW, planHistory: [] }) : environments });
    // control: everything read and current
    expect(act(rows([]))).toMatchObject({ word: "OK", title: "Nothing to do" });
    // prod's cluster did not answer: the overview alone has nothing to complain about
    const blind = rows(["prod"], clean);
    expect(nextAction({ overview: buildOverview({ rows: blind, requests: [], now: NOW }), preview: null })).toMatchObject({ word: "OK" });
    expect(act(blind)).toMatchObject({ word: "UNKNOWN", title: "prod was not observed", tab: "environments" });
    // the CVE scan missed prod: read, current, and still not "nothing to do"
    const gap = act(rows([], undefined, { discoveryErrors: [{ domain: "helm-release", error: "EKS-Moly-Prod: cluster API not reachable" }] }));
    expect(gap).toMatchObject({ word: "WATCH", title: "Look at prod", tab: "environments" });
    // the environments part itself could not be read
    expect(act(rows([]), { error: "database unreachable" })).toMatchObject({ word: "UNKNOWN", title: "The environments could not be read", tab: "environments" });
  });

  it("the detail opens on the environment that is least known or worst off, never on a healthy one", () => {
    expect(defaultEnvironment(envsOf(["nonprod"]))).toBe("nonprod"); // not observed beats a failed upgrade elsewhere
    expect(defaultEnvironment(envsOf())).toBe("prod"); // FAIL (the end-of-life base image) beats AWAITING HUMAN
    expect(defaultEnvironment({ environments: [] })).toBeNull();
  });

  it("the environment filter always offers the fixed environments, plus what the data and the focus name", () => {
    const view = envsOf();
    expect(environmentFilterNames(view, ["prod", "staging"])).toEqual(["nonprod", "staging", "prod"]);
    expect(environmentFilterNames(view, ["sandbox"], "plo-2611-x")).toEqual(["nonprod", "staging", "prod", "sandbox", "plo-2611-x"]);
    expect(environmentFilterNames(null, ["staging"], "staging")).toEqual(["staging"]);
  });

  it("the header tile shows how many environments are covered, and its word is the worst observation", () => {
    expect(environmentsTile(envsOf())).toMatchObject({ key: "environments", word: "OK", label: "environments", value: "3 of 3 read", tab: "environments" });
    expect(environmentsTile(envsOf(["prod"]))).toMatchObject({ word: "UNKNOWN", value: "2 of 3 read", detail: "not observed: prod" });
    expect(environmentsTile(null)).toMatchObject({ word: "PENDING", value: "…" });
    expect(environmentsTile({ error: "db down" })).toMatchObject({ word: "UNKNOWN", value: "unreadable", detail: "db down" });
    const tiles = headerTiles(overviewOf(), null, now, envsOf(["prod"]));
    expect(tiles.map((t) => t.key)).toEqual(["outdated", "critical-high", "kev", "environments", "bundle", "plan-age", "cve-age"]);
    for (const t of tiles) expect(toneOf(t.word), t.key).not.toBe("ember");
  });
});

describe("pass 3 #8: no green word over something that was not checked", () => {
  const tile = (tiles: ReturnType<typeof headerTiles>, key: string) => tiles.find((t) => t.key === key)!;
  const current = [component("a:npm:ok", { status: "current", desired: null, bump: "none" })];
  const yesterday = () => snap("cve", ago(25 * HOUR), { runId: "cve-yesterday", advisories: [] });
  const today = () => snap("cve", ago(HOUR), { runId: "cve-today", ok: false, error: "OSV did not answer" });

  it("#8.1 the Preview pane's smoke pill: a pass that is no longer evidence is WATCH with its reason, never PASS", () => {
    const pass = smoked("preview", true);
    const fresh = previewOf({ envs: envsUp(), requests: [pass.req], rows: [source(), pass.row] }).smoke.preview;
    expect(smokePill(fresh)).toEqual({ word: "PASS", detail: "2 of 2 checks passed" });
    // the sentinel env rolled out a minute ago; the smoke was requested fifteen minutes ago
    const stale = previewOf({ envs: [env(ENV_S, SENTINEL, SHA_SENTINEL, { rolledOutAt: ago(60_000).toISOString() }), env(ENV_B, BACKEND, SHA_BACKEND)], requests: [pass.req], rows: [source(), pass.row] }).smoke.preview;
    expect(stale.verdict).toBe("pass");
    expect(smokePill(stale).word).toBe("WATCH");
    expect(smokePill(stale).detail).toMatch(/^2 of 2 checks passed, but that is no longer evidence: plo-2611-twizz-sentinel rolled out at .* after the preview smoke was requested/);
    const failed = smoked("preview", false);
    expect(smokePill(previewOf({ envs: envsUp(), requests: [failed.req], rows: [source(), failed.row] }).smoke.preview)).toEqual({ word: "FAIL", detail: "1 of 2 checks failed" });
    expect(smokePill(previewOf().smoke.preview).word).toBe("PLANNED");
  });

  it("#8.2 advisories: a newer scan that failed, a failed scan and unanswered sources are never 'OK — none'", () => {
    const clean = buildAdvisories(selectSnapshots([planSnap(current), cveSnap([])]), NOW);
    expect(clean).toMatchObject({ lastFailed: null, stale: { word: "OK" } });
    expect(advisoriesEmptyLine(clean)).toEqual({ word: "OK", text: "No known advisory affects anything in the inventory." });
    const newerFailed = buildAdvisories(selectSnapshots([planSnap(current), yesterday(), today()]), NOW);
    expect(newerFailed.scan).toMatchObject({ runId: "cve-yesterday", ok: true });
    expect(newerFailed.lastFailed).toMatchObject({ runId: "cve-today", error: "OSV did not answer" });
    expect(newerFailed.stale).toMatchObject({ word: "WATCH", detail: "the latest cve run (cve-today) failed: OSV did not answer; showing run cve-yesterday from before it" });
    expect(advisoriesEmptyLine(newerFailed)).toEqual({ word: "WATCH", text: "None found by the scan shown — but the latest scan (cve-today) failed, so what has changed since is not known." });
    const failedScan = buildAdvisories(selectSnapshots([planSnap(current), snap("cve", ago(HOUR), { runId: "cve-bad", ok: false, error: "x", advisories: [] })]), NOW);
    expect(advisoriesEmptyLine(failedScan)).toMatchObject({ word: "WATCH", text: expect.stringMatching(/the scan itself failed/) });
    const gaps = buildAdvisories(selectSnapshots([planSnap(current), snap("cve", ago(HOUR), { advisories: [], discoveryErrors: [{ domain: "kev", error: "CISA KEV could not be fetched" }] })]), NOW);
    expect(advisoriesEmptyLine(gaps)).toMatchObject({ word: "WATCH", text: expect.stringMatching(/1 source did not answer/) });
    // the overview carries the same staleness: the header and the banner read it
    expect(overviewOf([planSnap(current), yesterday(), today()]).stale.cve.word).toBe("WATCH");
  });

  it("#8.3 header tiles: zero is green only when the run behind it is good", () => {
    const tilesOf = (rows: Parameters<typeof overviewOf>[0]) => headerTiles(overviewOf(rows), null, now);
    const ok = tilesOf([planSnap(current), cveSnap([])]);
    expect([tile(ok, "outdated").word, tile(ok, "critical-high").word, tile(ok, "kev").word]).toEqual(["OK", "OK", "OK"]);
    for (const [name, cveRows] of [
      ["a newer scan failed", [yesterday(), today()]],
      ["the scan shown failed", [snap("cve", ago(HOUR), { ok: false, error: "x", advisories: [] })]],
      ["a source did not answer", [snap("cve", ago(HOUR), { advisories: [], discoveryErrors: [{ domain: "kev", error: "CISA KEV could not be fetched" }] })]],
      ["the scan is stale", [snap("cve", ago(3 * DAY), { advisories: [] })]],
    ] as const) {
      const t = tilesOf([planSnap(current), ...cveRows]);
      expect(tile(t, "critical-high"), name).toMatchObject({ word: "WATCH", value: "0" });
      expect(tile(t, "kev"), name).toMatchObject({ word: "WATCH", value: "0" });
      expect(tile(t, "kev").detail, name).toMatch(/^none found — /);
      expect(tile(t, "kev").detail, name).not.toMatch(/nothing here is in CISA/);
    }
    // a finding still leads: a count above zero keeps its own word
    const hot = tilesOf([planSnap(), cveSnap(ADVISORIES, ago(3 * DAY))]);
    expect([tile(hot, "critical-high").word, tile(hot, "kev").word]).toEqual(["HOT", "KEV"]);
    // outdated: 0 outdated is not OK over a failed upgrade, an unassessed component or a failed plan
    for (const status of ["failed", "blocked", "escalated", "unknown"] as const) expect(tile(tilesOf([planSnap([component("a:npm:x", { status })]), cveSnap([])]), "outdated"), status).toMatchObject({ word: "WATCH", value: "0" });
    expect(tile(tilesOf([snap("plan", ago(DAY), { ok: false, error: "aws: expired token", components: current }), cveSnap([])]), "outdated")).toMatchObject({ word: "WATCH", value: "0" });
    expect(tile(tilesOf([snap("plan", ago(2 * DAY), { runId: "plan-old", components: current }), snap("plan", ago(HOUR), { runId: "plan-new", ok: false, error: "x" }), cveSnap([])]), "outdated")).toMatchObject({ word: "WATCH", value: "0" });
    for (const t of [...ok, ...hot]) expect(STATUS_WORDS).toContain(t.word);
  });

  it("#8.4 nextAction: a failed source run is not 'Nothing to do'", () => {
    const next = (rows: Parameters<typeof overviewOf>[0]) => nextAction({ overview: overviewOf(rows), preview: null });
    expect(next([planSnap(current), cveSnap([])])).toMatchObject({ word: "OK", title: "Nothing to do" });
    const failedSource = snap("source", ago(HOUR), { runId: "source-bad", ok: false, error: "frontend: npm ci failed" });
    expect(next([planSnap(current), cveSnap([]), failedSource])).toMatchObject({ word: "WATCH", title: "The last source run failed", detail: expect.stringContaining("source-bad"), tab: "schedule" });
    // an older good run with a newer failed one: the bundle shown is last month's
    const good = snap("source", ago(3 * DAY), { runId: "source-good" });
    expect(next([planSnap(current), cveSnap([]), good, failedSource])).toMatchObject({ word: "WATCH", title: "The last source run failed", detail: expect.stringContaining("frontend: npm ci failed") });
    expect(next([planSnap(current), cveSnap([]), good])).toMatchObject({ word: "OK" });
    // the same with the bundle state read (a failed run has no bundle to act on)
    const p = buildPreview({ rows: [failedSource], requests: [], services: SERVICES, envs: [], promotions: [], staging: stagingOn(null), signoffs: [], envChanges: [], now: NOW });
    expect(nextAction({ overview: overviewOf([planSnap(current), cveSnap([]), failedSource]), preview: p })).toMatchObject({ word: "WATCH", title: "The last source run failed" });
  });
});
