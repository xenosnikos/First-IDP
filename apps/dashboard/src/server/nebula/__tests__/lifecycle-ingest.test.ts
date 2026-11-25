import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIFECYCLE_LIMITS } from "@twizz-idp/shared";
import {
  AUDIT,
  CLAIM_TIMEOUT_MS,
  COMPLETE_BODY_BYTES,
  PENDING_EXPIRY_MS,
  SNAPSHOT_RETENTION,
  checkIngestAuth,
  handleClaim,
  handleComplete,
  handleIngest,
  readCappedBody,
  type AuditWrite,
  identifyIngestCaller,
  sameJson,
  type ClaimedRequest,
  type IngestDeps,
  type LifecycleIngestStore,
  type SnapshotWrite,
} from "../lifecycle-ingest";
import { lifecycleBundleKey } from "@twizz-idp/actions";
import { KEY } from "./lifecycle-fixtures";

const TOKEN = "t0ken-".repeat(8); // 48 chars
const NOW = new Date("2026-11-25T12:00:00.000Z");
const URL_BASE = "http://dashboard.nebula.svc.cluster.local/api/lifecycle";

type Req = { id: string; kind: string; params: unknown; status: string; createdAt: Date; claimedAt: Date | null; finishedAt: Date | null; runId: string | null; error: string | null };

/** An in-memory store. `claimOldestPending` finds and marks in one synchronous
 * step — the property the SQL statement provides in Postgres. `transaction`
 * has the property a database transaction provides: when the callback throws,
 * every write it made (snapshots, requests, audit rows) is undone. */
class FakeStore implements LifecycleIngestStore {
  snapshots: Array<SnapshotWrite & { id: string; createdAt: Date }> = [];
  requests: Req[] = [];
  audits: AuditWrite[] = [];
  calls: string[] = [];
  failAudit = false;
  /** fail only the audit rows of this action */
  failAuditOf: string | null = null;
  failInsert = false;
  private n = 0;
  private depth = 0;

  async transaction<T>(fn: (tx: LifecycleIngestStore) => Promise<T>): Promise<T> {
    if (this.depth > 0) return fn(this);
    const before = { snapshots: this.snapshots.map((x) => ({ ...x })), requests: this.requests.map((x) => ({ ...x })), audits: [...this.audits] };
    this.depth += 1;
    try {
      return await fn(this);
    } catch (e) {
      // rollback: restore the rows IN PLACE so references a test holds stay valid
      this.snapshots = before.snapshots;
      for (const r of this.requests) Object.assign(r, before.requests.find((x) => x.id === r.id));
      this.requests = this.requests.filter((r) => before.requests.some((x) => x.id === r.id));
      this.audits = before.audits;
      throw e;
    } finally {
      this.depth -= 1;
    }
  }
  async findSnapshot(runId: string) {
    this.calls.push("findSnapshot");
    const s = this.snapshots.find((x) => x.runId === runId);
    // what Postgres hands back: the JSON document, not the object that was written
    return s ? { id: s.id, job: s.job, data: JSON.parse(JSON.stringify(s.data)) as unknown } : null;
  }
  async insertSnapshot(row: SnapshotWrite, now: Date) {
    this.calls.push("insertSnapshot");
    if (this.failInsert) throw new Error("connection refused to postgres://nebula:hunter2@db");
    if (this.snapshots.some((s) => s.runId === row.runId)) throw new Error("Unique constraint failed on the fields: (`runId`)");
    this.n += 1;
    const id = `cmsnap${String(this.n).padStart(6, "0")}`;
    this.snapshots.push({ ...row, id, createdAt: now });
    return { id };
  }
  async bindRun(id: string, runId: string) {
    this.calls.push("bindRun");
    const r = this.requests.find((x) => x.id === id && x.status === "claimed" && x.runId === null);
    if (!r) return false;
    r.runId = runId;
    return true;
  }
  async getRequest(id: string) {
    this.calls.push("getRequest");
    const r = this.requests.find((x) => x.id === id);
    return r ? { id: r.id, kind: r.kind, params: r.params, status: r.status, runId: r.runId } : null;
  }

  addRequest(kind: string, over: Partial<Req> = {}): Req {
    this.n += 1;
    const r: Req = { id: `cmreq${String(this.n).padStart(6, "0")}`, kind, params: {}, status: "pending", createdAt: new Date(NOW.getTime() - 60_000), claimedAt: null, finishedAt: null, runId: null, error: null, ...over };
    this.requests.push(r);
    return r;
  }
  async pruneSnapshots(job: string, keep: number) {
    this.calls.push("pruneSnapshots");
    const mine = this.snapshots.filter((s) => s.job === job).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1));
    const drop = new Set(mine.slice(keep).map((s) => s.id));
    this.snapshots = this.snapshots.filter((s) => !drop.has(s.id));
    return drop.size;
  }
  async expireRequests(now: Date, pendingBefore: Date, claimedBefore: Date) {
    this.calls.push("expireRequests");
    let expired = 0;
    let failed = 0;
    for (const r of this.requests) {
      if (r.status === "pending" && r.createdAt < pendingBefore) {
        Object.assign(r, { status: "expired", finishedAt: now, error: "not claimed within 24 h" });
        expired += 1;
      } else if (r.status === "claimed" && r.claimedAt && r.claimedAt < claimedBefore) {
        Object.assign(r, { status: "failed", finishedAt: now, error: "claimed but not completed within 2 h" });
        failed += 1;
      }
    }
    return { expired, failed };
  }
  async claimOldestPending(now: Date): Promise<ClaimedRequest | null> {
    this.calls.push("claimOldestPending");
    const next = this.requests.filter((r) => r.status === "pending").sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))[0];
    if (!next) return null;
    next.status = "claimed";
    next.claimedAt = now;
    return { id: next.id, kind: next.kind, params: next.params };
  }
  async finishClaimed(id: string, patch: { status: "done" | "failed"; error: string | null; runId: string | null }, now: Date) {
    this.calls.push("finishClaimed");
    const r = this.requests.find((x) => x.id === id && x.status === "claimed");
    if (!r) return false;
    Object.assign(r, patch, { finishedAt: now });
    return true;
  }
  async audit(entry: AuditWrite) {
    this.calls.push("audit");
    if (this.failAudit || (this.failAuditOf !== null && entry.action === this.failAuditOf && entry.allowed)) throw new Error("audit table unavailable");
    this.audits.push(entry);
  }
}

const deps = (store: FakeStore, over: Partial<IngestDeps> = {}): IngestDeps => ({ store, token: TOKEN, now: () => NOW, ...over });
const auth = (token = TOKEN) => ({ authorization: `Bearer ${token}` });

