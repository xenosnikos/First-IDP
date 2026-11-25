// The Prisma-backed store against a REAL Postgres: the atomic claim under
// concurrency, the timestamp handling of the raw SQL, retention, the history
// query and the request queue. Opt-in — it needs a throwaway database with the
// migrations applied (`prisma migrate deploy`) and is skipped otherwise:
//
//   LIFECYCLE_TEST_DATABASE_URL=postgresql://… pnpm --filter @twizz-idp/dashboard test
//
// Every table it touches is emptied first: never point it at a real database.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@twizz-idp/db";
import { LifecycleSnapshotDoc } from "@twizz-idp/shared";
import { enqueueLifecycleRequest, lifecycleHistory, readEnvChanges, readPlanCoverage, readRequests, readSignoffs, readSmokeSnapshotsByRunId, readSnapshots } from "../lifecycle";
import { SIGNOFF_AUDIT_ACTION } from "../lifecycle-model";
import { CLAIM_TIMEOUT_MS, PENDING_EXPIRY_MS, handleClaim, handleIngest, prismaLifecycleStore } from "../lifecycle-ingest";
import { KEY } from "./lifecycle-fixtures";

const url = process.env.LIFECYCLE_TEST_DATABASE_URL;
const NOW = new Date("2026-11-25T12:00:00.123Z");
const TOKEN = "pg-test-token-".repeat(4);
/** the claim is the dispatcher's call (there is no shared-token mode): there TOKEN is the dispatcher's credential and this the publisher's */
const PUBLISHER = "pg-publisher-token-".repeat(3);

const doc = (runId: string, job: "plan" | "cve" | "smoke" = "plan", over: Record<string, unknown> = {}) =>
  LifecycleSnapshotDoc.parse({ schemaVersion: 1, job, runId, startedAt: "2026-11-25T11:50:00.000Z", finishedAt: "2026-11-25T11:55:00.000Z", ok: true, schedule: [], discoveryErrors: [], ...over });

