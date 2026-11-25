import { describe, expect, it } from "vitest";
import { LIFECYCLE_COMPONENT_STATUSES, LIFECYCLE_TIERS } from "@twizz-idp/shared";
import { STATUS_WORDS } from "@/lib/nebula/status";
import {
  ACTIONABLE_STATUSES,
  COMPONENT_STATUS_WORD,
  DEFAULT_SCHEDULE,
  SMOKE_LOOKBACK,
  STALE_AFTER_MS,
  TIER_LABEL,
  TIER_ORDER,
  advisoriesByComponent,
  buildAdvisories,
  buildOverview,
  buildSchedule,
  buildTiers,
  compareAdvisories,
  mergeComponents,
  neededSnapshotIds,
  requestView,
  selectSnapshots,
  staleness,
} from "../lifecycle-model";
import { DAY, HOUR, KEY, NOW, advisory, affects, ago, component, pr, request, smokeRequest, snap } from "./lifecycle-fixtures";

describe("selectSnapshots", () => {
  it("separates the last run from the data shown: a failed run does not replace good data", () => {
    const good = snap("plan", ago(3 * DAY));
    const failed = snap("plan", ago(1 * HOUR), { ok: false, error: "aws: ExpiredToken" });
    const sel = selectSnapshots([good, failed]);
    expect(sel.plan.last?.id).toBe(failed.id);
    expect(sel.plan.data?.id).toBe(good.id);
  });

  it("falls back to a failed run's partial data when nothing ever succeeded", () => {
    const failed = snap("source", ago(HOUR), { ok: false });
    const sel = selectSnapshots([failed]);
    expect(sel.source.data?.id).toBe(failed.id);
    expect(selectSnapshots([]).plan).toEqual({ last: null, data: null });
  });

  it("picks the previous SUCCESSFUL cve scan to compare with", () => {
    const a = snap("cve", ago(3 * DAY));
    const b = snap("cve", ago(2 * DAY), { ok: false });
    const c = snap("cve", ago(1 * DAY));
    const d = snap("cve", ago(1 * HOUR), { ok: false });
    const sel = selectSnapshots([a, b, c, d]);
    expect([sel.cve.last?.id, sel.cve.data?.id, sel.cve.previous?.id]).toEqual([d.id, c.id, a.id]);
    expect(selectSnapshots([c]).cve.previous).toBeNull();
  });

  it("orders by when Nebula received the row, id as the tie-break, whatever the input order", () => {
    const first = snap("plan", ago(HOUR), {}, { id: "a", createdAt: ago(10) });
    const second = snap("plan", ago(2 * HOUR), {}, { id: "b", createdAt: ago(10) });
    expect(selectSnapshots([first, second]).plan.last?.id).toBe("b");
    expect(selectSnapshots([second, first]).plan.last?.id).toBe("b");
    // a late delivery of an older run is still "the newest received"
    const late = snap("plan", ago(5 * DAY), {}, { createdAt: ago(1) });
    expect(selectSnapshots([first, second, late]).plan.last?.id).toBe(late.id);
  });

  it("keeps a bounded number of smoke snapshots, newest first", () => {
    const smokes = Array.from({ length: SMOKE_LOOKBACK + 5 }, (_, i) => snap("smoke", ago((i + 1) * HOUR)));
    const sel = selectSnapshots(smokes);
    expect(sel.smoke).toHaveLength(SMOKE_LOOKBACK);
    expect(sel.smoke[0].id).toBe(smokes[0].id);
  });

  it("neededSnapshotIds asks only for the rows the views read", () => {
    const rows = [snap("plan", ago(9 * DAY)), snap("plan", ago(2 * DAY)), snap("plan", ago(HOUR), { ok: false }), snap("cve", ago(3 * DAY)), snap("cve", ago(2 * DAY)), snap("cve", ago(DAY)), snap("source", ago(DAY)), snap("smoke", ago(HOUR))];
    const ids = neededSnapshotIds(rows);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual([rows[1].id, rows[2].id, rows[4].id, rows[5].id, rows[6].id, rows[7].id].sort());
  });
});

