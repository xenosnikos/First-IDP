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
import { enqueueLifecycleRequest, lifecycleHistory, readRequests, readSignoffs, readSnapshots } from "../lifecycle";
import { SIGNOFF_AUDIT_ACTION } from "../lifecycle-model";
import { CLAIM_TIMEOUT_MS, PENDING_EXPIRY_MS, handleClaim, handleIngest, prismaLifecycleStore } from "../lifecycle-ingest";
import { KEY } from "./lifecycle-fixtures";

const url = process.env.LIFECYCLE_TEST_DATABASE_URL;
const NOW = new Date("2026-11-25T12:00:00.123Z");
const TOKEN = "pg-test-token-".repeat(4);

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
    await prisma.auditLog.deleteMany({ where: { OR: [{ action: { startsWith: "lifecycle." } }, { action: SIGNOFF_AUDIT_ACTION }] } });
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
        { id: "cmfresh0001", kind: "smoke", params: { scope: "preview", bundleKey: KEY, targets: [{ name: "s", baseUrl: "https://plo-2611-s.prv.twizz.com" }] }, requestedBy: "igor", createdAt: new Date(NOW.getTime() - 60_000) },
      ],
    });
    const res = await handleClaim(new Request("http://x/api/lifecycle/requests/claim", { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } }), { store: prismaLifecycleStore(prisma), token: TOKEN, now: () => NOW });
    expect(await res.json()).toEqual({ request: { id: "cmfresh0001", kind: "smoke", params: { scope: "preview", bundleKey: KEY, targets: [{ name: "s", baseUrl: "https://plo-2611-s.prv.twizz.com" }] } } });
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
    expect(await store.requestStatus("cmreq0000")).toBe("done");
    expect(await store.requestStatus("cmnope")).toBeNull();
  });

  it("ingest end to end: insert, replace on runId, retention, audit, history without payloads", async () => {
    const store = prismaLifecycleStore(prisma);
    const ingest = (body: unknown, at: Date) =>
      handleIngest(new Request("http://x/api/lifecycle/ingest", { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) }), { store, token: TOKEN, now: () => at });
    const first = (await (await ingest(doc("run-a", "plan", { ok: false, error: "kube: timeout", requestId: "cmreq0000" }), NOW)).json()) as { id: string };
    const again = (await (await ingest(doc("run-a"), new Date(NOW.getTime() + 1000))).json()) as { id: string };
    expect(again.id).toBe(first.id);
    expect(await prisma.lifecycleSnapshot.count()).toBe(1);
    const row = await prisma.lifecycleSnapshot.findUniqueOrThrow({ where: { runId: "run-a" } });
    expect(row).toMatchObject({ ok: true, job: "plan" });
    expect(row.createdAt.toISOString()).toBe(new Date(NOW.getTime() + 1000).toISOString());
    expect(row.finishedAt.toISOString()).toBe("2026-11-25T11:55:00.000Z");

    await store.upsertSnapshot({ job: "cve", runId: "cve-1", ok: false, startedAt: NOW, finishedAt: NOW, data: doc("cve-1", "cve", { ok: false, error: "osv: 503", requestId: "cmreq0009" }) }, new Date(NOW.getTime() + 2000));
    for (let i = 0; i < 4; i++) await store.upsertSnapshot({ job: "smoke", runId: `smoke-${i}`, ok: true, startedAt: NOW, finishedAt: NOW, data: doc(`smoke-${i}`, "smoke") }, new Date(NOW.getTime() + 3000 + i));
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
    const smoke = { scope: "preview" as const, bundleKey: KEY, targets: [{ name: "s", baseUrl: "https://plo-2611-s.prv.twizz.com" }] };
    expect((await enqueueLifecycleRequest(prisma, { kind: "cve", params: {}, requestedBy: "nick" })).created).toBe(true);
    expect((await enqueueLifecycleRequest(prisma, { kind: "smoke", params: smoke, requestedBy: "nick" })).created).toBe(true);
    expect((await enqueueLifecycleRequest(prisma, { kind: "smoke", params: smoke, requestedBy: "igor" })).created).toBe(false);
    expect((await enqueueLifecycleRequest(prisma, { kind: "smoke", params: { ...smoke, scope: "stg" }, requestedBy: "nick" })).created).toBe(true);

    // once the first is finished, the same kind may be queued again
    const store = prismaLifecycleStore(prisma);
    const claimed = await store.claimOldestPending(NOW);
    await store.finishClaimed(claimed!.id, { status: "done", error: null, runId: null }, NOW);
    expect((await enqueueLifecycleRequest(prisma, { kind: "plan", params: {}, requestedBy: "nick" })).created).toBe(true);
    await expect(enqueueLifecycleRequest(prisma, { kind: "plan", params: { stage: "prod" } as never, requestedBy: "nick" })).rejects.toThrow();
    expect((await readRequests(prisma)).length).toBe(5);
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
  });
});
