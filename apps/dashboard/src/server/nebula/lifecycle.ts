// Lifecycle (docs/NEBULA.md §N9): the reader. Loads what the pure model
// (lifecycle-model.ts) needs — PLO snapshots and requests from Postgres,
// sign-offs from AuditLog, and for the preview state machine the named-env
// manifests, Argo health, open promotion PRs and staging's image tags — then
// hands it over. Every sub-source failure comes back AS DATA (never a thrown
// page): the state machine treats what it could not read as "not there".
//
// READ ONLY, with one exception at the bottom: `enqueueLifecycleRequest`, the
// single insert the gated operator writes (routers/actions.ts) use to queue an
// on-demand run. Nothing here touches a kube API or GitHub with a write.
import { createHash } from "node:crypto";
import { PROMOTABLE, REGISTRY, envEcrRepo, lifecycleBundleKey, listNamedEnvs, listPromotions, readTargetState, releaseTarget, type NamedEnvManifest } from "@twizz-idp/actions";
import type { Prisma, PrismaClient } from "@twizz-idp/db";
import { z } from "zod";
import { LifecycleEnvironmentCoverage, LifecycleSmokeParams, LifecycleSnapshotDoc, parseLifecycleRequestParams, type LifecycleBundle, type LifecycleRequestKind, type LifecycleRequestParams } from "@twizz-idp/shared";
import { isOperator } from "@/lib/nebula/operators";
import { argoWord, type ArgoStatus } from "@/lib/nebula/status";
import { STAGING_LABEL, argoStatusFor, readArgoApplications } from "./argo";
import { namedEnvDeps } from "./deps";
import { dispatchTokenConfigured } from "./lifecycle-ingest";
import { buildEnvironments, type CoverageHistoryRow, type EnvironmentsView } from "./lifecycle-environments";
import {
  ENV_CHANGE_AUDIT_ACTIONS,
  PLO_ENV_PREFIX,
  SIGNOFF_AUDIT_ACTION,
  argoRunsImage,
  boundSmokeRunIds,
  buildAdvisories,
  buildOverview,
  buildPreview,
  bundleTargets,
  isActiveRequest,
  neededSnapshotIds,
  parseEnvChangeAudit,
  parseSignoffAudit,
  requestView,
  selectSnapshots,
  type AdvisoriesView,
  type EnvChangeInput,
  type HistoryRow,
  type LifecycleServiceInput,
  type OverviewView,
  type PreviewEnvInput,
  type PreviewInput,
  type PreviewState,
  type PreviewView,
  type PromotionInput,
  type RequestRow,
  type RequestView,
  type SignoffInput,
  type SnapshotMeta,
  type SnapshotRow,
  type StagingTargetInput,
} from "./lifecycle-model";

const errMsg = (e: unknown) => String((e as Error)?.message ?? e);

export type Part<T> = { ok: T } | { error: string };
const part = <T,>(p: Promise<T>): Promise<Part<T>> => p.then((ok) => ({ ok }), (e) => ({ error: errMsg(e) }));

// ── the registry, as the model wants it ───────────────────────────────────

/** Every Nebula registry service a bundled repository may map to. */
export function lifecycleServices(): LifecycleServiceInput[] {
  return REGISTRY.map((s) => {
    const staging = releaseTarget(s.name, "staging");
    return { service: s.name, repo: s.repo, promotable: !!staging, stagingHost: staging?.host ?? null };
  });
}

/** A named-env manifest → what the state machine reads. `argo` is the verdict
 * word of Application `env-<name>` (null for an env that is not deployable
 * yet); `app` is that Application as Argo reported it — what it RUNS and when
 * it last finished syncing (absent: not read, so the env is not "up"). */