describe("staleness", () => {
  it("plan: WATCH once the data is older than 8 days", () => {
    expect(STALE_AFTER_MS).toEqual({ plan: 8 * DAY, cve: 36 * HOUR });
    expect(staleness("plan", snap("plan", ago(8 * DAY)), NOW).word).toBe("OK");
    const stale = staleness("plan", snap("plan", ago(8 * DAY + 1)), NOW);
    expect(stale).toMatchObject({ word: "WATCH", ageMs: 8 * DAY + 1, limitMs: 8 * DAY });
    expect(stale.detail).toMatch(/older than 8 days/);
  });

  it("cve: WATCH once the data is older than 36 h", () => {
    expect(staleness("cve", snap("cve", ago(36 * HOUR)), NOW).word).toBe("OK");
    expect(staleness("cve", snap("cve", ago(36 * HOUR + 1)), NOW).word).toBe("WATCH");
  });

  it("UNKNOWN when nothing was ever received; WATCH when only a failed run exists", () => {
    expect(staleness("plan", null, NOW)).toMatchObject({ word: "UNKNOWN", at: null, ageMs: null });
    expect(staleness("cve", snap("cve", ago(HOUR), { ok: false }), NOW).word).toBe("WATCH");
  });

  it("measures the run's own finish time, not when Nebula received it", () => {
    const replayed = snap("cve", ago(5 * DAY), {}, { createdAt: ago(60_000) });
    expect(staleness("cve", replayed, NOW).word).toBe("WATCH");
  });

  it("only ever uses brand status words", () => {
    for (const s of [staleness("plan", null, NOW), staleness("plan", snap("plan", ago(1)), NOW), staleness("plan", snap("plan", ago(30 * DAY)), NOW)]) expect(STATUS_WORDS).toContain(s.word);
  });
});

