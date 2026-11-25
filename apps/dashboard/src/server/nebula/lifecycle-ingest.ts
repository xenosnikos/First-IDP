// Lifecycle ingest (docs/NEBULA.md §N9): the three machine endpoints the
// in-cluster PLO publisher / dispatcher call. They are NOT session routes (no
// cookie, not in the middleware matcher): the only credential is the bearer
// LIFECYCLE_INGEST_TOKEN, and every handler here checks it first.
//
//   POST /api/lifecycle/ingest                  store one validated snapshot
//   POST /api/lifecycle/requests/claim          take the oldest pending request
//   POST /api/lifecycle/requests/:id/complete   report a claimed request's result
//
// Fail closed: with the token unset or shorter than 32 chars every call is
// 503. The route files are thin wrappers; all logic is here behind a small
// store port so it is unit-tested without a database.
//
// WHAT THE TOKEN HOLDER IS TRUSTED FOR — treat it as possibly compromised:
//   · plan / cve snapshots: display only (tiers, advisories, schedule).
//   · source snapshots: WHICH bundle exists. `bundleKey` is recomputed here
//     from `bundles` (a mismatch is rejected), and every gated write re-reads
//     each bundle branch head from GitHub — so a snapshot can only ever point a
//     gate at commits that really are the heads of those branches.
//   · smoke snapshots: the smoke VERDICT. This is the one piece of gate
//     evidence that is the holder's own word; nothing here can verify that the
//     checks really ran. It is bound as tightly as a self-reported result can
//     be: accepted only as the answer to a request Nebula itself created (an
//     operator, through the gate), while that request is `claimed`, for the
//     same scope and bundle key, ONCE (the request's runId is bound to the
//     snapshot and can never be rebound), and never replaceable afterwards.
//   · a snapshot is immutable: the same runId again is accepted only when the
//     content is identical (an idempotent retry); anything else is a 409.
// With LIFECYCLE_DISPATCH_TOKEN set, smoke results and the request queue
// (claim / complete) need THAT token and the publisher token is refused for
// them — so the pods that run repository code or only publish plan/cve/source
// snapshots cannot answer a smoke request at all (docs/NEBULA.md §N9).
import { createHash, timingSafeEqual } from "node:crypto";
import { lifecycleBundleKey } from "@twizz-idp/actions";
import {
  LIFECYCLE_LIMITS,
  LifecycleCompleteBody,
  LifecycleSmokeParams,
  LifecycleSnapshotDoc,
  isLifecycleRequestKind,
  lifecycleIssuePaths,
  parseLifecycleRequestParams,
  type LifecycleRequestKind,
} from "@twizz-idp/shared";
import type { Prisma, PrismaClient } from "@twizz-idp/db";

/** the AuditLog actor for everything the publisher does */
export const LIFECYCLE_ACTOR = "plo";
export const MIN_TOKEN_CHARS = 32;
/** newest snapshots kept per job */
export const SNAPSHOT_RETENTION = 60;
/** a pending request nobody claimed is expired after this long */
export const PENDING_EXPIRY_MS = 24 * 3_600_000;
/** a claimed request nobody completed is failed after this long */
export const CLAIM_TIMEOUT_MS = 2 * 3_600_000;
/** `complete` carries three short fields */
export const COMPLETE_BODY_BYTES = 16 * 1024;
/** a snapshot may not claim to have finished further ahead of this server's clock */
export const CLOCK_SKEW_MS = 10 * 60_000;
const REQUEST_ID_RE = /^[a-z0-9]{8,40}$/;

/** the env var holding the dispatcher's own token (optional; see the header) */
export const DISPATCH_TOKEN_ENV = "LIFECYCLE_DISPATCH_TOKEN";

export const AUDIT = {
  ingest: "lifecycle.ingest",
  claim: "lifecycle.request.claim",
  complete: "lifecycle.request.complete",
  expire: "lifecycle.request.expire",
} as const;

// ── the store port ────────────────────────────────────────────────────────