export function toPreviewEnv(m: NamedEnvManifest, pending: boolean, argo: PreviewEnvInput["argo"], app?: ArgoStatus | null): PreviewEnvInput {
  return {
    // a deployable env's Application was asked for; not handed over, or Argo unreachable = not read
    argoUnread: !pending && (!app || app.unreachable === true),
    runsImage: !pending && !!app && argoRunsImage(app.images, envEcrRepo(m), m.imageTag ?? null),
    rolledOutAt: !pending && app ? (app.operationFinishedAt ?? null) : null,
    port: typeof m.config?.port === "number" ? m.config.port : null,
    // the owner is written by Nebula into gitops from the signed-in login; only an operator can run lifecycle_create_preview
    trusted: isOperator(m.owner),
    name: m.name,
    service: m.service,
    owner: m.owner,
    sourceRepo: m.source?.repo ?? null,
    sourceRef: m.source?.ref ?? null,
    sourceSha: m.source?.sha ?? null,
    imageTag: m.imageTag ?? null,
    build: pending ? (m.build?.status === "FAIL" ? "failed" : "building") : "ready",
    buildReason: m.build?.reason ?? null,
    argo: pending ? null : argo,
    expiresAt: m.expiresAt,
    url: `https://${m.name}.prv.twizz.com`,
  };
}

/** sha256 over the sorted `owner/name@sha` of every PREVIEWABLE bundle — the
 * exact set of commits a preview is built from. A gate field for the writes:
 * it changes whenever a head moves or the registry mapping changes. Hex, so it
 * can never trip policy.yaml's global deny. */
export function bundleSetHash(bundles: readonly LifecycleBundle[], services: readonly LifecycleServiceInput[] = lifecycleServices()): string {
  const lines = bundleTargets(bundles, services)
    .filter((t) => t.previewable)
    .map((t) => `${t.bundle.github.toLowerCase()}@${t.bundle.headSha}`)
    .sort();
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}

// ── database ──────────────────────────────────────────────────────────────

/** how many snapshot rows (metadata only) the selection looks over */
const META_LOOKBACK = 240;
const REQUEST_LOOKBACK = 100;
/** smoke requests are the gates' evidence: read on their own, so plan/cve requests can never push one out */
const SMOKE_REQUEST_LOOKBACK = 200;
const SIGNOFF_LOOKBACK = 100;

// Payloads are immutable per (id, createdAt) — a replaced runId gets a new
// createdAt — so a parsed payload is reused until its row changes. Only the
// rows the views need are kept (a plan snapshot can be megabytes).
let payloadCache = new Map<string, SnapshotRow>();

export type SnapshotRead = { rows: SnapshotRow[]; metas: SnapshotMeta[]; unreadable: Array<{ runId: string; job: string }> };

export async function readSnapshots(prisma: PrismaClient): Promise<SnapshotRead> {
  const metas: SnapshotMeta[] = await prisma.lifecycleSnapshot.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: META_LOOKBACK,
    select: { id: true, job: true, runId: true, ok: true, startedAt: true, finishedAt: true, createdAt: true },
  });
  const byId = new Map(metas.map((m) => [m.id, m]));
  const keyOf = (m: SnapshotMeta) => `${m.id}:${m.createdAt.getTime()}`;
  const needed = neededSnapshotIds(metas).map((id) => byId.get(id)!);
  const missing = needed.filter((m) => !payloadCache.has(keyOf(m)));
  const unreadable: SnapshotRead["unreadable"] = [];
  const next = new Map<string, SnapshotRow>();
  if (missing.length) {
    const loaded = await prisma.lifecycleSnapshot.findMany({ where: { id: { in: missing.map((m) => m.id) } }, select: { id: true, data: true } });
    const data = new Map(loaded.map((r) => [r.id, r.data]));
    for (const m of missing) {
      // validated on ingest; parsed again so a row written by an older schema can never crash a view
      const parsed = LifecycleSnapshotDoc.safeParse(data.get(m.id));
      if (parsed.success) next.set(keyOf(m), { ...m, data: parsed.data });
      else unreadable.push({ runId: m.runId, job: m.job });
    }
  }
  for (const m of needed) {
    const hit = payloadCache.get(keyOf(m));
    if (hit) next.set(keyOf(m), hit);
  }
  payloadCache = next;
  return { rows: needed.flatMap((m) => next.get(keyOf(m)) ?? []), metas, unreadable };
}

/** Smoke snapshots by run id, for the ones a gate rests on that fell out of the views' window (`readSnapshots`
 * loads the newest `SMOKE_LOOKBACK` only). A row that does not parse is reported, never guessed at. */
