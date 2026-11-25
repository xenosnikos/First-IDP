// End-to-end over the contract fixtures PLO generates (packages/shared/src/__tests__/
// lifecycle-contract.test.ts explains where they come from): each snapshot goes through the
// real ingest handler, and what was stored is what the Lifecycle read model is built from.
// A fixture PLO's builder produced that Nebula cannot ingest or cannot join is a contract break.
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
  const requests = (JSON.parse(read("requests.json")).claimed as Array<{ id: string; kind: string; params: unknown }>).map((r) => ({ ...r, status: "pending" }));
  const store: LifecycleIngestStore = {
    async upsertSnapshot(row: SnapshotWrite, now: Date) {
      const at = rows.findIndex((r) => r.runId === row.runId);
      const id = at >= 0 ? rows[at].id : `cmsnap${rows.length}`;
      const saved: SnapshotRow = { id, job: row.job, runId: row.runId, ok: row.ok, startedAt: row.startedAt, finishedAt: row.finishedAt, createdAt: now, data: row.data };
      if (at >= 0) rows[at] = saved;
      else rows.push(saved);
      return { id, replaced: at >= 0 };
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
    async requestStatus(id) {
      return requests.find((x) => x.id === id)?.status ?? null;
    },
    async audit(entry) {
      audits.push(entry);
    },
  };
  return { store, rows, audits, requests };
}

describe("PLO contract fixtures through the ingest handler and the read model", () => {
  it("every snapshot is accepted, stored unchanged, and re-ingesting the same run replaces it", async () => {
    const m = memoryStore();
    const deps = { store: m.store, token: TOKEN, now: () => NOW };
    for (const name of ["snapshot-plan.json", "snapshot-source.json", "snapshot-cve.json", "snapshot-smoke.json", "snapshot-failed.json"]) {
      const res = await handleIngest(post("ingest", read(name)), deps);
      expect(res.status, name).toBe(200);
      expect(await res.json(), name).toEqual({ id: expect.any(String) });
      const sent = JSON.parse(read(name)) as LifecycleSnapshotDoc;
      expect(m.rows.find((r) => r.runId === sent.runId)!.data, name).toEqual(sent);
    }
    expect(m.rows).toHaveLength(5);
    expect((await handleIngest(post("ingest", read("snapshot-plan.json")), deps)).status).toBe(200);
    expect(m.rows).toHaveLength(5);
    expect(m.audits.filter((a) => a.action === "lifecycle.ingest" && a.allowed)).toHaveLength(6);
  });

  it("the read model joins what PLO sent: tiers, schedule, advisories on their components, the failed run", async () => {
    const m = memoryStore();
    const deps = { store: m.store, token: TOKEN, now: () => NOW };
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