export type SnapshotWrite = { job: string; runId: string; ok: boolean; startedAt: Date; finishedAt: Date; data: LifecycleSnapshotDoc };
export type StoredSnapshot = { id: string; job: string; data: unknown };
export type ClaimedRequest = { id: string; kind: string; params: unknown };
export type RequestRecord = { id: string; kind: string; params: unknown; status: string; runId: string | null };
export type AuditWrite = { action: string; resource?: string; allowed: boolean; detail?: Record<string, unknown> };

export interface LifecycleIngestStore {
  /** Run `fn` atomically: every write it makes through `tx` commits together or not at all
   * (a throw rolls all of them back). A state change and its audit row always go in ONE of these. */
  transaction<T>(fn: (tx: LifecycleIngestStore) => Promise<T>): Promise<T>;
  /** the snapshot stored under this runId, if any */
  findSnapshot(runId: string): Promise<StoredSnapshot | null>;
  /** Insert a NEW snapshot (received at `now`). Never replaces: a runId is written once. */
  insertSnapshot(row: SnapshotWrite, now: Date): Promise<{ id: string }>;
  /** Delete all but the newest `keep` snapshots of `job`; returns how many went. */
  pruneSnapshots(job: string, keep: number): Promise<number>;
  /** pending since before `pendingBefore` → expired; claimed since before `claimedBefore` → failed. */
  expireRequests(now: Date, pendingBefore: Date, claimedBefore: Date): Promise<{ expired: number; failed: number }>;
  /** ATOMICALLY move the oldest pending request to claimed and return it; null when none.
   * Two concurrent callers must never receive the same row. */
  claimOldestPending(now: Date): Promise<ClaimedRequest | null>;
  /** Move a request from `claimed` to done/failed; false when it was not `claimed`. */
  finishClaimed(id: string, patch: { status: "done" | "failed"; error: string | null; runId: string | null }, now: Date): Promise<boolean>;
  /** Bind a CLAIMED request that has no run yet to `runId`, in one conditional update;
   * false when it is not claimed or already has a run. A request is answered once. */
  bindRun(id: string, runId: string): Promise<boolean>;
  /** the request, or null when there is none */
  getRequest(id: string): Promise<RequestRecord | null>;
  audit(entry: AuditWrite): Promise<void>;
}

type Db = Pick<PrismaClient, "lifecycleSnapshot" | "lifecycleRequest" | "auditLog" | "$queryRaw">;

/** The Prisma-backed store.
 *
 * The claim is ONE statement:
 *
 *   UPDATE "LifecycleRequest" SET status='claimed', "claimedAt"=…
 *   WHERE id = (SELECT id … WHERE status='pending' ORDER BY "createdAt", id
 *               LIMIT 1 FOR UPDATE SKIP LOCKED)
 *     AND status='pending'
 *   RETURNING id, kind, params
 *
 * Why two dispatchers can never get the same request: the sub-select takes a
 * row lock on the request it picks, and `SKIP LOCKED` makes a concurrent
 * dispatcher pass over that locked row and pick the next one (or none) instead
 * of waiting for it. The lock is held until the surrounding transaction ends:
 * committed, the row is `claimed` and no longer matches `status='pending'`;
 * rolled back (the audit row could not be written), it is pending again and
 * the next claim gets it. The outer `AND status='pending'` re-checks the row
 * the UPDATE itself is about to write (READ COMMITTED re-evaluates it against
 * the latest committed version), so even a plan that evaluated the sub-select
 * before another commit cannot re-claim. No application-side read-then-write. */