export async function readSmokeSnapshotsByRunId(prisma: PrismaClient, runIds: readonly string[]): Promise<{ rows: SnapshotRow[]; unreadable: SnapshotRead["unreadable"] }> {
  if (runIds.length === 0) return { rows: [], unreadable: [] };
  const found = await prisma.lifecycleSnapshot.findMany({
    where: { job: "smoke", runId: { in: [...runIds] } },
    select: { id: true, job: true, runId: true, ok: true, startedAt: true, finishedAt: true, createdAt: true, data: true },
  });
  const rows: SnapshotRow[] = [];
  const unreadable: SnapshotRead["unreadable"] = [];
  for (const { data, ...meta } of found) {
    const parsed = LifecycleSnapshotDoc.safeParse(data);
    if (parsed.success) rows.push({ ...meta, data: parsed.data });
    else unreadable.push({ runId: meta.runId, job: meta.job });
  }
  return { rows, unreadable };
}

export async function readRequests(prisma: PrismaClient, take = REQUEST_LOOKBACK): Promise<RequestRow[]> {
  return prisma.lifecycleRequest.findMany({ orderBy: [{ createdAt: "desc" }, { id: "desc" }], take });
}

/** The newest requests PLUS the newest smoke requests, read separately: the
 * smoke request of an open bundle must not age out of a fixed window because
 * a hundred plan/cve runs were requested after it (the verdict would silently
 * fall back to "not requested yet"). */