describe("buildSchedule", () => {
  it("shows the contract's default schedule until a snapshot brings PLO's own", () => {
    const view = buildSchedule(selectSnapshots([]), [], NOW);
    expect(view.source).toBe("default");
    expect(view.rows.map((r) => r.job)).toEqual(["plan", "cve", "source", "dispatch", "sweep-staging", "promote-prod"]);
    expect(view.rows.every((r) => r.lastRun === null && r.nextRun !== null && r.cronError === null)).toBe(true);
    expect(DEFAULT_SCHEDULE.filter((e) => e.runner === "github-actions").map((e) => e.job)).toEqual(["sweep-staging", "promote-prod"]);
  });

  it("computes next runs in UTC and words the cron", () => {
    const view = buildSchedule(selectSnapshots([snap("plan", ago(2 * DAY))]), [], NOW);
    expect(view.source).toBe("snapshot");
    const by = Object.fromEntries(view.rows.map((r) => [r.job, r]));
    expect(by.plan).toMatchObject({ nextRun: "2026-11-30T06:00:00.000Z", cronText: "weekly on Monday at 06:00 UTC", runner: "nebula", requestable: true });
    expect(by.cve).toMatchObject({ nextRun: "2026-11-26T05:30:00.000Z", cronText: "daily at 05:30 UTC", requestable: true });
    expect(by.source).toMatchObject({ nextRun: "2026-12-02T07:00:00.000Z", mutates: true, requestable: false });
    expect(by.dispatch).toMatchObject({ nextRun: "2026-11-25T12:05:00.000Z", cronText: "every 5 minutes", requestable: false });
    expect(by["promote-prod"]).toMatchObject({ runner: "github-actions", nextRun: "2026-12-01T07:00:00.000Z", requestable: false, lastRun: null });
  });

  it("uses the schedule of the most recently received snapshot", () => {
    const old = snap("plan", ago(2 * DAY));
    const newer = snap("cve", ago(HOUR), { schedule: [{ job: "cve", cron: "0 4 * * *", runner: "nebula", description: "moved", mutates: false }] });
    expect(buildSchedule(selectSnapshots([old, newer]), [], NOW).rows).toMatchObject([{ job: "cve", cron: "0 4 * * *", nextRun: "2026-11-26T04:00:00.000Z" }]);
  });

  it("reports the last run of each job, failed or not, and whether it was requested", () => {
    const rows = [snap("plan", ago(2 * DAY), { runId: "plan-ok" }), snap("plan", ago(HOUR), { runId: "plan-bad", ok: false, error: "kube: timeout", requestId: "req1" }), snap("cve", ago(3 * HOUR), { runId: "cve-ok" })];
    const by = Object.fromEntries(buildSchedule(selectSnapshots(rows), [], NOW).rows.map((r) => [r.job, r]));
    expect(by.plan.lastRun).toEqual({ at: ago(HOUR).toISOString(), ok: false, runId: "plan-bad", error: "kube: timeout", requested: true });
    expect(by.cve.lastRun).toEqual({ at: ago(3 * HOUR).toISOString(), ok: true, runId: "cve-ok", error: null, requested: false });
    expect(by.source.lastRun).toBeNull();
  });

  it("dispatch's last run is the last request it claimed", () => {
    const reqs = [request("plan", { status: "done", claimedAt: ago(2 * HOUR), runId: "r-old" }), request("cve", { status: "failed", claimedAt: ago(20 * 60_000), error: "osv: 503" }), request("plan")];
    const dispatch = buildSchedule(selectSnapshots([snap("plan", ago(DAY))]), reqs, NOW).rows.find((r) => r.job === "dispatch")!;
    expect(dispatch.lastRun).toEqual({ at: ago(20 * 60_000).toISOString(), ok: false, runId: null, error: "osv: 503", requested: true });
  });

  it("attaches the in-flight request to plan / cve only", () => {
    const pendingPlan = request("plan", { status: "claimed", claimedAt: ago(60_000) });
    const reqs = [pendingPlan, request("cve", { status: "done" }), smokeRequest("preview", KEY)];
    const by = Object.fromEntries(buildSchedule(selectSnapshots([snap("plan", ago(DAY))]), reqs, NOW).rows.map((r) => [r.job, r]));
    expect(by.plan.inFlight).toMatchObject({ id: pendingPlan.id, status: "claimed", requestedBy: "nick" });
    expect(by.cve.inFlight).toBeNull();
    expect(by.source.inFlight).toBeNull();
  });

  it("reports a broken cron as data instead of throwing", () => {
    const bad = snap("plan", ago(HOUR), { schedule: [{ job: "plan", cron: "every monday", runner: "nebula", description: "", mutates: false }, { job: "cve", cron: "0 0 31 2 *", runner: "nebula", description: "", mutates: false }] });
    const rows = buildSchedule(selectSnapshots([bad]), [], NOW).rows;
    expect(rows[0]).toMatchObject({ nextRun: null, cronText: "every monday" });
    expect(rows[0].cronError).toMatch(/expected 5 fields/);
    expect(rows[1]).toMatchObject({ nextRun: null, cronError: "this expression never fires" });
  });
});

describe("requestView", () => {
  it("exposes scope and bundle of a smoke request, and nothing of its targets", () => {
    const v = requestView(smokeRequest("stg", KEY, { status: "done", runId: "smoke-1", finishedAt: ago(1000), claimedAt: ago(5000) }));
    expect(v).toMatchObject({ kind: "smoke", scope: "stg", bundleKey: KEY, status: "done", runId: "smoke-1" });
    expect(JSON.stringify(v)).not.toContain("baseUrl");
  });
  it("tolerates garbage params", () => {
    expect(requestView(request("smoke", { params: "'; DROP TABLE" }))).toMatchObject({ scope: null, bundleKey: null });
    expect(requestView(request("plan", { params: null }))).toMatchObject({ scope: null, bundleKey: null });
  });
});