export function prismaLifecycleStore(prisma: PrismaClient): LifecycleIngestStore {
  const make = (db: Db, inTransaction: boolean): LifecycleIngestStore => ({
    transaction(fn) {
      // already inside one: the caller's transaction is the unit
      if (inTransaction) return fn(make(db, true));
      return prisma.$transaction((tx) => fn(make(tx as unknown as Db, true)), { maxWait: 10_000, timeout: 30_000 });
    },
    async findSnapshot(runId) {
      return db.lifecycleSnapshot.findUnique({ where: { runId }, select: { id: true, job: true, data: true } });
    },
    async insertSnapshot(row, now) {
      // `runId` is unique: a concurrent insert of the same runId fails here instead of replacing
      const saved = await db.lifecycleSnapshot.create({
        data: { runId: row.runId, createdAt: now, job: row.job, ok: row.ok, startedAt: row.startedAt, finishedAt: row.finishedAt, data: row.data as unknown as Prisma.InputJsonValue },
        select: { id: true },
      });
      return { id: saved.id };
    },
    async pruneSnapshots(job, keep) {
      const old = await db.lifecycleSnapshot.findMany({ where: { job }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: keep, select: { id: true } });
      if (old.length === 0) return 0;
      const gone = await db.lifecycleSnapshot.deleteMany({ where: { id: { in: old.map((r) => r.id) } } });
      return gone.count;
    },
    async expireRequests(now, pendingBefore, claimedBefore) {
      const [expired, failed] = await Promise.all([
        db.lifecycleRequest.updateMany({ where: { status: "pending", createdAt: { lt: pendingBefore } }, data: { status: "expired", finishedAt: now, error: "not claimed within 24 h" } }),
        db.lifecycleRequest.updateMany({ where: { status: "claimed", claimedAt: { lt: claimedBefore } }, data: { status: "failed", finishedAt: now, error: "claimed but not completed within 2 h" } }),
      ]);
      return { expired: expired.count, failed: failed.count };
    },
    async claimOldestPending(now) {
      // the timestamp travels as text and is cast in SQL: `timestamp(3)` columns hold UTC wall-clock
      // time (Prisma's convention), so no session time zone may be applied to it
      const at = now.toISOString().replace("T", " ").replace("Z", "");
      const rows = await db.$queryRaw<ClaimedRequest[]>`
        UPDATE "LifecycleRequest"
           SET "status" = 'claimed', "claimedAt" = ${at}::timestamp
         WHERE "id" = (
                 SELECT "id" FROM "LifecycleRequest"
                  WHERE "status" = 'pending'
                  ORDER BY "createdAt" ASC, "id" ASC
                  LIMIT 1
                    FOR UPDATE SKIP LOCKED
               )
           AND "status" = 'pending'
        RETURNING "id", "kind", "params"`;
      return rows[0] ?? null;
    },
    async finishClaimed(id, patch, now) {
      const r = await db.lifecycleRequest.updateMany({ where: { id, status: "claimed" }, data: { status: patch.status, finishedAt: now, error: patch.error, runId: patch.runId } });
      return r.count === 1;
    },
    async bindRun(id, runId) {
      const r = await db.lifecycleRequest.updateMany({ where: { id, status: "claimed", runId: null }, data: { runId } });
      return r.count === 1;
    },
    async getRequest(id) {
      return db.lifecycleRequest.findUnique({ where: { id }, select: { id: true, kind: true, params: true, status: true, runId: true } });
    },
    async audit(entry) {
      await db.auditLog.create({
        data: { actor: LIFECYCLE_ACTOR, action: entry.action, resource: entry.resource, allowed: entry.allowed, detail: (entry.detail ?? undefined) as Prisma.InputJsonValue | undefined },
      });
    },
  });
  return make(prisma, false);
}

// ── auth ──────────────────────────────────────────────────────────────────

export type IngestAuth = { ok: true } | { ok: false; status: 401 | 503; message: string };

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** `Authorization: Bearer <LIFECYCLE_INGEST_TOKEN>`. Both sides are hashed
 * first, so the comparison is constant-time and length-independent. An unset
 * or short token is a server misconfiguration: 503 for everyone, never open. */