export async function readRequestsForPreview(prisma: PrismaClient): Promise<RequestRow[]> {
  const [recent, smoke] = await Promise.all([
    readRequests(prisma),
    prisma.lifecycleRequest.findMany({ where: { kind: "smoke" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: SMOKE_REQUEST_LOOKBACK }),
  ]);
  const byId = new Map<string, RequestRow>();
  for (const r of [...recent, ...smoke]) byId.set(r.id, r);
  return [...byId.values()];
}

/** how many plan runs "last observed" looks back over */
const COVERAGE_LOOKBACK = 30;
const CoverageList = z.array(LifecycleEnvironmentCoverage);

/** The recent plan runs with ONLY their `coverage` (a plan payload is megabytes;
 * the per-environment coverage is a few hundred bytes). Newest first. A row whose
 * coverage is missing or does not parse vouches for nothing (`coverage: null`). */
export async function readPlanCoverage(prisma: PrismaClient, take = COVERAGE_LOOKBACK): Promise<CoverageHistoryRow[]> {
  const rows = await prisma.$queryRaw<Array<{ runId: string; ok: boolean; finishedAt: Date; coverage: unknown }>>`
    SELECT "runId", "ok", "finishedAt", "data"->'coverage' AS "coverage"
      FROM "LifecycleSnapshot"
     WHERE "job" = 'plan'
     ORDER BY "createdAt" DESC, "id" DESC
     LIMIT ${take}`;
  return rows.map((r) => {
    const parsed = CoverageList.safeParse(r.coverage);
    return { job: "plan", runId: r.runId, ok: r.ok, finishedAt: new Date(r.finishedAt), coverage: parsed.success ? parsed.data : null };
  });
}

/** Sign-offs are AuditLog rows written by the gate (`nebula.lifecycle_signoff`).
 * With a `bundleKey` only that bundle's rows are read (the key is in the
 * row's `resource`, the gate fields as JSON) — so neither other bundles'
 * sign-offs nor a run of failed attempts (the gate audits a thrown action as
 * allowed=true with detail.error) can push the real one out of the window. */
export async function readSignoffs(prisma: PrismaClient, bundleKey?: string | null): Promise<SignoffInput[]> {
  const rows = await prisma.auditLog.findMany({
    where: { action: SIGNOFF_AUDIT_ACTION, allowed: true, ...(bundleKey ? { resource: { contains: `"bundleKey":"${bundleKey}"` } } : {}) },
    orderBy: { createdAt: "desc" },
    take: SIGNOFF_LOOKBACK,
    select: { action: true, actor: true, allowed: true, resource: true, detail: true, createdAt: true },
  });
  return rows.flatMap((r) => parseSignoffAudit(r) ?? []).filter((s) => !bundleKey || s.bundleKey === bundleKey);
}

const ENV_CHANGE_LOOKBACK = 500;

/** Nebula's own record of writes to `plo-*` envs since `since` (the moment the bundle's latest preview smoke was
 * requested): the gate audits every confirmed named-env write, whoever made it and whether it threw. With no
 * `since` there is no pass to tie to anything and nothing is read. null: the window is full, so an older change
 * could be missing — the caller treats that as "not known" (fail closed). */
export async function readEnvChanges(prisma: PrismaClient, since: Date | null): Promise<EnvChangeInput[] | null> {
  if (!since) return [];
  const rows = await prisma.auditLog.findMany({
    where: { action: { in: [...ENV_CHANGE_AUDIT_ACTIONS] }, allowed: true, createdAt: { gte: since }, resource: { contains: PLO_ENV_PREFIX } },
    orderBy: { createdAt: "desc" },
    take: ENV_CHANGE_LOOKBACK,
    select: { action: true, allowed: true, resource: true, createdAt: true },
  });
  if (rows.length >= ENV_CHANGE_LOOKBACK) return null;
  return rows.flatMap((r) => parseEnvChangeAudit(r));
}

/** When the latest preview smoke for `bundleKey` was requested; null: never. */
export function latestPreviewSmokeRequestedAt(requests: readonly RequestRow[], bundleKey: string | null): Date | null {
  if (!bundleKey) return null;
  const mine = requests.filter((r) => {
    if (r.kind !== "smoke") return false;
    const p = LifecycleSmokeParams.safeParse(r.params);
    return p.success && p.data.scope === "preview" && p.data.bundleKey === bundleKey;
  });
  return mine.reduce<Date | null>((latest, r) => (!latest || r.createdAt.getTime() > latest.getTime() ? r.createdAt : latest), null);
}

/** Said on the page until it is fixed: a smoke verdict is the word of whoever
 * holds the dispatcher's credential, and ingest gives that role to nobody
 * while the credential is not configured (`identifyIngestCaller` fails closed:
 * the publisher token never answers a smoke request). */
export const DISPATCH_TOKEN_MISSING_NOTICE =
  "the dispatcher's credential (LIFECYCLE_DISPATCH_TOKEN) is not configured on this dashboard: no request can be claimed and no smoke result is accepted from anyone until it is — restart the dashboard once Secret plo-dispatch-env has synced (docs/NEBULA.md §N9, \"Who is trusted for what\")";
function smokeTrustNotice(): string[] {
  return dispatchTokenConfigured() ? [] : [DISPATCH_TOKEN_MISSING_NOTICE];
}

/** A source snapshot is only as good as its key: `bundleKey` must be the
 * sha256 of its own bundles' `github@headSha` lines. Ingest rejects one that
 * is not; this is the same check on the way OUT of the database, so a row
 * stored before that rule (or written around it) can never reach a gate. */
export function sourceKeyProblem(row: SnapshotRow): string | null {
  if (row.job !== "source") return null;
  const computed = lifecycleBundleKey(row.data.bundles ?? []);
  const claimed = row.data.bundleKey ?? null;
  if (computed === claimed) return null;
  return `source snapshot ${row.runId} is ignored: its bundleKey is not the hash of its own bundles (a bundle key must identify exactly the commits it names)`;
}

// ── the outside world (GitHub gitops + Argo), for the preview ─────────────

export type PreviewSources = Pick<PreviewInput, "envs" | "promotions" | "staging"> & { sourceErrors: string[] };

async function readPreviewSourcesNow(): Promise<PreviewSources> {
  const sourceErrors: string[] = [];
  let deps: ReturnType<typeof namedEnvDeps>;
  try {
    deps = namedEnvDeps();
  } catch (e) {
    return { envs: null, promotions: null, staging: null, sourceErrors: [`named envs, promotions and staging could not be read: ${errMsg(e)}`] };
  }
  const [list, envArgo, stagingArgo, promos, targets] = await Promise.all([
    part(listNamedEnvs(deps)),
    readArgoApplications(),
    readArgoApplications(STAGING_LABEL),
    part(listPromotions(deps)),
    Promise.all(PROMOTABLE.map(async (entry) => ({ entry, state: await part(readTargetState(deps, entry.name, "staging")) }))),
  ]);
  if (!envArgo.reachable) sourceErrors.push(`Argo (preview envs) unreachable: ${envArgo.reason ?? "unknown"}`);
  if (!stagingArgo.reachable) sourceErrors.push(`Argo (staging apps) unreachable: ${stagingArgo.reason ?? "unknown"}`);

  let envs: PreviewEnvInput[] | null = null;
  if ("ok" in list) {
    envs = [
      ...list.ok.envs.map((m) => {
        const app = argoStatusFor(envArgo, `env-${m.name}`);
        return toPreviewEnv(m, false, argoWord(app).word, app);
      }),
      ...list.ok.pending.map((m) => toPreviewEnv(m, true, null)),
    ];
    for (const b of list.ok.broken) sourceErrors.push(`named env ${b.path} did not parse: ${b.error}`);
  } else sourceErrors.push(`named envs could not be read: ${list.error}`);

  let promotions: PromotionInput[] | null = null;
  if ("ok" in promos) {
    promotions = promos.ok
      .filter((p) => p.state === "open" && p.target === "staging")
      .map((p) => ({ service: p.service, imageTag: p.imageTag, number: p.number, url: p.url, headSha: p.headSha }));
  } else sourceErrors.push(`promotion pull requests could not be read: ${promos.error}`);

  const staging: StagingTargetInput[] = targets.map(({ entry, state }) => {
    const t = releaseTarget(entry.name, "staging")!;
    const app = argoStatusFor(stagingArgo, t.argoApp);
    const currentTag = "ok" in state ? state.ok.imageTag : null;
    return {
      service: entry.name,
      host: t.host,
      currentTag,
      argo: argoWord(app).word,
      // what staging RUNS, from Argo — gitops only says what it should run
      runsImage: argoRunsImage(app.images, entry.ecrRepo, currentTag),
      rolledOutAt: app.operationFinishedAt ?? null,
      error: "ok" in state ? null : state.error,
    };
  });
  return { envs, promotions, staging, sourceErrors };
}

// ≈ the tab's poll: N viewers share one round of GitHub/Argo reads. The gated
// writes pass `fresh` and never decide on a cached read.
const SOURCES_TTL_MS = 20_000;
let sourcesCache: { at: number; p: Promise<PreviewSources> } | null = null;

export function invalidateLifecycleCache(): void {
  sourcesCache = null;
}

export function readPreviewSources(opts: { fresh?: boolean } = {}): Promise<PreviewSources> {
  if (!opts.fresh && sourcesCache && Date.now() - sourcesCache.at < SOURCES_TTL_MS) return sourcesCache.p;
  const p = readPreviewSourcesNow();
  sourcesCache = { at: Date.now(), p };
  p.catch(() => {
    if (sourcesCache?.p === p) sourcesCache = null;
  });
  return p;
}

/** Everything `buildPreview` needs. `fresh: true` bypasses the 20 s cache of
 * the GitHub/Argo reads — the gated writes MUST use it. */
export async function readPreviewInput(prisma: PrismaClient, opts: { fresh?: boolean; now?: Date } = {}): Promise<PreviewInput> {
  const [snaps, requests, sources] = await Promise.all([readSnapshots(prisma), readRequestsForPreview(prisma), readPreviewSources(opts)]);
  const keyProblems = snaps.rows.flatMap((r) => sourceKeyProblem(r) ?? []);
  const rows = snaps.rows.filter((r) => !sourceKeyProblem(r));
  const key = selectSnapshots(rows).source.data?.data.bundleKey ?? null;
  // the results the open bundle's latest smoke requests were answered with, when later smoke runs pushed them out of the window
  const bound = await readSmokeSnapshotsByRunId(prisma, boundSmokeRunIds(requests, key).filter((runId) => !rows.some((r) => r.job === "smoke" && r.runId === runId)));
  rows.push(...bound.rows);
  snaps.unreadable.push(...bound.unreadable);
  const signoffs = await readSignoffs(prisma, key);
  // a failed read is data, not a thrown page: the model then refuses to tie any preview pass to its env
  const envChanges = await part(readEnvChanges(prisma, latestPreviewSmokeRequestedAt(requests, key)));
  const changes = "ok" in envChanges ? envChanges.ok : null;
  const changesProblem = "ok" in envChanges ? (changes === null ? [`more than ${ENV_CHANGE_LOOKBACK} audited named-env writes since the preview smoke was requested: the list is cut, so the smoke cannot be tied to the preview envs — run the preview smoke again`] : []) : [`the audit log (named-env writes) could not be read: ${envChanges.error}`];
  return {
    rows,
    requests,
    services: lifecycleServices(),
    envs: sources.envs,
    promotions: sources.promotions,
    staging: sources.staging,
    signoffs,
    envChanges: changes,
    now: opts.now ?? new Date(),
    sourceErrors: [...sources.sourceErrors, ...changesProblem, ...keyProblems, ...smokeTrustNotice(), ...snaps.unreadable.map((u) => `${u.job} snapshot ${u.runId} is unreadable (stored by another schema version)`)],
  };
}

/** The preview state machine, evaluated now. For the gated writes: pass
 * `fresh: true` and enforce `view.actions.<action>.allowed`. */
export async function lifecyclePreviewState(prisma: PrismaClient, opts: { fresh?: boolean } = {}): Promise<{ view: PreviewView; input: PreviewInput }> {
  const input = await readPreviewInput(prisma, opts);
  return { view: buildPreview(input), input };
}

// ── the four queries (routers/lifecycle.ts) ───────────────────────────────

export type LifecycleOverview = {
  at: string;
  /** schedule, tiers, header counts, stale flags, recent requests */
  data: Part<OverviewView>;
  /** the bundle pill; its own part because it also reads GitHub and Argo */
  bundle: Part<{ state: PreviewState; detail: string; bundleKey: string | null; key12: string | null }>;
  /** how each environment stands and whether that is known (lifecycle-environments.ts) */
  environments: Part<EnvironmentsView>;
};

export async function lifecycleOverview(prisma: PrismaClient, opts: { components?: boolean } = {}): Promise<LifecycleOverview> {
  const now = new Date();
  const snapsP = Promise.all([readSnapshots(prisma), readRequests(prisma)]);
  const previewP = part(lifecyclePreviewState(prisma).then(({ view, input }) => ({ view, envsRead: input.envs !== null })));
  const [data, preview, environments] = await Promise.all([
    part(
      snapsP.then(([snaps, requests]) => {
        const view = buildOverview({ rows: snaps.rows, requests, now, components: opts.components });
        for (const u of snaps.unreadable) view.discoveryErrors.push({ job: u.job, domain: "nebula", error: `snapshot ${u.runId} is unreadable (stored by another schema version)` });
        return view;
      }),
    ),
    previewP,
    part(
      Promise.all([snapsP, previewP, part(readPlanCoverage(prisma))]).then(([[snaps], pv, history]) => {
        const view = buildEnvironments({
          rows: snaps.rows,
          now,
          planHistory: "ok" in history ? history.ok : undefined,
          preview: "ok" in pv ? pv.ok.view : null,
          previewError: "ok" in pv ? null : pv.error,
          previewEnvsRead: "ok" in pv ? pv.ok.envsRead : true,
        });
        for (const u of snaps.unreadable) view.notes.push(`${u.job} snapshot ${u.runId} is unreadable (stored by another schema version)`);
        return view;
      }),
    ),
  ]);
  const bundle: LifecycleOverview["bundle"] = "ok" in preview ? { ok: { state: preview.ok.view.state, detail: preview.ok.view.detail, bundleKey: preview.ok.view.bundleKey, key12: preview.ok.view.key12 } } : preview;
  return { at: now.toISOString(), data, bundle, environments };
}

export type LifecycleAdvisories = { at: string; data: Part<AdvisoriesView> };

export async function lifecycleAdvisories(prisma: PrismaClient): Promise<LifecycleAdvisories> {
  const now = new Date();
  const data = await part(readSnapshots(prisma).then((snaps) => buildAdvisories(selectSnapshots(snaps.rows), now)));
  return { at: now.toISOString(), data };
}

export type LifecyclePreview = { at: string; data: Part<PreviewView> };

export async function lifecyclePreview(prisma: PrismaClient): Promise<LifecyclePreview> {
  const data = await part(lifecyclePreviewState(prisma).then(({ view }) => view));
  return { at: new Date().toISOString(), data };
}

export type LifecycleHistory = { at: string; data: Part<{ snapshots: HistoryRow[]; requests: RequestView[] }> };

type HistorySql = { id: string; job: string; runId: string; ok: boolean; startedAt: Date; finishedAt: Date; createdAt: Date; error: string | null; requestId: string | null };

export async function lifecycleHistory(prisma: PrismaClient, limit = 50): Promise<LifecycleHistory> {
  const take = Math.max(1, Math.min(200, Math.trunc(limit)));
  const data = await part(
    Promise.all([
      // raw on purpose: only two keys of `data` are needed, and the payloads are megabytes
      prisma.$queryRaw<HistorySql[]>`
        SELECT "id", "job", "runId", "ok", "startedAt", "finishedAt", "createdAt",
               "data"->>'error' AS "error", "data"->>'requestId' AS "requestId"
          FROM "LifecycleSnapshot"
         ORDER BY "createdAt" DESC, "id" DESC
         LIMIT ${take}`,
      readRequests(prisma, take),
    ]).then(([snaps, requests]) => ({
      snapshots: snaps.map(
        (s): HistoryRow => ({
          id: s.id,
          job: s.job,
          runId: s.runId,
          ok: s.ok,
          startedAt: s.startedAt.toISOString(),
          finishedAt: s.finishedAt.toISOString(),
          receivedAt: s.createdAt.toISOString(),
          error: s.error,
          requestId: s.requestId,
        }),
      ),
      requests: requests.map(requestView),
    })),
  );
  return { at: new Date().toISOString(), data };
}

// ── the request queue (the ONLY write in this file) ───────────────────────

/** Two requests are "identical" when they would make PLO do the same thing:
 * same kind, and for a smoke the same scope and bundle. */
export function requestDedupeKey(kind: string, params: unknown): string {
  if (kind === "smoke") {
    const p = params as { scope?: unknown; bundleKey?: unknown } | null;
    return `smoke:${String(p?.scope)}:${String(p?.bundleKey)}`;
  }
  return kind;
}

// one fixed key: serialises "is one already queued? → insert" across replicas
const ENQUEUE_LOCK = 7_239_041;

export type EnqueueResult = { created: true; id: string } | { created: false; existing: { id: string; status: string; requestedBy: string; createdAt: string } };

/** Queue an on-demand run. NOT a gate by itself — call it only from inside a
 * `gateFor(...)` action in routers/actions.ts. Validates `params` for the
 * kind, and refuses (created: false) while an identical request is pending or
 * claimed. The check and the insert run under a transaction-scoped advisory
 * lock, so two operators clicking at once cannot both queue one. */
export async function enqueueLifecycleRequest<K extends LifecycleRequestKind>(prisma: PrismaClient, input: { kind: K; params: LifecycleRequestParams[K]; requestedBy: string }): Promise<EnqueueResult> {
  const params = parseLifecycleRequestParams(input.kind, input.params);
  const key = requestDedupeKey(input.kind, params);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ENQUEUE_LOCK}::bigint)`;
    const active = await tx.lifecycleRequest.findMany({ where: { kind: input.kind, status: { in: ["pending", "claimed"] } }, orderBy: { createdAt: "asc" } });
    const same = active.find((r) => isActiveRequest(r) && requestDedupeKey(r.kind, r.params) === key);
    if (same) return { created: false as const, existing: { id: same.id, status: same.status, requestedBy: same.requestedBy, createdAt: same.createdAt.toISOString() } };
    const row = await tx.lifecycleRequest.create({ data: { kind: input.kind, params: params as unknown as Prisma.InputJsonValue, requestedBy: input.requestedBy }, select: { id: true } });
    return { created: true as const, id: row.id };
  });
}