describe("tiers", () => {
  it("lists every tier in dependency order with a label", () => {
    expect(TIER_ORDER).toEqual(["control-plane", "addons", "nodes", "helm", "base-images", "npm-direct", "npm-transitive"]);
    expect(Object.keys(TIER_LABEL).sort()).toEqual([...LIFECYCLE_TIERS].sort());
    const empty = buildTiers(selectSnapshots([]));
    expect(empty.map((t) => t.tier)).toEqual([...TIER_ORDER]);
    expect(empty.every((t) => t.total === 0 && t.components.length === 0)).toBe(true);
  });

  it("maps every component status onto the closed status vocabulary", () => {
    expect(Object.keys(COMPONENT_STATUS_WORD).sort()).toEqual([...LIFECYCLE_COMPONENT_STATUSES].sort());
    for (const w of Object.values(COMPONENT_STATUS_WORD)) expect(STATUS_WORDS).toContain(w);
    expect(ACTIONABLE_STATUSES).toEqual(["outdated", "pr-open", "awaiting-approval", "escalated", "failed", "blocked"]);
  });

  it("groups components by tier, counts per status and sorts actionable first", () => {
    const plan = snap("plan", ago(DAY), {
      components: [
        component("eks:stg:cp", { tier: "control-plane", name: "kubernetes", target: "EKS-Moly-staging", status: "awaiting-approval", bump: "minor" }),
        component("npm:s:zod", { name: "zod", status: "current", bump: "none", desired: null }),
        component("npm:s:express", { name: "express", status: "outdated" }),
        component("npm:s:axios", { name: "axios", status: "failed" }),
        component("npm:s:lodash", { name: "lodash", status: "applied" }),
      ],
    });
    const tiers = buildTiers(selectSnapshots([plan]));
    const direct = tiers.find((t) => t.tier === "npm-direct")!;
    expect(direct.components.map((c) => c.name)).toEqual(["axios", "express", "lodash", "zod"]);
    expect(direct).toMatchObject({ total: 4, actionable: 2, label: "npm direct" });
    expect(direct.counts).toMatchObject({ current: 1, outdated: 1, failed: 1, applied: 1, "pr-open": 0, unknown: 0 });
    expect(Object.keys(direct.counts).sort()).toEqual([...LIFECYCLE_COMPONENT_STATUSES].sort());
    const cp = tiers.find((t) => t.tier === "control-plane")!;
    expect(cp.components[0]).toMatchObject({ word: "AWAITING HUMAN", actionable: true, snapshot: "plan" });
    expect(tiers.find((t) => t.tier === "helm")!.total).toBe(0);
  });

  it("can return counts without the rows", () => {
    const plan = snap("plan", ago(DAY), { components: [component("npm:s:a"), component("npm:s:b", { status: "current" })] });
    const direct = buildTiers(selectSnapshots([plan]), { components: false }).find((t) => t.tier === "npm-direct")!;
    expect(direct).toMatchObject({ total: 2, actionable: 1, components: [] });
  });

  it("merges plan and source by component id; the newer run wins", () => {
    const planOld = snap("plan", ago(5 * DAY), { components: [component("npm:s:express", { status: "outdated" }), component("eks:stg:cp", { tier: "control-plane" })] });
    const source = snap("source", ago(2 * DAY), { components: [component("npm:s:express", { status: "pr-open", pr: pr("twizz-app/twizz-sentinel", 12) }), component("npm:s:new", { status: "pr-open" })] });
    const merged = mergeComponents(planOld, source);
    expect(merged.map((c) => [c.id, c.status, c.snapshot]).sort()).toEqual([
      ["eks:stg:cp", "outdated", "plan"],
      ["npm:s:express", "pr-open", "source"],
      ["npm:s:new", "pr-open", "source"],
    ]);
    // a plan run AFTER the source run is the newer truth (e.g. the PR was merged)
    const planNew = snap("plan", ago(1 * DAY), { components: [component("npm:s:express", { status: "current" })] });
    expect(mergeComponents(planNew, source).find((c) => c.id === "npm:s:express")).toMatchObject({ status: "current", snapshot: "plan" });
    expect(mergeComponents(null, null)).toEqual([]);
  });

  // PLO handoff after the 2026-11-25 review: the source snapshot is assembled next to untrusted repository
  // code. Whatever it claims, it only ever supplies rows of the tiers a source run really reports.
  it("a source snapshot can neither replace nor add an infrastructure row", () => {
    const plan = snap("plan", ago(5 * DAY), { components: [component("eks:prod:cp", { tier: "control-plane", status: "outdated", target: "EKS-Moly-Prod" }), component("helm:prod:cert-manager", { tier: "helm", status: "outdated" })] });
    const source = snap("source", ago(1 * DAY), {
      components: [
        component("eks:prod:cp", { tier: "control-plane", status: "current" }), // "prod is up to date", says the source job
        component("helm:prod:cert-manager", { tier: "npm-direct", status: "current" }), // the same id, dressed as an npm row
        component("eks:prod:invented", { tier: "addons", status: "current" }),
        component("npm:s:express", { tier: "npm-direct", status: "pr-open" }),
      ],
    });
    const merged = mergeComponents(plan, source);
    expect(merged.map((c) => [c.id, c.tier, c.status, c.snapshot]).sort()).toEqual([
      ["eks:prod:cp", "control-plane", "outdated", "plan"],
      ["helm:prod:cert-manager", "helm", "outdated", "plan"],
      ["npm:s:express", "npm-direct", "pr-open", "source"],
    ]);
  });

  it("joins advisories to components: count, worst severity, KEV, ids worst first", () => {
    const plan = snap("plan", ago(DAY), { components: [component("npm:s:express"), component("npm:s:zod"), component("eks:stg:cp", { tier: "control-plane" })] });
    const cve = snap("cve", ago(HOUR), {
      advisories: [
        advisory("GHSA-low", { severity: "low", affected: [affects("npm:s:express")] }),
        advisory("GHSA-kev", { severity: "high", kev: true, affected: [affects("npm:s:express"), affects("npm:s:express", { target: "twizz-admin" }), affects("eks:stg:cp", { tier: "control-plane" })] }),
        advisory("GHSA-crit", { severity: "critical", affected: [affects("npm:s:express")] }),
        advisory("GHSA-orphan", { severity: "critical", affected: [affects("npm:gone:pkg")] }),
      ],
    });
    const tiers = buildTiers(selectSnapshots([plan, cve]));
    const direct = tiers.find((t) => t.tier === "npm-direct")!;
    const express = direct.components.find((c) => c.id === "npm:s:express")!;
    // one advisory hitting the same component twice counts once
    expect(express.advisories).toEqual({ count: 3, highest: "critical", kev: 1, ids: ["GHSA-kev", "GHSA-crit", "GHSA-low"], from: "cve" });
    expect(direct.components.find((c) => c.id === "npm:s:zod")!.advisories).toEqual({ count: 0, highest: null, kev: 0, ids: [], from: "cve" });
    // (external review 2026-11-25, idp #7) was 3: the orphan — a critical advisory PLO filed under this tier
    // for a component no plan/source row carries — did not count, so a tier could read "0 advisories"
    // with a critical one in it. An advisory counts for the tier it names, joined to a row or not.
    expect(direct.advisories).toBe(4);
    expect(direct).toMatchObject({ kev: 1, highestSeverity: "critical" });
    expect(tiers.find((t) => t.tier === "control-plane")!.advisories).toBe(1);
    expect(advisoriesByComponent([]).size).toBe(0);
  });

  it("falls back to PLO's own advisory count while no cve snapshot exists", () => {
    const plan = snap("plan", ago(DAY), { components: [component("npm:s:express", { security: { advisories: 4, highestSeverity: "high" } }), component("npm:s:zod")] });
    const direct = buildTiers(selectSnapshots([plan])).find((t) => t.tier === "npm-direct")!;
    expect(direct.components.find((c) => c.id === "npm:s:express")!.advisories).toMatchObject({ count: 4, from: "plan" });
    expect(direct.advisories).toBe(4);
  });
});