export function checkIngestAuth(authorization: string | null | undefined, token: string | undefined = process.env.LIFECYCLE_INGEST_TOKEN): IngestAuth {
  if (!token || token.length < MIN_TOKEN_CHARS) return { ok: false, status: 503, message: "lifecycle ingest is not configured on this Nebula" };
  const m = /^Bearer ([^\s]+)$/.exec(authorization ?? "");
  // hash something either way, so a missing header costs the same as a wrong token
  const presented = sha256(m ? m[1] : "");
  const same = timingSafeEqual(presented, sha256(token));
  if (!m || !same) return { ok: false, status: 401, message: "invalid or missing bearer token" };
  return { ok: true };
}

/** What a caller may do. The publisher's token (LIFECYCLE_INGEST_TOKEN) and the
 * dispatcher's (LIFECYCLE_DISPATCH_TOKEN) are two separate credentials and
 * neither works for the other's job. There is no shared-token mode: without
 * the dispatcher's token NOBODY holds the dispatcher role. */
export type IngestRole = "publisher" | "dispatcher";
export type IngestWho = { ok: true; roles: ReadonlySet<IngestRole>; split: boolean } | Extract<IngestAuth, { ok: false }>;

/** Who is calling. `dispatchToken` unset/empty → FAIL CLOSED for the dispatcher
 * role: the publisher token still publishes plan/cve/source snapshots, but it
 * can not claim or complete a request, and no smoke result is accepted from
 * anyone (a dashboard that started before Secret `plo-dispatch-env` synced
 * must not hand every PLO pod the power to answer a smoke request). `split`
 * says whether the dispatcher's credential is configured. Set → it must itself
 * be a real secret (≥ 32 chars, different from the publisher's); a
 * misconfigured one is a 503 for everyone. */
export function identifyIngestCaller(authorization: string | null | undefined, token: string | undefined, dispatchToken: string | undefined): IngestWho {
  const publisher = checkIngestAuth(authorization, token);
  if (!publisher.ok && publisher.status === 503) return publisher;
  if (!dispatchToken) return publisher.ok ? { ok: true, roles: new Set<IngestRole>(["publisher"]), split: false } : publisher;
  // (digests compared in constant time, like every other token comparison here)
  if (dispatchToken.length < MIN_TOKEN_CHARS || timingSafeEqual(sha256(dispatchToken), sha256(token ?? ""))) return { ok: false, status: 503, message: "lifecycle ingest is not configured on this Nebula" };
  if (publisher.ok) return { ok: true, roles: new Set<IngestRole>(["publisher"]), split: true };
  const dispatcher = checkIngestAuth(authorization, dispatchToken);
  if (dispatcher.ok) return { ok: true, roles: new Set<IngestRole>(["dispatcher"]), split: true };
  return publisher;
}

/** Is the dispatcher's own credential configured (smoke evidence not answerable with the publisher token)? */
export function dispatchTokenConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const d = env[DISPATCH_TOKEN_ENV];
  return !!d && d.length >= MIN_TOKEN_CHARS && !timingSafeEqual(sha256(d), sha256(env.LIFECYCLE_INGEST_TOKEN ?? ""));
}

// ── body ──────────────────────────────────────────────────────────────────

export type BodyRead = { ok: true; text: string; bytes: number } | { ok: false; status: 400 | 413; message: string };

/** Read at most `maxBytes` of the body. A declared Content-Length over the cap
 * is refused without reading anything; a chunked or lying body is cut off the
 * moment it crosses the cap. Nothing is parsed here. */
export async function readCappedBody(req: Request, maxBytes: number): Promise<BodyRead> {
  const tooLarge: BodyRead = { ok: false, status: 413, message: `body exceeds ${maxBytes} bytes` };
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d{1,15}$/.test(declared.trim())) return { ok: false, status: 400, message: "invalid content-length" };
    if (Number(declared) > maxBytes) return tooLarge;
  }
  if (!req.body) return { ok: true, text: "", bytes: 0 };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return tooLarge;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(bytes);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(all), bytes };
  } catch {
    return { ok: false, status: 400, message: "body is not valid UTF-8" };
  }
}

// ── handlers ──────────────────────────────────────────────────────────────