function post(path: string, body: unknown, headers: Record<string, string> = auth()): Request {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Request(`${URL_BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: text });
}

/** a valid snapshot body; `over` is deliberately untyped — most tests send something invalid */
function snapshot(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    job: "plan",
    runId: "run-1",
    startedAt: "2026-11-25T11:50:00.000Z",
    finishedAt: "2026-11-25T11:55:00.000Z",
    ok: true,
    schedule: [{ job: "plan", cron: "0 6 * * 1", runner: "nebula", description: "plan", mutates: false }],
    discoveryErrors: [],
    components: [],
    ...over,
  };
}

/** a streaming body that records whether anyone read it */
function streamBody(chunks: Uint8Array[]) {
  const seen = { pulls: 0, cancelled: false };
  let i = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(c) {
        seen.pulls += 1;
        if (i < chunks.length) c.enqueue(chunks[i++]);
        else c.close();
      },
      cancel() {
        seen.cancelled = true;
      },
    },
    // no read-ahead: `pull` runs only when a consumer actually reads
    { highWaterMark: 0 },
  );
  return { body, seen };
}
/** a Request-shaped object: lets a test set any content-length and a streamed body */
const rawRequest = (headers: Record<string, string>, body: ReadableStream<Uint8Array> | null) => ({ headers: new Headers(headers), body }) as unknown as Request;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("checkIngestAuth", () => {
  it("fails closed (503) when the token is unset or shorter than 32 chars — even for a matching header", () => {
    for (const token of [undefined, "", "short", "x".repeat(31)]) {
      expect(checkIngestAuth(`Bearer ${token ?? ""}`, token)).toMatchObject({ ok: false, status: 503 });
      expect(checkIngestAuth(null, token)).toMatchObject({ ok: false, status: 503 });
    }
    expect(checkIngestAuth(`Bearer ${"x".repeat(32)}`, "x".repeat(32))).toEqual({ ok: true });
  });

  it("accepts exactly `Bearer <token>`", () => {
    expect(checkIngestAuth(`Bearer ${TOKEN}`, TOKEN)).toEqual({ ok: true });
    for (const header of [null, undefined, "", TOKEN, `Bearer`, `Bearer `, `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(0, -1)}`, `Bearer ${TOKEN.toUpperCase()}`, `Bearer ${TOKEN} `, `Bearer  ${TOKEN}`, `Basic ${TOKEN}`, `bearer ${TOKEN}`, `Bearer ${TOKEN} extra`, `Bearer ${TOKEN}\n`]) {
      expect(checkIngestAuth(header, TOKEN), JSON.stringify(header)).toMatchObject({ ok: false, status: 401 });
    }
  });

  it("an empty bearer never matches, whatever the configured token", () => {
    expect(checkIngestAuth("Bearer ", "x".repeat(40)).ok).toBe(false);
    expect(checkIngestAuth("", "x".repeat(40)).ok).toBe(false);
  });

  it("reads LIFECYCLE_INGEST_TOKEN from the environment by default", () => {
    vi.stubEnv("LIFECYCLE_INGEST_TOKEN", TOKEN);
    expect(checkIngestAuth(`Bearer ${TOKEN}`)).toEqual({ ok: true });
    vi.stubEnv("LIFECYCLE_INGEST_TOKEN", "");
    expect(checkIngestAuth(`Bearer ${TOKEN}`)).toMatchObject({ ok: false, status: 503 });
  });

  it("compares digests with timingSafeEqual (no early-exit string compare)", () => {
    const src = readFileSync(resolve(__dirname, "../lifecycle-ingest.ts"), "utf8");
    expect(src).toMatch(/timingSafeEqual\(presented, sha256\(token\)\)/);
    expect(src).not.toMatch(/===\s*token|token\s*===/);
  });
});

describe("every endpoint authenticates before it does anything", () => {
  const endpoints: Array<[string, (req: Request, d: IngestDeps) => Promise<Response>]> = [
    ["ingest", (req, d) => handleIngest(req, d)],
    ["claim", (req, d) => handleClaim(req, d)],
    ["complete", (req, d) => handleComplete(req, "cmreq000001", d)],
  ];

  it.each(endpoints)("%s: 503 when the server has no usable token; nothing is read or written", async (_name, call) => {
    for (const token of [undefined, "", "x".repeat(31)]) {
      const store = new FakeStore();
      store.addRequest("plan");
      const { body, seen } = streamBody([new TextEncoder().encode(JSON.stringify(snapshot()))]);
      const res = await call(rawRequest({ authorization: `Bearer ${token ?? ""}` }, body), deps(store, { token }));
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("60");
      expect(store.calls).toEqual([]);
      expect(seen.pulls).toBe(0);
      expect(store.requests[0].status).toBe("pending");
    }
  });

  it.each(endpoints)("%s: 401 without the right bearer; the body is not read, the store is not touched", async (_name, call) => {
    for (const header of [undefined, "Bearer wrong-wrong-wrong-wrong-wrong-wrong", `Basic ${TOKEN}`]) {
      const store = new FakeStore();
      store.addRequest("plan");
      const { body, seen } = streamBody([new TextEncoder().encode(JSON.stringify(snapshot()))]);
      const res = await call(rawRequest(header ? { authorization: header } : {}, body), deps(store));
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
      expect(await res.json()).toEqual({ error: "invalid or missing bearer token" });
      expect(store.calls).toEqual([]);
      expect(seen.pulls).toBe(0);
      expect(store.snapshots).toHaveLength(0);
      expect(store.requests[0].status).toBe("pending");
    }
  });

  it.each(endpoints)("%s: uses the environment token when none is injected", async (_name, call) => {
    vi.stubEnv("LIFECYCLE_INGEST_TOKEN", "");
    const store = new FakeStore();
    expect((await call(post("/x", snapshot()), { store })).status).toBe(503);
    vi.stubEnv("LIFECYCLE_INGEST_TOKEN", TOKEN);
    expect((await call(post("/x", snapshot(), auth("nope-nope-nope-nope-nope-nope-nope")), { store })).status).toBe(401);
    expect((await call(post("/x", snapshot()), { store })).status).not.toBe(401);
  });
});

describe("routes and middleware", () => {
  const apiDir = resolve(__dirname, "../../../app/api/lifecycle");
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));

  it("the three route files are thin: POST only, each delegating to an authenticating handler", () => {
    const files = walk(apiDir).map((f) => f.slice(apiDir.length + 1)).sort();
    expect(files).toEqual(["ingest/route.ts", "requests/[id]/complete/route.ts", "requests/claim/route.ts"]);
    const handler: Record<string, string> = { "ingest/route.ts": "handleIngest", "requests/claim/route.ts": "handleClaim", "requests/[id]/complete/route.ts": "handleComplete" };
    for (const f of files) {
      const src = readFileSync(join(apiDir, f), "utf8");
      expect(src.match(/export (async )?function (\w+)/g)?.map((m) => m.split(" ").pop())).toEqual(["POST"]);
      expect(src).toContain(`return ${handler[f]}(req, `);
      expect(src).not.toMatch(/auth\(\)|getServerSession|cookies\(/);
      expect(src).toContain('export const dynamic = "force-dynamic"');
    }
  });

  it("the session middleware does not cover /api/lifecycle (these are bearer-token machine routes)", () => {
    const src = readFileSync(resolve(__dirname, "../../../middleware.ts"), "utf8");
    const matcher = /matcher:\s*\[([^\]]*)\]/.exec(src);
    expect(matcher).not.toBeNull();
    const entries = [...matcher![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.startsWith("/api")).toBe(false);
      // a matcher is a path prefix pattern: none may be a prefix of the lifecycle API
      expect("/api/lifecycle/ingest".startsWith(e.replace(/\/:path\*$/, ""))).toBe(false);
    }
  });
});

describe("readCappedBody", () => {
  it("refuses a declared length over the cap without reading a byte", async () => {
    const { body, seen } = streamBody([new Uint8Array(10)]);
    expect(await readCappedBody(rawRequest({ "content-length": "101" }, body), 100)).toEqual({ ok: false, status: 413, message: "body exceeds 100 bytes" });
    expect(seen.pulls).toBe(0);
  });

  it("cuts off a body that grows past the cap whatever it declared", async () => {
    for (const headers of [{}, { "content-length": "10" }] as Array<Record<string, string>>) {
      const { body, seen } = streamBody([new Uint8Array(60), new Uint8Array(60), new Uint8Array(60)]);
      expect(await readCappedBody(rawRequest(headers, body), 100)).toMatchObject({ ok: false, status: 413 });
      expect(seen.cancelled).toBe(true);
      expect(seen.pulls).toBeLessThan(4);
    }
  });

  it("accepts a body exactly at the cap and reassembles chunks", async () => {
    const enc = new TextEncoder();
    const { body } = streamBody([enc.encode('{"a":'), enc.encode('"é"}')]);
    const r = await readCappedBody(rawRequest({}, body), 11);
    expect(r).toEqual({ ok: true, text: '{"a":"é"}', bytes: 10 });
    const exact = streamBody([new Uint8Array(100).fill(0x20)]);
    expect(await readCappedBody(rawRequest({ "content-length": "100" }, exact.body), 100)).toMatchObject({ ok: true, bytes: 100 });
  });

  it("rejects a malformed content-length and invalid UTF-8; an absent body is empty", async () => {
    expect(await readCappedBody(rawRequest({ "content-length": "-1" }, null), 100)).toMatchObject({ ok: false, status: 400 });
    expect(await readCappedBody(rawRequest({ "content-length": "1e9" }, null), 100)).toMatchObject({ ok: false, status: 400 });
    expect(await readCappedBody(rawRequest({}, streamBody([new Uint8Array([0xff, 0xfe, 0xfd])]).body), 100)).toEqual({ ok: false, status: 400, message: "body is not valid UTF-8" });
    expect(await readCappedBody(rawRequest({}, null), 100)).toEqual({ ok: true, text: "", bytes: 0 });
  });
});

describe("POST /api/lifecycle/ingest", () => {
  it("stores a valid snapshot, answers {id} and writes the lifecycle.ingest audit row", async () => {
    const store = new FakeStore();
    const res = await handleIngest(post("/ingest", snapshot({ runId: "2026-11-25.plan" })), deps(store));
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    expect(store.snapshots).toHaveLength(1);
    expect(store.snapshots[0]).toMatchObject({ id, job: "plan", runId: "2026-11-25.plan", ok: true, createdAt: NOW, startedAt: new Date("2026-11-25T11:50:00.000Z"), finishedAt: new Date("2026-11-25T11:55:00.000Z") });
    expect(store.audits).toEqual([{ action: "lifecycle.ingest", resource: "2026-11-25.plan", allowed: true, detail: expect.objectContaining({ id, job: "plan", ok: true, components: 0, advisories: 0, bundles: 0, pruned: 0, requestId: null }) }]);
    expect(AUDIT.ingest).toBe("lifecycle.ingest");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects a body over 4 MB BEFORE parsing it", async () => {
    const parse = vi.spyOn(JSON, "parse");
    const store = new FakeStore();
    // declared too large
    const declared = streamBody([new Uint8Array(8)]);
    const r1 = await handleIngest(rawRequest({ ...auth(), "content-length": String(LIFECYCLE_LIMITS.bodyBytes + 1) }, declared.body), deps(store));
    expect(r1.status).toBe(413);
    expect(declared.seen.pulls).toBe(0);
    // chunked, no content-length: valid JSON, just too much of it
    const big = new TextEncoder().encode(JSON.stringify(snapshot({ error: "x".repeat(1500) })).replace("{", `{"pad":"${"p".repeat(1024 * 1024)}",`));
    const chunked = streamBody([big, big, big, big, big]);
    const r2 = await handleIngest(rawRequest(auth(), chunked.body), deps(store));
    expect(r2.status).toBe(413);
    expect(chunked.seen.cancelled).toBe(true);
    expect(parse).not.toHaveBeenCalled();
    expect(store.snapshots).toHaveLength(0);
    expect(store.calls.filter((c) => c !== "audit")).toEqual([]);
    expect(store.audits.every((a) => a.allowed === false)).toBe(true);
  });

  it("accepts a body just under the cap", async () => {
    const store = new FakeStore();
    const filler = "f".repeat(1990);
    const doc = snapshot({ discoveryErrors: Array.from({ length: 1900 }, (_, i) => ({ domain: `d${i}`, error: filler })) });
    const bytes = new TextEncoder().encode(JSON.stringify(doc)).byteLength;
    expect(bytes).toBeGreaterThan(3.5 * 1024 * 1024);
    expect(bytes).toBeLessThanOrEqual(LIFECYCLE_LIMITS.bodyBytes);
    expect((await handleIngest(post("/ingest", doc), deps(store))).status).toBe(200);
  });

  it("400 on a body that is not JSON", async () => {
    const store = new FakeStore();
    for (const body of ["", "{", "not json", "\u0000"]) {
      const res = await handleIngest(post("/ingest", body), deps(store));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "body is not JSON" });
    }
    expect(store.snapshots).toHaveLength(0);
  });

  it("400 with Zod issue paths and codes — never the offending values — on an invalid snapshot", async () => {
    const store = new FakeStore();
    const res = await handleIngest(post("/ingest", snapshot({ job: "ghp_LEAKEDSECRET", runId: "bad id LEAKEDSECRET", components: [{ id: "c1", tier: "LEAKEDSECRET" }] })), deps(store));
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain("LEAKEDSECRET");
    const body = JSON.parse(text) as { error: string; issues: Array<{ path: string; code: string }> };
    expect(body.error).toBe("invalid snapshot");
    expect(body.issues.map((i) => i.path)).toEqual(expect.arrayContaining(["job", "runId", "components.0.tier", "components.0.name"]));
    expect(body.issues.every((i) => Object.keys(i).sort().join() === "code,path")).toBe(true);
    expect(store.snapshots).toHaveLength(0);
    // the refusal is audited, also without values
    expect(store.audits).toHaveLength(1);
    expect(store.audits[0]).toMatchObject({ action: "lifecycle.ingest", allowed: false, detail: { reason: "invalid snapshot" } });
    expect(JSON.stringify(store.audits)).not.toContain("LEAKEDSECRET");
  });

  it.each([
    ["a string over 2000 chars", snapshot({ error: "e".repeat(2001) }), "error"],
    ["more than 5000 components", snapshot({ components: Array.from({ length: 5001 }, (_, i) => ({ id: `c${i}`, tier: "npm-transitive", domain: "npm-dependency", name: "x", target: "r", environments: [], current: "1", desired: null, latest: null, bump: "none", status: "current", autonomy: "ignore", reasons: [], rollback: "none" })) }), "components"],
    ["more than 2000 advisories", snapshot({ job: "cve", advisories: Array.from({ length: 2001 }, (_, i) => ({ id: `A${i}`, aliases: [], source: "osv", severity: "low", kev: false, summary: "", url: "", affected: [] })) }), "advisories"],
    ["an unknown schema version", snapshot({ schemaVersion: 2 }), "schemaVersion"],
    ["a non-object", [] as unknown as Record<string, unknown>, "(root)"],
  ])("rejects %s", async (_name, doc, path) => {
    const store = new FakeStore();
    const res = await handleIngest(post("/ingest", doc), deps(store));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { issues: Array<{ path: string }> }).issues.map((i) => i.path)).toContain(path);
    expect(store.snapshots).toHaveLength(0);
  });

  it("rejects a run that finished before it started or in the future", async () => {
    const store = new FakeStore();
    const backwards = await handleIngest(post("/ingest", snapshot({ startedAt: "2026-11-25T11:55:00Z", finishedAt: "2026-11-25T11:50:00Z" })), deps(store));
    expect(backwards.status).toBe(400);
    expect(await backwards.json()).toEqual({ error: "invalid snapshot", issues: [{ path: "finishedAt", code: "before_startedAt" }] });
    const future = await handleIngest(post("/ingest", snapshot({ finishedAt: "2026-11-25T12:10:00.001Z" })), deps(store));
    expect(await future.json()).toEqual({ error: "invalid snapshot", issues: [{ path: "finishedAt", code: "in_the_future" }] });
    // up to 10 minutes of clock skew is tolerated
    expect((await handleIngest(post("/ingest", snapshot({ finishedAt: "2026-11-25T12:10:00.000Z" })), deps(store))).status).toBe(200);
    expect(store.snapshots).toHaveLength(1);
  });

  it("stores only the parsed snapshot: unknown keys (Helm values, run.json data) never reach the database", async () => {
    const store = new FakeStore();
    const res = await handleIngest(
      post("/ingest", snapshot({ data: { values: { adminPassword: "hunter2" } }, env: { GH_TOKEN: "ghp_x" }, components: [{ id: "h1", tier: "helm", domain: "helm-release", name: "argo-cd", target: "EKS-Twizz-NonProd", environments: ["dev"], current: "7.0.0", desired: "7.1.0", latest: "7.1.0", bump: "minor", status: "outdated", autonomy: "approval", reasons: [], rollback: "supported", values: { secret: "hunter2" } }] })),
      deps(store),
    );
    expect(res.status).toBe(200);
    const stored = JSON.stringify(store.snapshots[0].data);
    expect(stored).not.toMatch(/hunter2|ghp_x|adminPassword|GH_TOKEN/);
    expect(store.snapshots[0].data.components?.[0]).toMatchObject({ id: "h1", name: "argo-cd" });
    expect(JSON.stringify(store.audits)).not.toMatch(/hunter2|ghp_x/);
  });

  it("is idempotent on runId: the SAME snapshot again is a 200 that changes nothing; a different one under that runId is a 409 — a stored snapshot is never replaced", async () => {
    const store = new FakeStore();
    const body = snapshot({ runId: "r1", ok: false, error: "partial" });
    const first = (await (await handleIngest(post("/ingest", body), deps(store))).json()) as { id: string };
    const later = new Date(NOW.getTime() + 5_000);
    // PLO's retry after a lost answer: the same bytes
    const retry = await handleIngest(post("/ingest", body), deps(store, { now: () => later }));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ id: first.id, duplicate: true });
    expect(store.snapshots).toHaveLength(1);
    expect(store.snapshots[0]).toMatchObject({ ok: false, createdAt: NOW });
    // the same runId with other content would rewrite what Nebula already recorded: refused, audited, nothing changed
    const rewrite = await handleIngest(post("/ingest", snapshot({ runId: "r1", ok: true, finishedAt: "2026-11-25T11:58:00.000Z" })), deps(store, { now: () => later }));
    expect(rewrite.status).toBe(409);
    expect(((await rewrite.json()) as { error: string }).error).toMatch(/already stored with different content/);
    expect(store.snapshots).toHaveLength(1);
    expect(store.snapshots[0]).toMatchObject({ ok: false, createdAt: NOW, finishedAt: new Date("2026-11-25T11:55:00.000Z") });
    expect(store.snapshots[0].data.error).toBe("partial");
    // …nor under another job
    expect((await handleIngest(post("/ingest", snapshot({ runId: "r1", job: "cve", components: undefined, advisories: [] })), deps(store))).status).toBe(409);
    expect(store.audits.map((a) => [a.allowed, (a.detail as { duplicate?: boolean }).duplicate ?? false])).toEqual([[true, false], [true, true], [false, false], [false, false]]);
    // a different runId is a different row
    await handleIngest(post("/ingest", snapshot({ runId: "r2" })), deps(store));
    expect(store.snapshots).toHaveLength(2);
  });

  it("sameJson ignores key order (jsonb does not keep it) and nothing else", () => {
    expect(sameJson({ a: 1, b: [1, { c: 2, d: null }] }, { b: [1, { d: null, c: 2 }], a: 1 })).toBe(true);
    expect(sameJson({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(sameJson({ a: 1 }, { a: "1" })).toBe(false);
    expect(sameJson([1, 2], [2, 1])).toBe(false);
    expect(sameJson({ a: [] }, { a: {} })).toBe(false);
    expect(sameJson({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(sameJson(null, {})).toBe(false);
  });

  it(`keeps the newest ${SNAPSHOT_RETENTION} snapshots per job`, async () => {
    expect(SNAPSHOT_RETENTION).toBe(60);
    const store = new FakeStore();
    for (let i = 0; i < 65; i++) {
      const at = new Date(NOW.getTime() - (65 - i) * 60_000);
      await handleIngest(post("/ingest", snapshot({ runId: `plan-${i}`, startedAt: at.toISOString(), finishedAt: at.toISOString() })), deps(store, { now: () => at }));
    }
    for (let i = 0; i < 3; i++) await handleIngest(post("/ingest", snapshot({ job: "cve", runId: `cve-${i}` })), deps(store));
    const plans = store.snapshots.filter((s) => s.job === "plan").map((s) => s.runId);
    expect(plans).toHaveLength(60);
    expect(plans).not.toContain("plan-4");
    expect(plans).toContain("plan-5");
    expect(plans).toContain("plan-64");
    expect(store.snapshots.filter((s) => s.job === "cve")).toHaveLength(3);
    expect(store.audits.filter((a) => (a.detail as { pruned: number }).pruned === 1)).toHaveLength(5);
  });

  it("an identical re-post is not a newer row and prunes nothing", async () => {
    const store = new FakeStore();
    for (let i = 0; i < 60; i++) {
      const at = new Date(NOW.getTime() - (100 - i) * 60_000);
      await handleIngest(post("/ingest", snapshot({ runId: `plan-${i}`, startedAt: at.toISOString(), finishedAt: at.toISOString() })), deps(store, { now: () => at }));
    }
    const first = new Date(NOW.getTime() - 100 * 60_000);
    const res = await handleIngest(post("/ingest", snapshot({ runId: "plan-0", startedAt: first.toISOString(), finishedAt: first.toISOString() })), deps(store));
    const { id } = (await res.json()) as { id: string };
    expect(store.snapshots.find((s) => s.id === id)).toMatchObject({ runId: "plan-0", createdAt: first });
    expect(store.snapshots).toHaveLength(60);
  });

  it("500 (so PLO retries) when the snapshot or its audit row cannot be written — and leaks nothing", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const noAudit = new FakeStore();
    noAudit.failAudit = true;
    const r1 = await handleIngest(post("/ingest", snapshot()), deps(noAudit));
    expect(r1.status).toBe(500);
    const noDb = new FakeStore();
    noDb.failInsert = true;
    const r2 = await handleIngest(post("/ingest", snapshot()), deps(noDb));
    expect(r2.status).toBe(500);
    expect(await r2.text()).toBe('{"error":"could not store the snapshot"}');
    // the server log gets the reason, with connection-string credentials removed
    expect(log).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(log.mock.calls)).toContain("connection refused to postgres://***@db");
    expect(JSON.stringify(log.mock.calls)).not.toContain("hunter2");
  });

  it("a refusal stays a 4xx even when its audit row cannot be written", async () => {
    const store = new FakeStore();
    store.failAudit = true;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await handleIngest(post("/ingest", "{"), deps(store))).status).toBe(400);
    expect((await handleIngest(post("/ingest", snapshot({ job: "nope" })), deps(store))).status).toBe(400);
  });
});

describe("POST /api/lifecycle/requests/claim", () => {
  const smokeParams = { scope: "preview", bundleKey: KEY, targets: [{ name: "twizz-sentinel", baseUrl: "http://twizz-sentinel.env-plo-2611-twizz-sentinel.svc.cluster.local:8090" }] };
  const claim = async (store: FakeStore, over: Partial<IngestDeps> = {}) => {
    const res = await handleClaim(post("/requests/claim", ""), deps(store, over));
    return { status: res.status, body: (await res.json()) as { request: { id: string; kind: string; params: unknown } | null } };
  };

  it("answers {request: null} when nothing is pending", async () => {
    const store = new FakeStore();
    store.addRequest("plan", { status: "done" });
    expect(await claim(store)).toEqual({ status: 200, body: { request: null } });
    expect(store.audits).toEqual([]);
  });

  it("claims the OLDEST pending request and returns {id, kind, params}", async () => {
    const store = new FakeStore();
    const newer = store.addRequest("cve", { createdAt: new Date(NOW.getTime() - 60_000) });
    const older = store.addRequest("smoke", { createdAt: new Date(NOW.getTime() - 3_600_000), params: smokeParams });
    const first = await claim(store);
    expect(first.body.request).toEqual({ id: older.id, kind: "smoke", params: smokeParams });
    expect(older).toMatchObject({ status: "claimed", claimedAt: NOW });
    expect(newer.status).toBe("pending");
    expect((await claim(store)).body.request).toEqual({ id: newer.id, kind: "cve", params: {} });
    expect((await claim(store)).body.request).toBeNull();
    expect(store.audits.map((a) => [a.action, a.resource, a.allowed])).toEqual([
      ["lifecycle.request.claim", older.id, true],
      ["lifecycle.request.claim", newer.id, true],
    ]);
  });

  it("two dispatchers racing never receive the same request", async () => {
    const store = new FakeStore();
    const ids = Array.from({ length: 3 }, (_, i) => store.addRequest("plan", { createdAt: new Date(NOW.getTime() - (10 - i) * 60_000) }).id);
    const results = await Promise.all(Array.from({ length: 8 }, () => claim(store)));
    const claimed = results.map((r) => r.body.request?.id).filter((x): x is string => !!x);
    expect(claimed.sort()).toEqual([...ids].sort());
    expect(new Set(claimed).size).toBe(claimed.length);
    expect(results.filter((r) => r.body.request === null)).toHaveLength(5);
    expect(store.requests.every((r) => r.status === "claimed")).toBe(true);
  });

  it("expires requests pending for more than 24 h and fails claims older than 2 h, first", async () => {
    expect([PENDING_EXPIRY_MS, CLAIM_TIMEOUT_MS]).toEqual([24 * 3_600_000, 2 * 3_600_000]);
    const store = new FakeStore();
    const stale = store.addRequest("plan", { createdAt: new Date(NOW.getTime() - PENDING_EXPIRY_MS - 1) });
    const hung = store.addRequest("cve", { status: "claimed", createdAt: new Date(NOW.getTime() - 5 * 3_600_000), claimedAt: new Date(NOW.getTime() - CLAIM_TIMEOUT_MS - 1) });
    const working = store.addRequest("cve", { status: "claimed", claimedAt: new Date(NOW.getTime() - CLAIM_TIMEOUT_MS + 1_000) });
    const fresh = store.addRequest("plan", { createdAt: new Date(NOW.getTime() - PENDING_EXPIRY_MS + 1_000) });
    const { body } = await claim(store);
    // the stale one was older, but it is expired — not handed out
    expect(body.request?.id).toBe(fresh.id);
    expect(stale).toMatchObject({ status: "expired", finishedAt: NOW, error: "not claimed within 24 h" });
    expect(hung).toMatchObject({ status: "failed", finishedAt: NOW, error: "claimed but not completed within 2 h" });
    expect(working.status).toBe("claimed");
    expect(store.audits[0]).toEqual({ action: "lifecycle.request.expire", allowed: true, detail: { expired: 1, failed: 1 } });
    expect(store.calls.indexOf("expireRequests")).toBeLessThan(store.calls.indexOf("claimOldestPending"));
  });

  it("never hands PLO a row whose kind or params do not validate: it is failed and the next one is claimed", async () => {
    const store = new FakeStore();
    const t = (m: number) => new Date(NOW.getTime() - m * 60_000);
    const badKind = store.addRequest("run --stage prod --execute", { createdAt: t(50) });
    const badParams = store.addRequest("plan", { createdAt: t(40), params: { stage: "prod", execute: true } });
    // (external review 2026-11-25, idp #12) this row used to carry `extra: 1` as well, so it was refused for the
    // unknown key and the test never showed that the URL itself is refused. Nothing else is wrong with it now.
    const badSmoke = store.addRequest("smoke", { createdAt: t(30), params: { ...smokeParams, targets: [{ name: "twizz-sentinel", baseUrl: "file:///etc/passwd" }] } });
    const imds = store.addRequest("smoke", { createdAt: t(29), params: { ...smokeParams, targets: [{ name: "twizz-sentinel", baseUrl: "http://169.254.169.254" }] } });
    const good = store.addRequest("cve", { createdAt: t(20) });
    const { body } = await claim(store);
    expect(body.request).toEqual({ id: good.id, kind: "cve", params: {} });
    for (const r of [imds]) expect(r).toMatchObject({ status: "failed", error: "request params are not valid for its kind" });
    expect(badKind).toMatchObject({ status: "failed", error: expect.stringMatching(/unknown request kind/) });
    expect(badParams).toMatchObject({ status: "failed", error: "request params are not valid for its kind" });
    expect(badSmoke.status).toBe("failed");
    expect(store.audits.filter((a) => a.action === "lifecycle.request.claim").map((a) => a.allowed)).toEqual([false, false, false, false, true]);
  });

  it("gives up after a bounded number of unusable rows", async () => {
    const store = new FakeStore();
    for (let i = 0; i < 7; i++) store.addRequest("bogus", { createdAt: new Date(NOW.getTime() - (20 - i) * 60_000) });
    expect((await claim(store)).body.request).toBeNull();
    expect(store.requests.filter((r) => r.status === "failed")).toHaveLength(5);
    expect(store.requests.filter((r) => r.status === "pending")).toHaveLength(2);
  });

  it("500 when the store fails", async () => {
    const store = new FakeStore();
    store.addRequest("plan");
    store.failAudit = true;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await claim(store)).status).toBe(500);
  });

  // external review 2026-11-25, idp #10 / gitops #9: the claim used to commit BEFORE its audit row, so an audit
  // failure answered 500 with the request stranded in `claimed` for two hours and nobody running it
  it("a claim whose audit row cannot be written is rolled back: the request is pending again and the next claim gets it", async () => {
    const store = new FakeStore();
    const r = store.addRequest("plan");
    store.failAudit = true;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await claim(store)).status).toBe(500);
    expect(r).toMatchObject({ status: "pending", claimedAt: null });
    expect(store.audits).toEqual([]);
    // the audit table is back: PLO's next attempt gets the very same request, with its audit row
    store.failAudit = false;
    expect((await claim(store)).body.request).toEqual({ id: r.id, kind: "plan", params: {} });
    expect(r.status).toBe("claimed");
    expect(store.audits).toEqual([{ action: "lifecycle.request.claim", resource: r.id, allowed: true, detail: { kind: "plan" } }]);
  });

  it("a bad row that cannot be audited is not silently failed either", async () => {
    const store = new FakeStore();
    const bad = store.addRequest("bogus");
    store.failAudit = true;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await claim(store)).status).toBe(500);
    expect(bad.status).toBe("pending");
  });
});

describe("POST /api/lifecycle/requests/:id/complete", () => {
  const complete = async (store: FakeStore, id: string, body: unknown) => {
    const res = await handleComplete(post(`/requests/${id}/complete`, body), id, deps(store));
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it("moves a claimed request to done, with its runId", async () => {
    const store = new FakeStore();
    const r = store.addRequest("plan", { status: "claimed", claimedAt: new Date(NOW.getTime() - 60_000) });
    expect(await complete(store, r.id, { ok: true, runId: "plan-req-1" })).toEqual({ status: 200, body: { ok: true, status: "done" } });
    expect(r).toMatchObject({ status: "done", finishedAt: NOW, runId: "plan-req-1", error: null });
    expect(store.audits).toEqual([{ action: "lifecycle.request.complete", resource: r.id, allowed: true, detail: { ok: true, runId: "plan-req-1", error: null } }]);
  });

  it("moves a claimed request to failed, keeping the short error", async () => {
    const store = new FakeStore();
    const r = store.addRequest("smoke", { status: "claimed", claimedAt: NOW });
    expect((await complete(store, r.id, { ok: false, error: "host not on the allowlist" })).body).toEqual({ ok: true, status: "failed" });
    expect(r).toMatchObject({ status: "failed", error: "host not on the allowlist", runId: null });
    const silent = store.addRequest("cve", { status: "claimed", claimedAt: NOW });
    await complete(store, silent.id, { ok: false });
    expect(silent.error).toBe("the run failed");
  });

  it("is safe to repeat: a finished request answers 200 and is not changed", async () => {
    const store = new FakeStore();
    const r = store.addRequest("plan", { status: "claimed", claimedAt: NOW });
    await complete(store, r.id, { ok: true, runId: "first" });
    expect(await complete(store, r.id, { ok: false, error: "late retry" })).toEqual({ status: 200, body: { ok: true, status: "done", already: true } });
    expect(r).toMatchObject({ status: "done", runId: "first", error: null });
    expect(store.audits).toHaveLength(1);
  });

  // external review 2026-11-25, idp #10: `done` used to be committed before its audit row; when the audit failed
  // the call was a 500, and PLO's retry got "200 already" — a completed request with no audit row, for ever
  it("a completion whose audit row cannot be written is rolled back: the retry completes it, with its audit row", async () => {
    const store = new FakeStore();
    const r = store.addRequest("plan", { status: "claimed", claimedAt: NOW });
    store.failAudit = true;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await complete(store, r.id, { ok: true, runId: "run-9" })).status).toBe(500);
    expect(r).toMatchObject({ status: "claimed", finishedAt: null, runId: null });
    expect(store.audits).toEqual([]);
    store.failAudit = false;
    expect(await complete(store, r.id, { ok: true, runId: "run-9" })).toEqual({ status: 200, body: { ok: true, status: "done" } });
    expect(r).toMatchObject({ status: "done", runId: "run-9" });
    expect(store.audits).toEqual([{ action: "lifecycle.request.complete", resource: r.id, allowed: true, detail: { ok: true, runId: "run-9", error: null } }]);
  });

  it("409 for a request that was never claimed or has expired", async () => {
    const store = new FakeStore();
    const pending = store.addRequest("plan");
    const expired = store.addRequest("plan", { status: "expired" });
    expect(await complete(store, pending.id, { ok: true })).toEqual({ status: 409, body: { error: "request is pending, not claimed" } });
    expect((await complete(store, expired.id, { ok: true })).status).toBe(409);
    expect(pending.status).toBe("pending");
    expect(store.audits.every((a) => a.allowed === false)).toBe(true);
  });

  it("404 for an unknown or malformed id, without touching the store for the latter", async () => {
    const store = new FakeStore();
    expect((await complete(store, "cmdoesnotexist", { ok: true })).status).toBe(404);
    store.calls.length = 0;
    for (const id of ["", "a", "../../etc", "x".repeat(41), "UPPERCASE1", "a b c d e f"]) {
      expect((await handleComplete(post("/requests/x/complete", { ok: true }), id, deps(store))).status).toBe(404);
    }
    expect(store.calls).toEqual([]);
  });

  it("400 on a bad body; 413 on an oversized one", async () => {
    const store = new FakeStore();
    const r = store.addRequest("plan", { status: "claimed", claimedAt: NOW });
    expect((await complete(store, r.id, "nope")).status).toBe(400);
    expect((await complete(store, r.id, {})).body).toMatchObject({ error: "invalid body", issues: [{ path: "ok", code: "invalid_type" }] });
    expect((await complete(store, r.id, { ok: true, status: "done" })).status).toBe(400);
    expect((await complete(store, r.id, { ok: false, error: "e".repeat(2001) })).status).toBe(400);
    expect((await complete(store, r.id, { ok: true, pad: "p".repeat(COMPLETE_BODY_BYTES) })).status).toBe(413);
    expect(r.status).toBe("claimed");
  });
});

// ── external review 2026-11-25, idp #2 / gitops #1 (dashboard side): what the ingest-token holder can and cannot do ──
describe("the ingest-token holder is not trusted: bundle keys", () => {
  const A = "twizz-app/twizz-sentinel";
  const B = "twizz-app/Moly-backend";
  const bundleOf = (github: string, headSha: string | null) => ({ repo: github.split("/")[1], github, baseBranch: "main", branch: "plo/bundle/2026-11", headSha, included: [], conflicts: [], environments: ["staging"] });
  const source = (over: Record<string, unknown>) => snapshot({ job: "source", runId: "src-1", components: undefined, ...over });
  const issuesOf = async (res: Response) => ((await res.json()) as { issues?: Array<{ path: string; code: string }> }).issues;

  it("lifecycleBundleKey is PLO's formula: sha256 over the sorted `github@headSha` lines of the bundles that have a head", () => {
    const lines = [`${B}@${"b".repeat(40)}`, `${A}@${"a".repeat(40)}`].sort();
    const expected = createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
    expect(lifecycleBundleKey([bundleOf(A, "a".repeat(40)), bundleOf(B, "b".repeat(40)), bundleOf("twizz-app/frontend", null)])).toBe(expected);
    expect(lifecycleBundleKey([bundleOf(B, "b".repeat(40)), bundleOf(A, "a".repeat(40))])).toBe(expected);
    expect(lifecycleBundleKey([bundleOf(A, "a".repeat(40))])).not.toBe(expected);
    expect(lifecycleBundleKey([bundleOf(A, null)])).toBeNull();
    expect(lifecycleBundleKey([])).toBeNull();
  });

  it("a source snapshot is stored only when its bundleKey IS the hash of its bundles", async () => {
    const store = new FakeStore();
    const bundles = [bundleOf(A, "a".repeat(40)), bundleOf(B, "b".repeat(40))];
    const key = lifecycleBundleKey(bundles)!;
    expect((await handleIngest(post("/ingest", source({ bundles, bundleKey: key })), deps(store))).status).toBe(200);
    expect(store.audits.at(-1)?.detail).toMatchObject({ job: "source", bundleKey: key });

    // the laundering move: the SAME key, re-pointed at a commit nobody tested
    const moved = [bundleOf(A, "c".repeat(40)), bundleOf(B, "b".repeat(40))];
    const forged = await handleIngest(post("/ingest", source({ runId: "src-2", bundles: moved, bundleKey: key })), deps(store));
    expect(forged.status).toBe(400);
    expect(await issuesOf(forged)).toEqual([{ path: "bundleKey", code: "not_the_hash_of_bundles" }]);
    // a key with no bundles, bundles with no key, a key although nothing has a head
    for (const body of [source({ runId: "src-3", bundleKey: key }), source({ runId: "src-4", bundles }), source({ runId: "src-5", bundles: [bundleOf(A, null)], bundleKey: key })]) {
      expect((await handleIngest(post("/ingest", body), deps(store))).status).toBe(400);
    }
    // nothing bundled, no key: fine
    expect((await handleIngest(post("/ingest", source({ runId: "src-6", bundles: [bundleOf(A, null)] })), deps(store))).status).toBe(200);
    expect(store.snapshots.map((s) => s.runId)).toEqual(["src-1", "src-6"]);
    expect(store.audits.filter((a) => !a.allowed)).toHaveLength(4);
  });

  it("only a source snapshot may carry a bundle, only a smoke snapshot a smoke result", async () => {
    const store = new FakeStore();
    const bundles = [bundleOf(A, "a".repeat(40))];
    const res = await handleIngest(post("/ingest", snapshot({ job: "cve", runId: "cve-1", components: undefined, advisories: [], bundles, bundleKey: lifecycleBundleKey(bundles) })), deps(store));
    expect(res.status).toBe(400);
    expect(await issuesOf(res)).toEqual([{ path: "bundles", code: "only_in_a_source_snapshot" }, { path: "bundleKey", code: "only_in_a_source_snapshot" }]);
    const smuggled = await handleIngest(post("/ingest", snapshot({ runId: "plan-9", smoke: { scope: "stg", bundleKey: KEY, results: [] } })), deps(store));
    expect(await issuesOf(smuggled)).toEqual([{ path: "smoke", code: "only_in_a_smoke_snapshot" }]);
    const bare = await handleIngest(post("/ingest", snapshot({ job: "smoke", runId: "smoke-9", components: undefined })), deps(store));
    expect(await issuesOf(bare)).toEqual([{ path: "smoke", code: "required_in_a_smoke_snapshot" }, { path: "requestId", code: "required_in_a_smoke_snapshot" }]);
    expect(store.snapshots).toEqual([]);
  });
});

describe("the ingest-token holder is not trusted: smoke results", () => {
  const params = { scope: "preview", bundleKey: KEY, targets: [{ name: "twizz-sentinel", baseUrl: "http://twizz-sentinel.env-plo-2611-twizz-sentinel.svc.cluster.local:8090" }] };
  const result = (ok = true) => ({ name: "twizz-sentinel/health", url: "http://twizz-sentinel.env-plo-2611-twizz-sentinel.svc.cluster.local:8090/health", ok, status: ok ? 200 : 503, ms: 12, detail: ok ? "status 200" : "status 503, expected 200" });
  const smoke = (requestId: string | undefined, over: Record<string, unknown> = {}) =>
    snapshot({ job: "smoke", runId: "smoke-1", components: undefined, ...(requestId ? { requestId } : {}), smoke: { scope: "preview", bundleKey: KEY, results: [result()] }, ...over });
  const ingest = async (store: FakeStore, body: unknown, at = NOW) => {
    const res = await handleIngest(post("/ingest", body), deps(store, { now: () => at }));
    return { status: res.status, body: (await res.json()) as { id?: string; error?: string; duplicate?: boolean } };
  };

  it("is accepted only as the answer to a smoke request Nebula created, while that request is claimed — and binds its run to it", async () => {
    const store = new FakeStore();
    const req = store.addRequest("smoke", { status: "claimed", claimedAt: NOW, params });
    const ok = await ingest(store, smoke(req.id));
    expect(ok.status).toBe(200);
    expect(req.runId).toBe("smoke-1");
    expect(store.snapshots).toHaveLength(1);
    expect(store.audits.at(-1)).toMatchObject({ allowed: true, detail: { job: "smoke", requestId: req.id } });
  });

  it("refuses a smoke result nobody asked for: no such request, another kind, not claimed yet, already completed, expired", async () => {
    const store = new FakeStore();
    const plan = store.addRequest("plan", { status: "claimed", claimedAt: NOW });
    const pending = store.addRequest("smoke", { params });
    const done = store.addRequest("smoke", { status: "done", claimedAt: NOW, finishedAt: NOW, runId: "smoke-0", params });
    const failed = store.addRequest("smoke", { status: "failed", claimedAt: NOW, finishedAt: NOW, params });
    const expired = store.addRequest("smoke", { status: "expired", params });
    const cases: Array<[string, RegExp]> = [
      ["cmdoesnotexist01", /must answer a smoke request Nebula created/],
      [plan.id, /must answer a smoke request Nebula created/],
      [pending.id, /is pending, not claimed/],
      [done.id, /is done, not claimed/],
      [failed.id, /is failed, not claimed/],
      [expired.id, /is expired, not claimed/],
    ];
    for (const [id, why] of cases) {
      const r = await ingest(store, smoke(id, { runId: `forged-${id}` }));
      expect(r.status, id).toBe(409);
      expect(r.body.error, id).toMatch(why);
    }
    expect(store.snapshots).toEqual([]);
    // the retroactive flip: a FAILED real smoke cannot be turned into a pass by a later snapshot
    expect(done.runId).toBe("smoke-0");
    expect(failed.runId).toBeNull();
    expect(store.audits.map((a) => a.allowed)).toEqual(cases.map(() => false));
  });

  it("refuses a result for another scope or another bundle than the request it names", async () => {
    const store = new FakeStore();
    const req = store.addRequest("smoke", { status: "claimed", claimedAt: NOW, params });
    expect((await ingest(store, smoke(req.id, { smoke: { scope: "stg", bundleKey: KEY, results: [result()] } }))).status).toBe(409);
    expect((await ingest(store, smoke(req.id, { smoke: { scope: "preview", bundleKey: "f".repeat(64), results: [result()] } }))).body.error).toMatch(/different scope or bundle/);
    expect(req.runId).toBeNull();
    expect(store.snapshots).toEqual([]);
  });

  it("a request is answered ONCE: a second result, or a rewrite of the first, is refused — a recorded verdict never changes", async () => {
    const store = new FakeStore();
    const req = store.addRequest("smoke", { status: "claimed", claimedAt: NOW, params });
    const failing = smoke(req.id, { runId: "real-run", ok: false, error: "1 of 1 checks failed", smoke: { scope: "preview", bundleKey: KEY, results: [result(false)] } });
    expect((await ingest(store, failing)).status).toBe(200);
    // another pod with the same token posts a green result for the same request…
    const second = await ingest(store, smoke(req.id, { runId: "forged-run" }));
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/already has a result/);
    // …or tries to replace the stored one under its own run id
    const rewrite = await ingest(store, smoke(req.id, { runId: "real-run" }));
    expect(rewrite.status).toBe(409);
    expect(rewrite.body.error).toMatch(/already stored with different content/);
    expect(req.runId).toBe("real-run");
    expect(store.snapshots).toHaveLength(1);
    expect(store.snapshots[0].data.smoke?.results[0].ok).toBe(false);
    // PLO's own retry of the real result is still fine
    expect((await ingest(store, failing)).body).toMatchObject({ duplicate: true });
  });

  it("a smoke run that failed before checking anything is recorded and bound too — and can never be followed by a green one", async () => {
    const store = new FakeStore();
    const req = store.addRequest("smoke", { status: "claimed", claimedAt: NOW, params });
    const crashed = snapshot({ job: "smoke", runId: "crashed-run", components: undefined, requestId: req.id, ok: false, error: "smoke: inventory not readable" });
    expect((await ingest(store, crashed)).status).toBe(200);
    expect(req.runId).toBe("crashed-run");
    expect((await ingest(store, smoke(req.id, { runId: "green-after-all" }))).status).toBe(409);
    // a run that says ok without showing a single result is not a smoke result
    expect((await ingest(store, snapshot({ job: "smoke", runId: "empty-ok", components: undefined, requestId: req.id }))).status).toBe(400);
  });

  it("when the snapshot cannot be stored, the request is NOT left bound to a run that does not exist", async () => {
    const store = new FakeStore();
    const req = store.addRequest("smoke", { status: "claimed", claimedAt: NOW, params });
    store.failAuditOf = "lifecycle.ingest";
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await ingest(store, smoke(req.id))).status).toBe(500);
    expect(req.runId).toBeNull();
    expect(store.snapshots).toEqual([]);
    store.failAuditOf = null;
    expect((await ingest(store, smoke(req.id))).status).toBe(200);
    expect(req.runId).toBe("smoke-1");
  });

  it("complete keeps the run the request was answered with: another runId is refused", async () => {
    const store = new FakeStore();
    const req = store.addRequest("smoke", { status: "claimed", claimedAt: NOW, params });
    await ingest(store, smoke(req.id, { runId: "real-run" }));
    const other = await handleComplete(post(`/requests/${req.id}/complete`, { ok: true, runId: "another-run" }), req.id, deps(store));
    expect(other.status).toBe(409);
    expect(req).toMatchObject({ status: "claimed", runId: "real-run" });
    const same = await handleComplete(post(`/requests/${req.id}/complete`, { ok: true, runId: "real-run" }), req.id, deps(store));
    expect(same.status).toBe(200);
    expect(req).toMatchObject({ status: "done", runId: "real-run" });
    // completing without naming a run keeps the bound one too
    const req2 = store.addRequest("smoke", { status: "claimed", claimedAt: NOW, params: { scope: "stg", bundleKey: KEY, targets: [{ name: "twizz-sentinel", baseUrl: "https://sentinel-stg.prv.twizz.com" }] } });
    await ingest(store, smoke(req2.id, { runId: "run-2", smoke: { scope: "stg", bundleKey: KEY, results: [result()] } }));
    await handleComplete(post(`/requests/${req2.id}/complete`, { ok: true }), req2.id, deps(store));
    expect(req2).toMatchObject({ status: "done", runId: "run-2" });
  });
});

describe("the dispatcher's own credential (LIFECYCLE_DISPATCH_TOKEN)", () => {
  const DISPATCH = "d1spatch-".repeat(6); // 54 chars
  const params = { scope: "preview", bundleKey: KEY, targets: [{ name: "twizz-sentinel", baseUrl: "http://twizz-sentinel.env-plo-2611-twizz-sentinel.svc.cluster.local:8090" }] };
  const smokeBody = (requestId: string) => snapshot({ job: "smoke", runId: "smoke-1", components: undefined, requestId, smoke: { scope: "preview", bundleKey: KEY, results: [] } });
  const split = (store: FakeStore) => deps(store, { dispatchToken: DISPATCH });

  it("identifyIngestCaller: one shared token is both roles; two tokens are two separate credentials", () => {
    expect(identifyIngestCaller(`Bearer ${TOKEN}`, TOKEN, undefined)).toMatchObject({ ok: true, split: false, roles: new Set(["publisher", "dispatcher"]) });
    expect(identifyIngestCaller(`Bearer ${TOKEN}`, TOKEN, DISPATCH)).toMatchObject({ ok: true, split: true, roles: new Set(["publisher"]) });
    expect(identifyIngestCaller(`Bearer ${DISPATCH}`, TOKEN, DISPATCH)).toMatchObject({ ok: true, split: true, roles: new Set(["dispatcher"]) });
    expect(identifyIngestCaller(`Bearer ${DISPATCH}`, TOKEN, undefined)).toMatchObject({ ok: false, status: 401 });
    expect(identifyIngestCaller("Bearer nope-nope-nope-nope-nope-nope-nope", TOKEN, DISPATCH)).toMatchObject({ ok: false, status: 401 });
    // a misconfigured second token is a 503 for everyone, never a silent fall back to the shared one
    expect(identifyIngestCaller(`Bearer ${TOKEN}`, TOKEN, "short")).toMatchObject({ ok: false, status: 503 });
    expect(identifyIngestCaller(`Bearer ${TOKEN}`, TOKEN, TOKEN)).toMatchObject({ ok: false, status: 503 });
    expect(identifyIngestCaller(`Bearer ${DISPATCH}`, undefined, DISPATCH)).toMatchObject({ ok: false, status: 503 });
  });

  it("with it set, the publisher token cannot claim, complete or post a smoke result", async () => {
    const store = new FakeStore();
    const req = store.addRequest("smoke", { status: "claimed", claimedAt: NOW, params });
    store.addRequest("plan");
    expect((await handleClaim(post("/requests/claim", ""), split(store))).status).toBe(403);
    expect((await handleComplete(post(`/requests/${req.id}/complete`, { ok: true }), req.id, split(store))).status).toBe(403);
    const forged = await handleIngest(post("/ingest", smokeBody(req.id)), split(store));
    expect(forged.status).toBe(403);
    expect(store.snapshots).toEqual([]);
    expect(store.requests.map((r) => r.status)).toEqual(["claimed", "pending"]);
    expect(store.audits.at(-1)).toMatchObject({ action: "lifecycle.ingest", allowed: false, detail: { reason: "a smoke snapshot needs the dispatcher credential" } });
    // it still publishes what it is for
    expect((await handleIngest(post("/ingest", snapshot({ runId: "plan-1" })), split(store))).status).toBe(200);
  });

  it("with it set, the dispatcher token runs the queue and posts smoke results — and cannot publish a bundle", async () => {
    const store = new FakeStore();
    const req = store.addRequest("smoke", { params });
    const as = auth(DISPATCH);
    const claimed = await handleClaim(post("/requests/claim", "", as), split(store));
    expect(((await claimed.json()) as { request: { id: string } }).request.id).toBe(req.id);
    expect((await handleIngest(post("/ingest", smokeBody(req.id), as), split(store))).status).toBe(200);
    expect((await handleComplete(post(`/requests/${req.id}/complete`, { ok: true, runId: "smoke-1" }, as), req.id, split(store))).status).toBe(200);
    // on-demand plan/cve runs are the dispatcher's too
    expect((await handleIngest(post("/ingest", snapshot({ job: "cve", runId: "cve-1", components: undefined, advisories: [] }), as), split(store))).status).toBe(200);
    const bundles = [{ repo: "r", github: "twizz-app/twizz-sentinel", baseBranch: "main", branch: "plo/bundle/2026-11", headSha: "a".repeat(40), included: [], conflicts: [], environments: [] }];
    const src = await handleIngest(post("/ingest", snapshot({ job: "source", runId: "src-1", components: undefined, bundles, bundleKey: lifecycleBundleKey(bundles) }), as), split(store));
    expect(src.status).toBe(403);
  });

  it("is read from the environment by default", async () => {
    vi.stubEnv("LIFECYCLE_INGEST_TOKEN", TOKEN);
    vi.stubEnv("LIFECYCLE_DISPATCH_TOKEN", DISPATCH);
    const store = new FakeStore();
    store.addRequest("plan");
    expect((await handleClaim(post("/requests/claim", ""), { store })).status).toBe(403);
    expect((await handleClaim(post("/requests/claim", "", auth(DISPATCH)), { store })).status).toBe(200);
  });
});
