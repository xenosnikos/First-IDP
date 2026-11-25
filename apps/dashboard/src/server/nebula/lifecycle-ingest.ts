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
import { createHash, timingSafeEqual } from "node:crypto";
import {
  LIFECYCLE_LIMITS,
  LifecycleCompleteBody,
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

export const AUDIT = {
  ingest: "lifecycle.ingest",
  claim: "lifecycle.request.claim",
  complete: "lifecycle.request.complete",
  expire: "lifecycle.request.expire",
} as const;

// ── the store port ────────────────────────────────────────────────────────

export type SnapshotWrite = { job: string; runId: string; ok: boolean; startedAt: Date; finishedAt: Date; data: LifecycleSnapshotDoc };
export type ClaimedRequest = { id: string; kind: string; params: unknown };
export type AuditWrite = { action: string; resource?: string; allowed: boolean; detail?: Record<string, unknown> };

export interface LifecycleIngestStore {
  /** Insert, or replace the row with the same runId (and reset its createdAt to `now`). */
  upsertSnapshot(row: SnapshotWrite, now: Date): Promise<{ id: string; replaced: boolean }>;
  /** Delete all but the newest `keep` snapshots of `job`; returns how many went. */
  pruneSnapshots(job: string, keep: number): Promise<number>;
  /** pending since before `pendingBefore` → expired; claimed since before `claimedBefore` → failed. */
  expireRequests(now: Date, pendingBefore: Date, claimedBefore: Date): Promise<{ expired: number; failed: number }>;
  /** ATOMICALLY move the oldest pending request to claimed and return it; null when none.
   * Two concurrent callers must never receive the same row. */
  claimOldestPending(now: Date): Promise<ClaimedRequest | null>;
  /** Move a request from `claimed` to done/failed; false when it was not `claimed`. */
  finishClaimed(id: string, patch: { status: "done" | "failed"; error: string | null; runId: string | null }, now: Date): Promise<boolean>;
  /** current status, or null when there is no such request */
  requestStatus(id: string): Promise<string | null>;
  audit(entry: AuditWrite): Promise<void>;
}

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
 * of waiting for it. The lock is held until the UPDATE commits, at which point
 * the row is `claimed` and no longer matches `status='pending'`. The outer
 * `AND status='pending'` re-checks the row the UPDATE itself is about to write
 * (READ COMMITTED re-evaluates it against the latest committed version), so
 * even a plan that evaluated the sub-select before another commit cannot
 * re-claim. No transaction and no application-side read-then-write. */
export function prismaLifecycleStore(prisma: PrismaClient): LifecycleIngestStore {
  return {
    async upsertSnapshot(row, now) {
      const existing = await prisma.lifecycleSnapshot.findUnique({ where: { runId: row.runId }, select: { id: true } });
      const data = row.data as unknown as Prisma.InputJsonValue;
      const fields = { job: row.job, ok: row.ok, startedAt: row.startedAt, finishedAt: row.finishedAt, data };
      const saved = await prisma.lifecycleSnapshot.upsert({
        where: { runId: row.runId },
        create: { runId: row.runId, createdAt: now, ...fields },
        update: { createdAt: now, ...fields },
        select: { id: true },
      });
      return { id: saved.id, replaced: !!existing };
    },
    async pruneSnapshots(job, keep) {
      const old = await prisma.lifecycleSnapshot.findMany({ where: { job }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: keep, select: { id: true } });
      if (old.length === 0) return 0;
      const gone = await prisma.lifecycleSnapshot.deleteMany({ where: { id: { in: old.map((r) => r.id) } } });
      return gone.count;
    },
    async expireRequests(now, pendingBefore, claimedBefore) {
      const [expired, failed] = await Promise.all([
        prisma.lifecycleRequest.updateMany({ where: { status: "pending", createdAt: { lt: pendingBefore } }, data: { status: "expired", finishedAt: now, error: "not claimed within 24 h" } }),
        prisma.lifecycleRequest.updateMany({ where: { status: "claimed", claimedAt: { lt: claimedBefore } }, data: { status: "failed", finishedAt: now, error: "claimed but not completed within 2 h" } }),
      ]);
      return { expired: expired.count, failed: failed.count };
    },
    async claimOldestPending(now) {
      // the timestamp travels as text and is cast in SQL: `timestamp(3)` columns hold UTC wall-clock
      // time (Prisma's convention), so no session time zone may be applied to it
      const at = now.toISOString().replace("T", " ").replace("Z", "");
      const rows = await prisma.$queryRaw<ClaimedRequest[]>`
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
      const r = await prisma.lifecycleRequest.updateMany({ where: { id, status: "claimed" }, data: { status: patch.status, finishedAt: now, error: patch.error, runId: patch.runId } });
      return r.count === 1;
    },
    async requestStatus(id) {
      const r = await prisma.lifecycleRequest.findUnique({ where: { id }, select: { status: true } });
      return r?.status ?? null;
    },
    async audit(entry) {
      await prisma.auditLog.create({
        data: { actor: LIFECYCLE_ACTOR, action: entry.action, resource: entry.resource, allowed: entry.allowed, detail: (entry.detail ?? undefined) as Prisma.InputJsonValue | undefined },
      });
    },
  };
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
  now?: () => Date;
};

const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });

function denied(auth: Extract<IngestAuth, { ok: false }>): Response {
  return json(auth.status, { error: auth.message }, auth.status === 401 ? { "www-authenticate": 'Bearer realm="nebula-lifecycle"' } : { "retry-after": "60" });
}

const tokenOf = (deps: IngestDeps) => ("token" in deps ? deps.token : process.env.LIFECYCLE_INGEST_TOKEN);
/** for the server log only: short, and with any `scheme://user:password@` credentials removed */
const errText = (e: unknown) =>
  String((e as Error)?.message ?? e)
    .replace(/\/\/[^/\s:@]+:[^@\s]+@/g, "//***@")
    .slice(0, 300);

/** An audit row for something we REFUSED is best effort; it must not turn a 4xx into a 5xx. */
async function auditQuietly(store: LifecycleIngestStore, entry: AuditWrite): Promise<void> {
  await store.audit(entry).catch((e) => console.error(`[lifecycle] audit ${entry.action} failed:`, errText(e)));
}

/** POST /api/lifecycle/ingest — body = Snapshot → 200 `{id}`.
 * Order: token → size cap → JSON.parse → Zod → store → retention → AuditLog.
 * Only the PARSED snapshot is stored (unknown keys are stripped by the schema).
 * Idempotent on `runId`: the same runId replaces its row. */
export async function handleIngest(req: Request, deps: IngestDeps): Promise<Response> {
  const auth = checkIngestAuth(req.headers.get("authorization"), tokenOf(deps));
  if (!auth.ok) return denied(auth);
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
  if (timeIssue) {
    await auditQuietly(store, { action: AUDIT.ingest, resource: snap.runId, allowed: false, detail: { reason: "invalid snapshot", issues: [timeIssue], bytes: body.bytes } });
    return json(400, { error: "invalid snapshot", issues: [timeIssue] });
  }

  try {
    const saved = await store.upsertSnapshot({ job: snap.job, runId: snap.runId, ok: snap.ok, startedAt, finishedAt, data: snap }, now);
    const pruned = await store.pruneSnapshots(snap.job, SNAPSHOT_RETENTION);
    // an accepted ingest without its audit row is not accepted: a failure here is a 500 and PLO retries (idempotent)
    await store.audit({
      action: AUDIT.ingest,
      resource: snap.runId,
      allowed: true,
      detail: {
        id: saved.id,
        job: snap.job,
        ok: snap.ok,
        replaced: saved.replaced,
        requestId: snap.requestId ?? null,
        bytes: body.bytes,
        components: snap.components?.length ?? 0,
        advisories: snap.advisories?.length ?? 0,
        bundles: snap.bundles?.length ?? 0,
        pruned,
      },
    });
    return json(200, { id: saved.id });
  } catch (e) {
    console.error("[lifecycle] ingest failed:", errText(e));
    return json(500, { error: "could not store the snapshot" });
  }
}

/** how many unusable rows one claim call will skip over before giving up */
const MAX_BAD_ROWS = 5;

/** POST /api/lifecycle/requests/claim → 200 `{request: {id, kind, params} | null}`.
 * Stale rows are expired/failed first, then the oldest pending request is
 * claimed atomically (see `prismaLifecycleStore`). A row whose kind or params
 * no longer validate is failed and skipped, never handed to PLO. */
export async function handleClaim(req: Request, deps: IngestDeps): Promise<Response> {
  const auth = checkIngestAuth(req.headers.get("authorization"), tokenOf(deps));
  if (!auth.ok) return denied(auth);
  const { store } = deps;
  const now = (deps.now ?? (() => new Date()))();
  try {
    const swept = await store.expireRequests(now, new Date(now.getTime() - PENDING_EXPIRY_MS), new Date(now.getTime() - CLAIM_TIMEOUT_MS));
    if (swept.expired || swept.failed) await store.audit({ action: AUDIT.expire, allowed: true, detail: swept });
    for (let i = 0; i < MAX_BAD_ROWS; i++) {
      const claimed = await store.claimOldestPending(now);
      if (!claimed) return json(200, { request: null });
      let kind: LifecycleRequestKind | null = null;
      let params: unknown = null;
      let problem: string | null = null;
      if (!isLifecycleRequestKind(claimed.kind)) problem = `unknown request kind "${claimed.kind.slice(0, 40)}"`;
      else {
        kind = claimed.kind;
        try {
          params = parseLifecycleRequestParams(kind, claimed.params);
        } catch {
          problem = "request params are not valid for its kind";
        }
      }
      if (problem || !kind) {
        await store.finishClaimed(claimed.id, { status: "failed", error: problem, runId: null }, now);
        await store.audit({ action: AUDIT.claim, resource: claimed.id, allowed: false, detail: { reason: problem } });
        continue;
      }
      await store.audit({ action: AUDIT.claim, resource: claimed.id, allowed: true, detail: { kind } });
      return json(200, { request: { id: claimed.id, kind, params } });
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
 * pending or expired request is a 409. */
export async function handleComplete(req: Request, id: string, deps: IngestDeps): Promise<Response> {
  const auth = checkIngestAuth(req.headers.get("authorization"), tokenOf(deps));
  if (!auth.ok) return denied(auth);
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
    const moved = await store.finishClaimed(id, { status, error: ok ? null : (error ?? "the run failed"), runId: runId ?? null }, now);
    if (moved) {
      await store.audit({ action: AUDIT.complete, resource: id, allowed: true, detail: { ok, runId: runId ?? null, error: ok ? null : (error ?? null) } });
      return json(200, { ok: true, status });
    }
    const current = await store.requestStatus(id);
    if (current === null) return json(404, { error: "no such request" });
    if (current === "done" || current === "failed") return json(200, { ok: true, status: current, already: true });
    await auditQuietly(store, { action: AUDIT.complete, resource: id, allowed: false, detail: { reason: `request is ${current}, not claimed` } });
    return json(409, { error: `request is ${current}, not claimed` });
  } catch (e) {
    console.error("[lifecycle] complete failed:", errText(e));
    return json(500, { error: "could not complete the request" });
  }
}