export type IngestDeps = {
  store: LifecycleIngestStore;
  /** defaults to process.env.LIFECYCLE_INGEST_TOKEN, read per call */
  token?: string;
  /** defaults to process.env.LIFECYCLE_DISPATCH_TOKEN, read per call */
  dispatchToken?: string;
  now?: () => Date;
};

const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });

function denied(auth: Extract<IngestAuth, { ok: false }>): Response {
  return json(auth.status, { error: auth.message }, auth.status === 401 ? { "www-authenticate": 'Bearer realm="nebula-lifecycle"' } : { "retry-after": "60" });
}

const tokenOf = (deps: IngestDeps) => ("token" in deps ? deps.token : process.env.LIFECYCLE_INGEST_TOKEN);
const dispatchTokenOf = (deps: IngestDeps) => ("dispatchToken" in deps ? deps.dispatchToken : process.env[DISPATCH_TOKEN_ENV]) || undefined;
const callerOf = (req: Request, deps: IngestDeps) => identifyIngestCaller(req.headers.get("authorization"), tokenOf(deps), dispatchTokenOf(deps));
const wrongCredential = (what: string) => json(403, { error: `this credential may not ${what}` });

/** for the server log only: short, and with any `scheme://user:password@` credentials removed */
const errText = (e: unknown) =>
  String((e as Error)?.message ?? e)
    .replace(/\/\/[^/\s:@]+:[^@\s]+@/g, "//***@")
    .slice(0, 300);

/** An audit row for something we REFUSED is best effort; it must not turn a 4xx into a 5xx. */
async function auditQuietly(store: LifecycleIngestStore, entry: AuditWrite): Promise<void> {
  await store.audit(entry).catch((e) => console.error(`[lifecycle] audit ${entry.action} failed:`, errText(e)));
}

/** A snapshot Nebula will not store, decided inside the transaction: thrown so
 * that everything the transaction did is rolled back, then answered as 409. */
class IngestConflict extends Error {}

/** JSON equality that ignores key order (Postgres `jsonb` does not keep it)
 * and treats an `undefined` property as absent. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameJson(x, b[i]));
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = (o: Record<string, unknown>) => Object.keys(o).filter((k) => o[k] !== undefined).sort();
  const ak = keys(ao);
  const bk = keys(bo);
  return ak.length === bk.length && ak.every((k, i) => k === bk[i] && sameJson(ao[k], bo[k]));
}

/** What must hold between a snapshot's fields beyond their shape. Paths and
 * codes only, like every other ingest refusal. */
function consistencyIssues(snap: LifecycleSnapshotDoc): Array<{ path: string; code: string }> {
  const issues: Array<{ path: string; code: string }> = [];
  if (snap.job === "source") {
    // the key is DERIVED from the bundles; a snapshot does not get to choose it
    const computed = lifecycleBundleKey(snap.bundles ?? []);
    if ((snap.bundleKey ?? null) !== computed) issues.push({ path: "bundleKey", code: "not_the_hash_of_bundles" });
  } else {
    if (snap.bundles !== undefined) issues.push({ path: "bundles", code: "only_in_a_source_snapshot" });
    if (snap.bundleKey !== undefined) issues.push({ path: "bundleKey", code: "only_in_a_source_snapshot" });
  }
  if (snap.job === "smoke") {
    // a run that failed before it checked anything has no results to send (ok=false); a run that
    // claims success must show them
    if (!snap.smoke && snap.ok) issues.push({ path: "smoke", code: "required_in_a_smoke_snapshot" });
    if (!snap.requestId) issues.push({ path: "requestId", code: "required_in_a_smoke_snapshot" });
  } else if (snap.smoke !== undefined) issues.push({ path: "smoke", code: "only_in_a_smoke_snapshot" });
  return issues;
}