describe("advisories", () => {
  it("sorts KEV first, then severity, then EPSS, then id", () => {
    const list = [
      advisory("D", { severity: "high", epss: 0.1 }),
      advisory("B", { severity: "critical" }),
      advisory("A", { severity: "low", kev: true }),
      advisory("C", { severity: "high", epss: 0.9 }),
      advisory("E", { severity: "high" }),
      advisory("F", { severity: "unknown", epss: 0.99 }),
      advisory("A2", { severity: "critical", kev: true }),
    ];
    expect([...list].sort(compareAdvisories).map((a) => a.id)).toEqual(["A2", "A", "B", "C", "D", "E", "F"]);
  });

  it("marks what is new since the previous successful scan, by id or alias", () => {
    const before = snap("cve", ago(2 * DAY), { runId: "cve-before", advisories: [advisory("GHSA-old"), advisory("GHSA-rekeyed", { aliases: ["CVE-2026-1111"] })] });
    const failedBetween = snap("cve", ago(DAY), { ok: false, advisories: [] });
    const now = snap("cve", ago(HOUR), {
      runId: "cve-now",
      advisories: [advisory("GHSA-old"), advisory("cve-2026-1111", { aliases: ["GHSA-rekeyed"] }), advisory("GHSA-brand-new", { severity: "critical", kev: true }), advisory("GHSA-new-2", { aliases: ["CVE-2026-2222"] })],
    });
    const view = buildAdvisories(selectSnapshots([before, failedBetween, now]), NOW);
    expect(view.scan).toMatchObject({ runId: "cve-now", ok: true });
    expect(view.comparedTo).toMatchObject({ runId: "cve-before" });
    expect(Object.fromEntries(view.advisories.map((a) => [a.id, a.isNew]))).toEqual({ "GHSA-brand-new": true, "GHSA-new-2": true, "GHSA-old": false, "cve-2026-1111": false });
    expect(view.new).toBe(2);
    expect(view.advisories[0].id).toBe("GHSA-brand-new");
  });

  it("marks nothing new when there is no previous scan to compare with", () => {
    const view = buildAdvisories(selectSnapshots([snap("cve", ago(HOUR), { advisories: [advisory("A"), advisory("B")] })]), NOW);
    expect(view.comparedTo).toBeNull();
    expect(view.new).toBe(0);
    expect(view.advisories.every((a) => !a.isNew)).toBe(true);
  });

  it("does not compare a failed scan's partial list against the last good one", () => {
    const onlyFailed = snap("cve", ago(HOUR), { ok: false, advisories: [advisory("A")] });
    const view = buildAdvisories(selectSnapshots([onlyFailed]), NOW);
    expect(view.scan?.ok).toBe(false);
    expect(view.comparedTo).toBeNull();
    expect(view.stale.word).toBe("WATCH");
  });

  it("joins each affected entry to its component (status, PR) and says when it is unknown", () => {
    const plan = snap("plan", ago(DAY), { components: [component("npm:s:express", { status: "pr-open", pr: pr("twizz-app/twizz-sentinel", 9) })] });
    const cve = snap("cve", ago(HOUR), { advisories: [advisory("A", { affected: [affects("npm:s:express", { environments: ["staging", "prod"] }), affects("npm:gone:pkg", { tier: "npm-transitive", environments: ["dev"] })] })] });
    const view = buildAdvisories(selectSnapshots([plan, cve]), NOW);
    expect(view.advisories[0].affected).toMatchObject([
      { componentId: "npm:s:express", known: true, status: "pr-open", pr: { number: 9 } },
      { componentId: "npm:gone:pkg", known: false, status: null, pr: null },
    ]);
    expect(view.facets).toEqual({ tiers: ["npm-direct", "npm-transitive"], environments: ["dev", "prod", "staging"] });
  });

  it("counts by severity and KEV, and carries the scan's own errors and staleness", () => {
    const cve = snap("cve", ago(40 * HOUR), {
      discoveryErrors: [{ domain: "epss", error: "timeout after 20 s" }],
      advisories: [advisory("A", { severity: "critical", kev: true }), advisory("B", { severity: "critical" }), advisory("C", { severity: "high", kev: true }), advisory("D", { severity: "unknown" })],
    });
    const view = buildAdvisories(selectSnapshots([cve]), NOW);
    expect(view).toMatchObject({ total: 4, kev: 2, counts: { critical: 2, high: 1, moderate: 0, low: 0, unknown: 1 }, discoveryErrors: [{ domain: "epss" }] });
    expect(view.stale.word).toBe("WATCH");
  });

  it("is empty and UNKNOWN before the first scan", () => {
    expect(buildAdvisories(selectSnapshots([]), NOW)).toMatchObject({ scan: null, comparedTo: null, total: 0, advisories: [], stale: { word: "UNKNOWN" } });
  });
});