describe.skipIf(!url)("prismaLifecycleStore on Postgres", () => {
  let prisma: PrismaClient;
  let other: PrismaClient;

  beforeAll(() => {
    // two clients = two connection pools, like two dashboard replicas
    prisma = new PrismaClient({ datasourceUrl: url });
    other = new PrismaClient({ datasourceUrl: url });
  });
  afterAll(async () => {
    await prisma?.$disconnect();
    await other?.$disconnect();
  });
  beforeEach(async () => {
    await prisma.lifecycleRequest.deleteMany();
    await prisma.lifecycleSnapshot.deleteMany();
    await prisma.auditLog.deleteMany({ where: { OR: [{ action: { startsWith: "lifecycle." } }, { action: { startsWith: "nebula." } }, { action: SIGNOFF_AUDIT_ACTION }] } });
  });

  const pending = (n: number) =>
    prisma.lifecycleRequest.createMany({ data: Array.from({ length: n }, (_, i) => ({ id: `cmreq${String(i).padStart(4, "0")}`, kind: "plan", params: {}, requestedBy: "nick", createdAt: new Date(NOW.getTime() - (n - i) * 60_000) })) });

  it("claims oldest-first and stamps claimedAt with the exact UTC instant given", async () => {
    await pending(3);
    const store = prismaLifecycleStore(prisma);
    const first = await store.claimOldestPending(NOW);
    expect(first).toEqual({ id: "cmreq0000", kind: "plan", params: {} });
    const row = await prisma.lifecycleRequest.findUniqueOrThrow({ where: { id: "cmreq0000" } });
    expect(row.status).toBe("claimed");
    expect(row.claimedAt?.toISOString()).toBe(NOW.toISOString());
    expect((await store.claimOldestPending(NOW))?.id).toBe("cmreq0001");
    expect((await store.claimOldestPending(NOW))?.id).toBe("cmreq0002");
    expect(await store.claimOldestPending(NOW)).toBeNull();
  });

  it("concurrent dispatchers on separate connections never claim the same request", async () => {
    for (let round = 0; round < 5; round++) {
      await prisma.lifecycleRequest.deleteMany();
      await pending(12);
      const a = prismaLifecycleStore(prisma);
      const b = prismaLifecycleStore(other);
      const results = await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? a : b).claimOldestPending(NOW)));
      const ids = results.flatMap((r) => (r ? [r.id] : []));
      expect(ids).toHaveLength(12);
      expect(new Set(ids).size).toBe(12);
      expect(await prisma.lifecycleRequest.count({ where: { status: "claimed" } })).toBe(12);
      expect(await prisma.lifecycleRequest.count({ where: { status: "pending" } })).toBe(0);
    }
  });

  it("a row locked by another transaction is skipped, not waited for", async () => {
    await pending(2);
    const store = prismaLifecycleStore(other);
    await prisma.$transaction(async (tx) => {
      // "dispatcher A" holds the oldest row mid-claim
      await tx.$queryRaw`SELECT "id" FROM "LifecycleRequest" WHERE "id" = 'cmreq0000' FOR UPDATE`;
      const got = await store.claimOldestPending(NOW);
      expect(got?.id).toBe("cmreq0001");
      expect(await store.claimOldestPending(NOW)).toBeNull();
    });
    // once A lets go without claiming, the row is claimable again
    expect((await store.claimOldestPending(NOW))?.id).toBe("cmreq0000");
  });

  it("the claim endpoint end to end: expiry, claim, audit", async () => {
    await prisma.lifecycleRequest.createMany({
      data: [
        { id: "cmstale0001", kind: "plan", params: {}, requestedBy: "nick", createdAt: new Date(NOW.getTime() - PENDING_EXPIRY_MS - 1000) },
        { id: "cmhung00001", kind: "cve", params: {}, requestedBy: "nick", status: "claimed", createdAt: new Date(NOW.getTime() - 5 * 3_600_000), claimedAt: new Date(NOW.getTime() - CLAIM_TIMEOUT_MS - 1000) },
        { id: "cmfresh0001", kind: "smoke", params: { scope: "preview", bundleKey: KEY, targets: [{ name: "twizz-sentinel", baseUrl: "http://twizz-sentinel.env-plo-2611-twizz-sentinel.svc.cluster.local:8090" }] }, requestedBy: "igor", createdAt: new Date(NOW.getTime() - 60_000) },
      ],
    });
    const res = await handleClaim(new Request("http://x/api/lifecycle/requests/claim", { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } }), { store: prismaLifecycleStore(prisma), token: PUBLISHER, dispatchToken: TOKEN, now: () => NOW });
    expect(await res.json()).toEqual({ request: { id: "cmfresh0001", kind: "smoke", params: { scope: "preview", bundleKey: KEY, targets: [{ name: "twizz-sentinel", baseUrl: "http://twizz-sentinel.env-plo-2611-twizz-sentinel.svc.cluster.local:8090" }] } } });
    const rows = Object.fromEntries((await prisma.lifecycleRequest.findMany()).map((r) => [r.id, r]));
    expect(rows.cmstale0001).toMatchObject({ status: "expired", error: "not claimed within 24 h" });
    expect(rows.cmhung00001).toMatchObject({ status: "failed", error: "claimed but not completed within 2 h" });
    expect(rows.cmfresh0001.status).toBe("claimed");
    const audits = await prisma.auditLog.findMany({ where: { action: { startsWith: "lifecycle." } }, orderBy: { createdAt: "asc" } });
    expect(audits.map((a) => [a.actor, a.action, a.allowed]).sort()).toEqual([
      ["plo", "lifecycle.request.claim", true],
      ["plo", "lifecycle.request.expire", true],
    ]);
  });

  it("finishClaimed only moves a claimed request", async () => {
    await pending(1);
    const store = prismaLifecycleStore(prisma);
    expect(await store.finishClaimed("cmreq0000", { status: "done", error: null, runId: "r" }, NOW)).toBe(false);
    await store.claimOldestPending(NOW);
    expect(await store.finishClaimed("cmreq0000", { status: "done", error: null, runId: "r-1" }, NOW)).toBe(true);
    expect(await store.finishClaimed("cmreq0000", { status: "failed", error: "late", runId: null }, NOW)).toBe(false);
    expect(await prisma.lifecycleRequest.findUniqueOrThrow({ where: { id: "cmreq0000" } })).toMatchObject({ status: "done", runId: "r-1", error: null });
    expect(await store.getRequest("cmreq0000")).toMatchObject({ id: "cmreq0000", kind: "plan", status: "done", runId: "r-1" });
    expect(await store.getRequest("cmnope")).toBeNull();
  });

  it("ingest end to end: insert, a runId is written once, retention, audit, history without payloads", async () => {
    const store = prismaLifecycleStore(prisma);
    const ingest = (body: unknown, at: Date) =>
      handleIngest(new Request("http://x/api/lifecycle/ingest", { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) }), { store, token: TOKEN, now: () => at });
    const first = (await (await ingest(doc("run-a", "plan", { ok: false, error: "kube: timeout", requestId: "cmreq0000" }), NOW)).json()) as { id: string };
    // the same snapshot again (jsonb has reordered its keys by now): an idempotent 200, the row untouched
    const retry = await ingest(doc("run-a", "plan", { ok: false, error: "kube: timeout", requestId: "cmreq0000" }), new Date(NOW.getTime() + 1000));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ id: first.id, duplicate: true });
    // other content under that runId: refused, never replaced
    const rewrite = await ingest(doc("run-a"), new Date(NOW.getTime() + 1000));
    expect(rewrite.status).toBe(409);
    expect(await prisma.lifecycleSnapshot.count()).toBe(1);
    const row = await prisma.lifecycleSnapshot.findUniqueOrThrow({ where: { runId: "run-a" } });
    expect(row).toMatchObject({ ok: false, job: "plan" });
    expect(row.createdAt.toISOString()).toBe(NOW.toISOString());
    expect(row.finishedAt.toISOString()).toBe("2026-11-25T11:55:00.000Z");
    await expect(store.insertSnapshot({ job: "plan", runId: "run-a", ok: true, startedAt: NOW, finishedAt: NOW, data: doc("run-a") }, NOW)).rejects.toThrow();

    await store.insertSnapshot({ job: "cve", runId: "cve-1", ok: false, startedAt: NOW, finishedAt: NOW, data: doc("cve-1", "cve", { ok: false, error: "osv: 503", requestId: "cmreq0009" }) }, new Date(NOW.getTime() + 2000));
    for (let i = 0; i < 4; i++) await store.insertSnapshot({ job: "smoke", runId: `smoke-${i}`, ok: true, startedAt: NOW, finishedAt: NOW, data: doc(`smoke-${i}`, "smoke") }, new Date(NOW.getTime() + 3000 + i));
    expect(await store.pruneSnapshots("smoke", 2)).toBe(2);
    expect((await prisma.lifecycleSnapshot.findMany({ where: { job: "smoke" }, orderBy: { createdAt: "asc" } })).map((s) => s.runId)).toEqual(["smoke-2", "smoke-3"]);
    expect(await store.pruneSnapshots("smoke", 2)).toBe(0);
    expect(await prisma.lifecycleSnapshot.count({ where: { job: { in: ["plan", "cve"] } } })).toBe(2);

    const history = await lifecycleHistory(prisma, 3);
    expect("ok" in history.data).toBe(true);
    if ("ok" in history.data) {
      expect(history.data.ok.snapshots.map((s) => [s.runId, s.ok, s.error, s.requestId])).toEqual([
        ["smoke-3", true, null, null],
        ["smoke-2", true, null, null],
        ["cve-1", false, "osv: 503", "cmreq0009"],
      ]);
      expect(history.data.ok.snapshots[2].receivedAt).toBe(new Date(NOW.getTime() + 2000).toISOString());
    }
    const read = await readSnapshots(prisma);
    expect(read.rows.map((r) => r.runId).sort()).toEqual(["cve-1", "run-a", "smoke-2", "smoke-3"]);
    expect(await prisma.auditLog.count({ where: { action: "lifecycle.ingest", allowed: true, actor: "plo" } })).toBe(2);
  });

  it("enqueueLifecycleRequest refuses an identical active request, also under a race", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => enqueueLifecycleRequest(i % 2 ? prisma : other, { kind: "plan", params: {}, requestedBy: i % 2 ? "nick" : "igor" })));
    const created = results.filter((r) => r.created);
    expect(created).toHaveLength(1);
    const refused = results.filter((r) => !r.created);
    expect(refused).toHaveLength(11);
    for (const r of refused) if (!r.created && created[0].created) expect(r.existing.id).toBe(created[0].id);
    expect(await prisma.lifecycleRequest.count()).toBe(1);

    // a different kind, and a smoke for another scope or bundle, are not "identical"
    const smoke = { scope: "preview" as const, bundleKey: KEY, targets: [{ name: "twizz-sentinel", baseUrl: "http://twizz-sentinel.env-plo-2611-twizz-sentinel.svc.cluster.local:8090" }] };
    expect((await enqueueLifecycleRequest(prisma, { kind: "cve", params: {}, requestedBy: "nick" })).created).toBe(true);
    expect((await enqueueLifecycleRequest(prisma, { kind: "smoke", params: smoke, requestedBy: "nick" })).created).toBe(true);
    expect((await enqueueLifecycleRequest(prisma, { kind: "smoke", params: smoke, requestedBy: "igor" })).created).toBe(false);
    expect((await enqueueLifecycleRequest(prisma, { kind: "smoke", params: { scope: "stg", bundleKey: KEY, targets: [{ name: "twizz-sentinel", baseUrl: "https://sentinel-stg.prv.twizz.com" }] }, requestedBy: "nick" })).created).toBe(true);
    // a target of the other scope's form is never queued (the queue validates what it stores)
    await expect(enqueueLifecycleRequest(prisma, { kind: "smoke", params: { ...smoke, scope: "stg" }, requestedBy: "nick" })).rejects.toThrow();

    // once the first is finished, the same kind may be queued again
    const store = prismaLifecycleStore(prisma);
    const claimed = await store.claimOldestPending(NOW);
    await store.finishClaimed(claimed!.id, { status: "done", error: null, runId: null }, NOW);
    expect((await enqueueLifecycleRequest(prisma, { kind: "plan", params: {}, requestedBy: "nick" })).created).toBe(true);
    await expect(enqueueLifecycleRequest(prisma, { kind: "plan", params: { stage: "prod" } as never, requestedBy: "nick" })).rejects.toThrow();
    expect((await readRequests(prisma)).length).toBe(5);
  });

  it("a claim and its audit row are one transaction: when the audit row cannot be written the request is pending again", async () => {
    await pending(1);
    const store = prismaLifecycleStore(prisma);
    await expect(
      store.transaction(async (tx) => {
        expect((await tx.claimOldestPending(NOW))?.id).toBe("cmreq0000");
        throw new Error("audit table unavailable");
      }),
    ).rejects.toThrow("audit table unavailable");
    expect((await prisma.lifecycleRequest.findUniqueOrThrow({ where: { id: "cmreq0000" } })).status).toBe("pending");
    // bindRun: once, and only while claimed
    expect(await store.bindRun("cmreq0000", "r-1")).toBe(false);
    await store.claimOldestPending(NOW);
    expect(await store.bindRun("cmreq0000", "r-1")).toBe(true);
    expect(await store.bindRun("cmreq0000", "r-2")).toBe(false);
    expect((await store.getRequest("cmreq0000"))?.runId).toBe("r-1");
  });

  it("readSignoffs returns only completed sign-off rows", async () => {
    const resource = JSON.stringify({ bundleKey: KEY });
    await prisma.auditLog.createMany({
      data: [
        { actor: "nick", action: SIGNOFF_AUDIT_ACTION, resource, allowed: true, detail: { result: "{}", summary: "Sign off" } },
        { actor: "igor", action: SIGNOFF_AUDIT_ACTION, resource, allowed: true, detail: { error: "Error: staging smoke has not passed" } },
        { actor: "mallory", action: SIGNOFF_AUDIT_ACTION, resource, allowed: false, detail: { reason: "operators only" } },
      ],
    });
    expect((await readSignoffs(prisma)).map((s) => [s.actor, s.bundleKey])).toEqual([["nick", KEY]]);
    // scoped to one bundle: the key is matched inside the gate's JSON `resource`
    expect((await readSignoffs(prisma, KEY)).map((s) => [s.actor, s.bundleKey])).toEqual([["nick", KEY]]);
    expect(await readSignoffs(prisma, "f".repeat(64))).toEqual([]);
  });

  // pass 3 #1: the real WHERE (action IN, allowed, createdAt >=, resource LIKE) against Postgres
  it("readEnvChanges: audited writes to plo-* envs since the smoke request, not denials, not other envs", async () => {
    const since = new Date(NOW.getTime() - 30 * 60_000);
    const at = (min: number) => new Date(NOW.getTime() - min * 60_000);
    await prisma.auditLog.createMany({
      data: [
        { actor: "nick", action: "nebula.rebuild_env", resource: JSON.stringify({ name: "plo-2611-moly-backend", sha: "a".repeat(40) }), allowed: true, detail: { result: "{}" }, createdAt: at(10) },
        { actor: "nick", action: "nebula.set_env_vars", resource: JSON.stringify({ name: "plo-2611-moly-backend", varNames: "A", varsHash: "x" }), allowed: true, detail: { error: "Error: boom" }, createdAt: at(20) },
        { actor: "nick", action: "nebula.lifecycle_create_preview", resource: JSON.stringify({ bundleKey: KEY, setHash: "h", envs: "plo-2611-moly-backend plo-2611-twizz-sentinel", ttlHours: "72" }), allowed: true, detail: { result: "{}" }, createdAt: at(5) },
        // before the request, a denial, another env, and a tool that does not change what an env runs
        { actor: "nick", action: "nebula.rebuild_env", resource: JSON.stringify({ name: "plo-2611-moly-backend" }), allowed: true, detail: { result: "{}" }, createdAt: at(45) },
        { actor: "mallory", action: "nebula.rebuild_env", resource: JSON.stringify({ name: "plo-2611-moly-backend" }), allowed: false, detail: { reason: "not yours" }, createdAt: at(8) },
        { actor: "nick", action: "nebula.rebuild_env", resource: JSON.stringify({ name: "my-env" }), allowed: true, detail: { result: "{}" }, createdAt: at(7) },
        { actor: "nick", action: "nebula.teardown_named_env", resource: JSON.stringify({ name: "plo-2611-moly-backend" }), allowed: true, detail: { result: "{}" }, createdAt: at(3) },
      ],
    });
    const got = await readEnvChanges(prisma, since);
    expect(got?.map((c) => [c.envName, c.action, c.at.toISOString()]).sort()).toEqual(
      [
        ["plo-2611-moly-backend", "nebula.lifecycle_create_preview", at(5).toISOString()],
        ["plo-2611-moly-backend", "nebula.rebuild_env", at(10).toISOString()],
        ["plo-2611-moly-backend", "nebula.set_env_vars", at(20).toISOString()],
        ["plo-2611-twizz-sentinel", "nebula.lifecycle_create_preview", at(5).toISOString()],
      ].sort(),
    );
    expect(await readEnvChanges(prisma, null)).toEqual([]);
  });

  // pass 3 #10: a smoke result is found by the run id its request is bound to, wherever it is in the table
  it("readSmokeSnapshotsByRunId: by run id, smoke rows only, parsed", async () => {
    const store = prismaLifecycleStore(prisma);
    const put = (runId: string, job: "plan" | "smoke", over: Record<string, unknown> = {}) => store.insertSnapshot({ job, runId, ok: true, startedAt: NOW, finishedAt: NOW, data: doc(runId, job, over) }, NOW);
    await put("smoke-a", "smoke", { requestId: "cmreq0000", smoke: { scope: "preview", bundleKey: KEY, results: [] } });
    await put("smoke-b", "smoke", { smoke: { scope: "stg", bundleKey: KEY, results: [] } });
    await put("plan-a", "plan");
    const got = await readSmokeSnapshotsByRunId(prisma, ["smoke-a", "plan-a", "nope"]);
    expect(got.rows.map((r) => [r.job, r.runId, r.data.smoke?.scope])).toEqual([["smoke", "smoke-a", "preview"]]);
    expect(got.unreadable).toEqual([]);
  });

  it("readPlanCoverage: only the coverage key of plan runs, newest first, with the UTC instant each finished", async () => {
    const cov = [{ environment: "prod", clusters: ["EKS-Moly-Prod"], tiers: [{ tier: "control-plane", state: "observed", components: 1, gaps: [] }] }];
    const store = prismaLifecycleStore(prisma);
    const at = (min: number) => new Date(NOW.getTime() - min * 60_000);
    const put = (runId: string, job: "plan" | "cve", min: number, over: Record<string, unknown> = {}, ok = true) => {
      const d = doc(runId, job, { ok, ...over });
      return store.insertSnapshot({ job, runId, ok, startedAt: at(min + 5), finishedAt: at(min), data: d }, at(min));
    };
    await put("plan-old", "plan", 300, { coverage: cov });
    await put("plan-bare", "plan", 200);
    await put("cve-1", "cve", 150, { advisories: [] });
    await put("plan-failed", "plan", 100, { coverage: cov, error: "boom" }, false);
    expect(await readPlanCoverage(prisma)).toEqual([
      { job: "plan", runId: "plan-failed", ok: false, finishedAt: at(100), coverage: cov },
      { job: "plan", runId: "plan-bare", ok: true, finishedAt: at(200), coverage: null },
      { job: "plan", runId: "plan-old", ok: true, finishedAt: at(300), coverage: cov },
    ]);
    expect((await readPlanCoverage(prisma, 1)).map((r) => r.runId)).toEqual(["plan-failed"]);
  });
});