/** POST /api/lifecycle/ingest — body = Snapshot → 200 `{id}`.
 * Order: token → size cap → JSON.parse → Zod → consistency (bundle key, job
 * fields) → [one transaction: runId unused or identical → smoke bound to its
 * request → insert → retention → AuditLog].
 * Only the PARSED snapshot is stored (unknown keys are stripped by the schema).
 * A snapshot is written ONCE: the same runId with the same content is an
 * idempotent retry (200, nothing changes); with different content it is a 409. */
export async function handleIngest(req: Request, deps: IngestDeps): Promise<Response> {
  const who = callerOf(req, deps);
  if (!who.ok) return denied(who);
  const { store } = deps;
  const now = (deps.now ?? (() => new Date()))();

  const body = await readCappedBody(req, LIFECYCLE_LIMITS.bodyBytes);
  if (!body.ok) {
    await auditQuietly(store, { action: AUDIT.ingest, allowed: false, detail: { reason: body.message } });
    return json(body.status, { error: body.message });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(body.text);
  } catch {
    await auditQuietly(store, { action: AUDIT.ingest, allowed: false, detail: { reason: "body is not JSON", bytes: body.bytes } });
    return json(400, { error: "body is not JSON" });
  }
  const parsed = LifecycleSnapshotDoc.safeParse(raw);
  if (!parsed.success) {
    // paths and codes only: the offending values are never echoed or stored
    const issues = lifecycleIssuePaths(parsed.error);
    await auditQuietly(store, { action: AUDIT.ingest, allowed: false, detail: { reason: "invalid snapshot", issues: issues.slice(0, 20), bytes: body.bytes } });
    return json(400, { error: "invalid snapshot", issues });
  }
  const snap = parsed.data;
  const startedAt = new Date(snap.startedAt);
  const finishedAt = new Date(snap.finishedAt);
  const timeIssue =
    finishedAt.getTime() < startedAt.getTime()
      ? { path: "finishedAt", code: "before_startedAt" }
      : finishedAt.getTime() > now.getTime() + CLOCK_SKEW_MS
        ? { path: "finishedAt", code: "in_the_future" }
        : null;
  const issues = timeIssue ? [timeIssue] : consistencyIssues(snap);
  if (issues.length) {
    await auditQuietly(store, { action: AUDIT.ingest, resource: snap.runId, allowed: false, detail: { reason: "invalid snapshot", issues, bytes: body.bytes } });
    return json(400, { error: "invalid snapshot", issues });
  }

  // which credential may publish what (only when the dispatcher has its own)
  const needs: IngestRole | null = snap.job === "smoke" ? "dispatcher" : snap.job === "source" ? "publisher" : null;
  if (needs && !who.roles.has(needs)) {
    await auditQuietly(store, { action: AUDIT.ingest, resource: snap.runId, allowed: false, detail: { reason: `a ${snap.job} snapshot needs the ${needs} credential`, job: snap.job } });
    return wrongCredential(`publish a ${snap.job} snapshot`);
  }

  try {
    const out = await store.transaction(async (tx) => {
      const existing = await tx.findSnapshot(snap.runId);
      if (existing) {
        // written once. The same bytes again are a retry; anything else would rewrite history.
        if (existing.job !== snap.job || !sameJson(existing.data, snap)) throw new IngestConflict(`runId ${snap.runId} is already stored with different content — a snapshot is never replaced; publish a new run under a new runId`);
        await tx.audit({ action: AUDIT.ingest, resource: snap.runId, allowed: true, detail: { id: existing.id, job: snap.job, duplicate: true, bytes: body.bytes } });
        return { id: existing.id, duplicate: true };
      }
      if (snap.job === "smoke") {
        // a smoke result counts for a gate, so it must be the answer to a question Nebula asked
        const request = await tx.getRequest(snap.requestId!);
        if (!request || request.kind !== "smoke") throw new IngestConflict("a smoke snapshot must answer a smoke request Nebula created; there is none with this requestId");
        if (request.status !== "claimed") throw new IngestConflict(`the smoke request is ${request.status}, not claimed — a result is accepted only while its request is being run`);
        const params = LifecycleSmokeParams.safeParse(request.params);
        if (!params.success || (snap.smoke && (params.data.scope !== snap.smoke.scope || params.data.bundleKey !== snap.smoke.bundleKey))) throw new IngestConflict("the smoke snapshot is for a different scope or bundle than the request it names");
        if (!(await tx.bindRun(request.id, snap.runId))) throw new IngestConflict("the smoke request already has a result — a request is answered once");
      }
      const saved = await tx.insertSnapshot({ job: snap.job, runId: snap.runId, ok: snap.ok, startedAt, finishedAt, data: snap }, now);
      const pruned = await tx.pruneSnapshots(snap.job, SNAPSHOT_RETENTION);
      // an accepted ingest without its audit row is not accepted: a failure here rolls the snapshot back, is a 500, and PLO retries (idempotent)
      await tx.audit({
        action: AUDIT.ingest,
        resource: snap.runId,
        allowed: true,
        detail: {
          id: saved.id,
          job: snap.job,
          ok: snap.ok,
          requestId: snap.requestId ?? null,
          bytes: body.bytes,
          components: snap.components?.length ?? 0,
          advisories: snap.advisories?.length ?? 0,
          bundles: snap.bundles?.length ?? 0,
          bundleKey: snap.job === "source" ? (snap.bundleKey ?? null) : null,
          pruned,
        },
      });
      return { id: saved.id, duplicate: false };
    });
    return json(200, out.duplicate ? { id: out.id, duplicate: true } : { id: out.id });
  } catch (e) {
    if (e instanceof IngestConflict) {
      await auditQuietly(store, { action: AUDIT.ingest, resource: snap.runId, allowed: false, detail: { reason: e.message, job: snap.job, requestId: snap.requestId ?? null } });
      return json(409, { error: e.message });
    }
    console.error("[lifecycle] ingest failed:", errText(e));
    return json(500, { error: "could not store the snapshot" });
  }
}