describe("buildOverview", () => {
  const plan = snap("plan", ago(2 * DAY), {
    runId: "plan-1",
    discoveryErrors: [{ domain: "helm-release", error: "forbidden" }],
    components: [
      component("eks:stg:cp", { tier: "control-plane", status: "awaiting-approval", environments: ["staging"] }),
      component("eks:prod:cp", { tier: "control-plane", status: "current", environments: ["prod"] }),
      component("npm:s:express", { status: "outdated", environments: ["staging", "prod"] }),
      component("npm:s:zod", { status: "outdated" }),
    ],
  });
  const cve = snap("cve", ago(2 * HOUR), { runId: "cve-1", advisories: [advisory("A", { severity: "critical", kev: true }), advisory("B", { severity: "high" }), advisory("C", { severity: "low" })] });

  it("summarises the header from the merged snapshots", () => {
    const view = buildOverview({ rows: [plan, cve], requests: [], now: NOW });
    expect(view.header).toEqual({ outdated: 2, actionable: 3, components: 4, criticalHigh: 2, kev: 1, newAdvisories: 0, lastPlanAt: ago(2 * DAY).toISOString(), lastCveAt: ago(2 * HOUR).toISOString() });
    expect(view.stale).toMatchObject({ plan: { word: "OK" }, cve: { word: "OK" } });
    expect(view.environments).toEqual(["prod", "staging"]);
    expect(view.discoveryErrors).toEqual([{ job: "plan", domain: "helm-release", error: "forbidden" }]);
    expect(view.runs.plan).toMatchObject({ runId: "plan-1", ok: true, lastFailed: null });
    expect(view.runs.source).toBeNull();
    expect(view.tiers.map((t) => t.total)).toEqual([2, 0, 0, 0, 0, 2, 0]);
  });

  it("says so when a newer run failed and older data is shown", () => {
    const failed = snap("plan", ago(HOUR), { runId: "plan-2", ok: false, error: "aws: AccessDenied" });
    const view = buildOverview({ rows: [plan, failed, cve], requests: [], now: NOW });
    expect(view.runs.plan).toMatchObject({ runId: "plan-1", lastFailed: { runId: "plan-2", error: "aws: AccessDenied" } });
    expect(view.header.components).toBe(4);
    expect(view.header.lastPlanAt).toBe(ago(2 * DAY).toISOString());
  });

  it("flags stale plan and cve data", () => {
    const view = buildOverview({ rows: [snap("plan", ago(9 * DAY)), snap("cve", ago(37 * HOUR))], requests: [], now: NOW });
    expect(view.stale).toMatchObject({ plan: { word: "WATCH" }, cve: { word: "WATCH" } });
  });

  it("keeps header counts when the rows are left out", () => {
    const view = buildOverview({ rows: [plan, cve], requests: [], now: NOW, components: false });
    expect(view.header.components).toBe(4);
    expect(view.tiers.every((t) => t.components.length === 0)).toBe(true);
    expect(view.tiers[0].total).toBe(2);
  });

  it("lists requests newest first and works with nothing at all", () => {
    const older = request("plan", { createdAt: ago(2 * HOUR), status: "done" });
    const newer = request("cve", { createdAt: ago(60_000) });
    expect(buildOverview({ rows: [], requests: [older, newer], now: NOW }).requests.map((r) => r.id)).toEqual([newer.id, older.id]);
    const empty = buildOverview({ rows: [], requests: [], now: NOW });
    expect(empty.header).toMatchObject({ outdated: 0, components: 0, criticalHigh: 0, kev: 0, lastPlanAt: null, lastCveAt: null });
    expect(empty.stale).toMatchObject({ plan: { word: "UNKNOWN" }, cve: { word: "UNKNOWN" } });
    expect(empty.schedule.source).toBe("default");
  });
});
