import * as React from "react";
import { Ext } from "@/components/lifecycle/parts";
import { describe, expect, it } from "vitest";
import { STATUS_WORDS, toneOf } from "../status";
import { buildAdvisories, buildOverview, buildPreview, selectSnapshots, type LifecycleServiceInput, type PreviewInput, type StagingTargetInput } from "@/server/nebula/lifecycle-model";
import { DAY, HOUR, KEY, NOW, SHA_BACKEND, SHA_SENTINEL, advisory, affects, ago, bundle, component, env, pr, request, smokeRequest, smokeSnap, snap } from "@/server/nebula/__tests__/lifecycle-fixtures";
import {
  DEFAULT_ADVISORY_FILTER,
  DEFAULT_COMPONENT_FILTER,
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
  return buildPreview({ rows: [source()], requests: [], services: SERVICES, envs: [], promotions: [], staging: stagingOn("main-" + "1".repeat(40)), signoffs: [], now: NOW, ...over });
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
    expect(LIFECYCLE_TABS.map((t) => TAB_LABEL[t])).toEqual(["Schedule", "Tiers", "Advisories", "Preview", "History"]);
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