/** how many unusable rows one claim call will skip over before giving up */
const MAX_BAD_ROWS = 5;

/** POST /api/lifecycle/requests/claim → 200 `{request: {id, kind, params} | null}`.
 * Stale rows are expired/failed first, then the oldest pending request is
 * claimed atomically (see `prismaLifecycleStore`). A row whose kind or params
 * no longer validate is failed and skipped, never handed to PLO.
 *
 * The claim and its audit row are ONE transaction: if the audit row cannot be
 * written the claim is rolled back, the request is `pending` again, the call
 * is a 500 and the next claim gets it — a request is never left `claimed`
 * with nobody running it because of a failure here. */
export async function handleClaim(req: Request, deps: IngestDeps): Promise<Response> {
  const who = callerOf(req, deps);
  if (!who.ok) return denied(who);
  if (!who.roles.has("dispatcher")) return wrongCredential("claim requests");
  const { store } = deps;
  const now = (deps.now ?? (() => new Date()))();
  try {
    await store.transaction(async (tx) => {
      const swept = await tx.expireRequests(now, new Date(now.getTime() - PENDING_EXPIRY_MS), new Date(now.getTime() - CLAIM_TIMEOUT_MS));
      if (swept.expired || swept.failed) await tx.audit({ action: AUDIT.expire, allowed: true, detail: swept });
    });
    for (let i = 0; i < MAX_BAD_ROWS; i++) {
      const out = await store.transaction(async (tx): Promise<{ done: true; request: { id: string; kind: LifecycleRequestKind; params: unknown } | null } | { done: false }> => {
        const claimed = await tx.claimOldestPending(now);
        if (!claimed) return { done: true, request: null };
        let kind: LifecycleRequestKind | null = null;
        let params: unknown = null;
        let problem: string | null = null;
        if (!isLifecycleRequestKind(claimed.kind)) problem = `unknown request kind "${String(claimed.kind).slice(0, 40)}"`;
        else {
          kind = claimed.kind;
          try {
            params = parseLifecycleRequestParams(kind, claimed.params);
          } catch {
            problem = "request params are not valid for its kind";
          }
        }
        if (problem || !kind) {
          await tx.finishClaimed(claimed.id, { status: "failed", error: problem, runId: null }, now);
          await tx.audit({ action: AUDIT.claim, resource: claimed.id, allowed: false, detail: { reason: problem } });
          return { done: false };
        }
        await tx.audit({ action: AUDIT.claim, resource: claimed.id, allowed: true, detail: { kind } });
        return { done: true, request: { id: claimed.id, kind, params } };
      });
      if (out.done) return json(200, { request: out.request });
    }
    return json(200, { request: null });
  } catch (e) {
    console.error("[lifecycle] claim failed:", errText(e));
    return json(500, { error: "could not claim a request" });
  }
}

