// End-to-end over the contract fixtures PLO generates (packages/shared/src/__tests__/
// lifecycle-contract.test.ts explains where they come from): each snapshot goes through the
// real ingest handler, and what was stored is what the Lifecycle read model is built from.
// A fixture PLO's builder produced that Nebula cannot ingest or cannot join is a contract break.
import { lifecycleBundleKey } from "@twizz-idp/actions";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { LifecycleSnapshotDoc } from "@twizz-idp/shared";
import { handleClaim, handleComplete, handleIngest, type AuditWrite, type LifecycleIngestStore, type SnapshotWrite } from "../lifecycle-ingest";
import { buildAdvisories, buildOverview, selectSnapshots, type SnapshotRow } from "../lifecycle-model";

const DIR = resolve(__dirname, "../../../../../../packages/shared/src/__tests__/fixtures/lifecycle-contract");
const read = (name: string) => readFileSync(join(DIR, name), "utf8");
const TOKEN = "c0ntract-".repeat(5);
const NOW = new Date("2026-12-04T06:00:00.000Z");
const post = (path: string, body?: string) =>
  new Request(`http://dashboard.nebula.svc.cluster.local/api/lifecycle/${path}`, {
    method: "POST",
    // exactly the headers PLO's client sends (src/nebula/client.ts)
    headers: { authorization: `Bearer ${TOKEN}`, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body,
  });

function memoryStore() {
  const rows: SnapshotRow[] = [];
  const audits: AuditWrite[] = [];
  const requests = (JSON.parse(read("requests.json")).claimed as Array<{ id: string; kind: string; params: unknown }>).map((r) => ({ ...r, status: "pending", runId: null as string | null }));
  const store: LifecycleIngestStore = {
    transaction: (fn) => fn(store),
    async findSnapshot(runId) {
      const r = rows.find((x) => x.runId === runId);
      return r ? { id: r.id, job: r.job, data: JSON.parse(JSON.stringify(r.data)) as unknown } : null;
    },
    async insertSnapshot(row: SnapshotWrite, now: Date) {
      const id = `cmsnap${rows.length}`;
      rows.push({ id, job: row.job, runId: row.runId, ok: row.ok, startedAt: row.startedAt, finishedAt: row.finishedAt, createdAt: now, data: row.data });
      return { id };
    },
    async bindRun(id, runId) {
      const r = requests.find((x) => x.id === id && x.status === "claimed" && x.runId === null);
      if (r) r.runId = runId;
      return !!r;
    },
    async getRequest(id) {
      const r = requests.find((x) => x.id === id);
      return r ? { id: r.id, kind: r.kind, params: r.params, status: r.status, runId: r.runId } : null;
    },
    async pruneSnapshots() {
      return 0;
    },
    async expireRequests() {
      return { expired: 0, failed: 0 };
    },
    async claimOldestPending() {
      const r = requests.find((x) => x.status === "pending");
      if (!r) return null;
      r.status = "claimed";
      return { id: r.id, kind: r.kind, params: r.params };
    },
    async finishClaimed(id, patch) {
      const r = requests.find((x) => x.id === id && x.status === "claimed");
      if (r) r.status = patch.status;
      return !!r;
    },
    async audit(entry) {
      audits.push(entry);
    },
  };
  return { store, rows, audits, requests };
}

/** what plo-dispatch does first: claim every pending request */
async function claimAll(deps: { store: LifecycleIngestStore; token: string; now: () => Date }) {
  for (;;) {
    const r = (await (await handleClaim(post("requests/claim"), deps)).json()) as { request: unknown };
    if (!r.request) return;
  }
}

describe("PLO contract fixtures through the ingest handler and the read model", () => {
  it("every snapshot is accepted and stored unchanged; re-ingesting the same run changes nothing", async () => {
    const m = memoryStore();
    const deps = { store: m.store, token: TOKEN, now: () => NOW };
    // a smoke snapshot is the answer to a request plo-dispatch claimed: claim them first, as it does
    await claimAll(deps);
    for (const name of ["snapshot-plan.json", "snapshot-source.json", "snapshot-cve.json", "snapshot-smoke.json", "snapshot-failed.json"]) {
      const res = await handleIngest(post("ingest", read(name)), deps);
      expect(res.status, name).toBe(200);
      expect(await res.json(), name).toEqual({ id: expect.any(String) });
      const sent = JSON.parse(read(name)) as LifecycleSnapshotDoc;
      expect(m.rows.find((r) => r.runId === sent.runId)!.data, name).toEqual(sent);
    }
    expect(m.rows).toHaveLength(5);
    const again = await handleIngest(post("ingest", read("snapshot-plan.json")), deps);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ id: expect.any(String), duplicate: true });
    expect(m.rows).toHaveLength(5);
    // the smoke result is bound to the request it answers, under its own run id
    const smoke = JSON.parse(read("snapshot-smoke.json")) as LifecycleSnapshotDoc;
    expect(m.requests.find((r) => r.id === smoke.requestId)).toMatchObject({ status: "claimed", runId: smoke.runId });
    // PLO's bundle key is the one Nebula computes from the same bundles
    const source = JSON.parse(read("snapshot-source.json")) as LifecycleSnapshotDoc;
    expect(lifecycleBundleKey(source.bundles!)).toBe(source.bundleKey);
    expect(m.audits.filter((a) => a.action === "lifecycle.ingest" && a.allowed)).toHaveLength(6);
  });

  it("the read model joins what PLO sent: tiers, schedule, advisories on their components, the failed run", async () => {
    const m = memoryStore();
    const deps = { store: m.store, token: TOKEN, now: () => NOW };
    await claimAll(deps);
    // oldest first, as the jobs would have run
    for (const [i, name] of ["snapshot-plan.json", "snapshot-source.json", "snapshot-cve.json", "snapshot-smoke.json", "snapshot-failed.json"].entries()) {
      await handleIngest(post("ingest", read(name)), { ...deps, now: () => new Date(NOW.getTime() - (10 - i) * 60_000) });
    }
    const view = buildOverview({ rows: m.rows, requests: [], now: NOW });
    const plan = JSON.parse(read("snapshot-plan.json")) as LifecycleSnapshotDoc;
    const cve = JSON.parse(read("snapshot-cve.json")) as LifecycleSnapshotDoc;

    expect(view.tiers.map((t) => t.tier)).toEqual(["control-plane", "addons", "nodes", "helm", "base-images", "npm-direct", "npm-transitive"]);
    for (const t of view.tiers) expect(t.total, t.tier).toBeGreaterThan(0);
    expect(view.header.components).toBe(plan.components!.length);
    expect(view.schedule.rows.map((r) => r.job)).toEqual(plan.schedule.map((s) => s.job));
    expect(view.runs.plan?.runId).toBe(plan.runId);
    // the newest cve run failed: the page keeps the last good scan and says a newer one failed
    expect(view.runs.cve).toMatchObject({ runId: cve.runId, ok: true, lastFailed: { runId: "20261204T053000-cve" } });
    expect(view.header.kev).toBe(1);

    // an advisory lands on the component PLO named: the ids of the two jobs are the same ids
    const express = view.tiers.flatMap((t) => t.components).find((c) => c.name === "express")!;
    expect(express.advisories).toMatchObject({ count: 1, kev: 1, from: "cve" });
    const adv = buildAdvisories(selectSnapshots(m.rows), NOW);
    expect(adv.total).toBe(cve.advisories!.length);
    expect(adv.scan?.runId).toBe(cve.runId);
  });

  // external review 2026-11-25, idp #7: PLO's cve job files a repository's transitive advisories under
  // `npm-dependency:<repo>:__lockfile`, its plan/source jobs name that component after its display name —
  // so on PLO's own fixtures the npm-transitive tier read "0 advisories" with a CRITICAL KEV in it
  it("transitive npm advisories reach their tier and their lockfile component although the two jobs spell its id differently", async () => {
    const m = memoryStore();
    const deps = { store: m.store, token: TOKEN, now: () => NOW };
    for (const [i, name] of ["snapshot-plan.json", "snapshot-source.json", "snapshot-cve.json"].entries()) {
      await handleIngest(post("ingest", read(name)), { ...deps, now: () => new Date(NOW.getTime() - (10 - i) * 60_000) });
    }
    const cve = JSON.parse(read("snapshot-cve.json")) as LifecycleSnapshotDoc;
    const transitive = cve.advisories!.filter((a) => a.affected.some((x) => x.tier === "npm-transitive"));
    expect(transitive.length).toBeGreaterThan(0);
    // the mismatch itself, pinned: if PLO unifies the ids one day this line says so
    const ids = new Set(JSON.parse(read("snapshot-plan.json")).components.map((c: { id: string }) => c.id) as string[]);
    expect(transitive.flatMap((a) => a.affected.filter((x) => x.tier === "npm-transitive").map((x) => x.componentId)).some((id) => !ids.has(id))).toBe(true);

    const view = buildOverview({ rows: m.rows, requests: [], now: NOW });
    const tier = view.tiers.find((t) => t.tier === "npm-transitive")!;
    expect(tier.advisories).toBe(transitive.length);
    expect(tier.kev).toBe(transitive.filter((a) => a.kev).length);
    expect(tier.kev).toBeGreaterThan(0);
    expect(tier.highestSeverity).toBe("critical");
    // the sentinel lockfile row carries its advisory (joined by tier + repository)…
    const lockfile = tier.components.find((c) => c.target === "twizz-sentinel")!;
    expect(lockfile.advisories).toMatchObject({ kev: 1, highest: "critical", from: "cve" });
    expect(lockfile.advisories.count).toBeGreaterThan(0);
    // …and the Advisories pane knows the component and the pull request that fixes it
    const adv = buildAdvisories(selectSnapshots(m.rows), NOW);
    const hit = adv.advisories.flatMap((a) => a.affected).find((x) => x.componentId === "npm-dependency:twizz-sentinel:__lockfile")!;
    expect(hit).toMatchObject({ known: true });
    expect(hit.pr ?? lockfile.pr ?? null).toEqual(lockfile.pr ?? null);
    // Moly-backend has no lockfile row in plan/source at all: its advisory still counts for the tier, unjoined
    const orphan = adv.advisories.flatMap((a) => a.affected).find((x) => x.componentId === "npm-dependency:Moly-backend:__lockfile")!;
    expect(orphan).toMatchObject({ known: false, pr: null });
  });

  it("requests: each fixture request is claimed as PLO expects it and completed with PLO's bodies", async () => {
    const m = memoryStore();
    const deps = { store: m.store, token: TOKEN, now: () => NOW };
    const fixture = JSON.parse(read("requests.json")) as { claimed: Array<{ id: string; kind: string; params: unknown }>; complete: unknown[] };
    for (const expected of fixture.claimed) {
      const res = await handleClaim(post("requests/claim"), deps);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ request: expected });
    }
    expect(await (await handleClaim(post("requests/claim"), deps)).json()).toEqual({ request: null });
    for (const [i, body] of fixture.complete.entries()) {
      const res = await handleComplete(post(`requests/${fixture.claimed[i].id}/complete`, JSON.stringify(body)), fixture.claimed[i].id, deps);
      expect(res.status, JSON.stringify(body)).toBe(200);
    }
    expect((await handleIngest(post("ingest", read("snapshot-plan.json")), { ...deps, token: "x".repeat(40) })).status).toBe(401);
  });
});