/** POST /api/lifecycle/requests/:id/complete — body `{ok, error?, runId?}` → 200.
 * Only a `claimed` request can be completed. Repeating the call for a request
 * that is already done/failed is a 200 (PLO retries on network errors); a
 * pending or expired request is a 409.
 *
 * The transition and its audit row are ONE transaction: if the audit row
 * cannot be written the request stays `claimed`, the call is a 500, and PLO's
 * retry completes it properly — "done" never exists without its audit row.
 * A request that was answered with a snapshot keeps THAT run: a `runId` here
 * that names another run is refused (409). */
export async function handleComplete(req: Request, id: string, deps: IngestDeps): Promise<Response> {
  const who = callerOf(req, deps);
  if (!who.ok) return denied(who);
  if (!who.roles.has("dispatcher")) return wrongCredential("complete requests");
  const { store } = deps;
  const now = (deps.now ?? (() => new Date()))();
  if (!REQUEST_ID_RE.test(id)) return json(404, { error: "no such request" });

  const body = await readCappedBody(req, COMPLETE_BODY_BYTES);
  if (!body.ok) return json(body.status, { error: body.message });
  let raw: unknown;
  try {
    raw = JSON.parse(body.text);
  } catch {
    return json(400, { error: "body is not JSON" });
  }
  const parsed = LifecycleCompleteBody.safeParse(raw);
  if (!parsed.success) return json(400, { error: "invalid body", issues: lifecycleIssuePaths(parsed.error) });
  const { ok, error, runId } = parsed.data;
  const status = ok ? ("done" as const) : ("failed" as const);
  try {
    const out = await store.transaction(async (tx): Promise<{ code: 200; body: unknown } | { code: 404 | 409; body: { error: string }; audit?: string }> => {
      const current = await tx.getRequest(id);
      if (!current) return { code: 404, body: { error: "no such request" } };
      if (current.status === "done" || current.status === "failed") return { code: 200, body: { ok: true, status: current.status, already: true } };
      if (current.status !== "claimed") return { code: 409, body: { error: `request is ${current.status}, not claimed` }, audit: `request is ${current.status}, not claimed` };
      if (current.runId && runId && runId !== current.runId) return { code: 409, body: { error: "runId does not name the result this request was answered with" }, audit: "runId does not name the result this request was answered with" };
      const moved = await tx.finishClaimed(id, { status, error: ok ? null : (error ?? "the run failed"), runId: current.runId ?? runId ?? null }, now);
      // lost a race with another completion: let the caller ask again and see the final state
      if (!moved) throw new Error("the request changed while it was being completed");
      await tx.audit({ action: AUDIT.complete, resource: id, allowed: true, detail: { ok, runId: current.runId ?? runId ?? null, error: ok ? null : (error ?? null) } });
      return { code: 200, body: { ok: true, status } };
    });
    if (out.code !== 200 && "audit" in out && out.audit) await auditQuietly(store, { action: AUDIT.complete, resource: id, allowed: false, detail: { reason: out.audit } });
    return json(out.code, out.body);
  } catch (e) {
    console.error("[lifecycle] complete failed:", errText(e));
    return json(500, { error: "could not complete the request" });
  }
}
