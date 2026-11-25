import { afterEach, describe, expect, it, vi } from "vitest";
import { lifecycleBundleKey, type NamedEnvManifest } from "@twizz-idp/actions";
import type { PrismaClient } from "@twizz-idp/db";
import { DISPATCH_TOKEN_MISSING_NOTICE, bundleSetHash, invalidateLifecycleCache, latestPreviewSmokeRequestedAt, lifecycleServices, readEnvChanges, readPlanCoverage, readPreviewInput, readSmokeSnapshotsByRunId, readRequestsForPreview, readSignoffs, readSnapshots, requestDedupeKey, sourceKeyProblem, toPreviewEnv } from "../lifecycle";
import { boundSmokeRunIds, parseEnvChangeAudit, smokeVerdict } from "../lifecycle-model";
import { lifecycleRouter } from "../../routers/lifecycle";
import type { Context } from "../../context";
import { DAY, HOUR, KEY, OTHER_KEY, SHA_BACKEND, SHA_SENTINEL, ago, bundle, snap } from "./lifecycle-fixtures";

afterEach(() => {
  vi.unstubAllEnvs();
  invalidateLifecycleCache();
});

describe("registry → model inputs", () => {
  it("lists every registry service, marking the ones on the release train", () => {
    const by = Object.fromEntries(lifecycleServices().map((s) => [s.service, s]));
    expect(by["twizz-sentinel"]).toEqual({ service: "twizz-sentinel", repo: "twizz-app/twizz-sentinel", promotable: true, stagingHost: "sentinel-stg.prv.twizz.com" });
    expect(by["twizz-admin"]).toMatchObject({ repo: "twizz-app/front-admin", promotable: true, stagingHost: "admin-stg.prv.twizz.com" });
    expect(by["moly-backend"]).toMatchObject({ repo: "twizz-app/Moly-backend", promotable: false, stagingHost: null });
  });

  it("toPreviewEnv maps a deployable, a building and a failed manifest", () => {
    const base: NamedEnvManifest = {
      name: "plo-2611-twizz-sentinel",
      kind: "backend",
      service: "twizz-sentinel",
      owner: "nick",
      expiresAt: "2026-11-28T12:00:00.000Z",
      db: { mode: "none", generation: 0 },
      frontendOrigins: [],
      source: { repo: "twizz-app/twizz-sentinel", ref: "plo/bundle/2026-11", sha: SHA_SENTINEL },
    };
    expect(toPreviewEnv({ ...base, imageTag: "nb-plo-2611-twizz-sentinel-a1a1a1a1a1a1" }, false, "PASS")).toEqual({
      name: "plo-2611-twizz-sentinel",
      service: "twizz-sentinel",
      owner: "nick",
      sourceRepo: "twizz-app/twizz-sentinel",
      sourceRef: "plo/bundle/2026-11",
      sourceSha: SHA_SENTINEL,
      imageTag: "nb-plo-2611-twizz-sentinel-a1a1a1a1a1a1",
      build: "ready",
      buildReason: null,
      argo: "PASS",
      // Argo's Application was not handed in: nothing says what runs, so nothing is claimed — and that is "not read"
      argoUnread: true,
      runsImage: false,
      rolledOutAt: null,
      // this manifest records no build config, so no Service port: the preview smoke has no address for it
      port: null,
      // `nick` is a default operator
      trusted: true,
      expiresAt: "2026-11-28T12:00:00.000Z",
      url: "https://plo-2611-twizz-sentinel.prv.twizz.com",
    });
    // the Service port the preview smoke calls is the one the manifest records (twizz.yaml `port` at that commit)
    expect(toPreviewEnv({ ...base, imageTag: "nb-plo-2611-twizz-sentinel-a1a1a1a1a1a1", config: { port: 8090, healthPath: "/health", rev: 1, envVarNames: [] } }, false, "PASS").port).toBe(8090);
    // what RUNS comes from Argo's own report of the Application, never from Synced + Healthy alone
    const tag = "nb-plo-2611-twizz-sentinel-a1a1a1a1a1a1";
    const app = (images: string[] | undefined, operationFinishedAt: string | null = "2026-11-25T10:00:00Z") => ({ sync: "Synced", health: "Healthy", images, operationFinishedAt });
    const ecr = "848281935985.dkr.ecr.eu-west-1.amazonaws.com/twizz-sentinel";
    expect(toPreviewEnv({ ...base, imageTag: tag }, false, "PASS", app([`${ecr}:${tag}`, "redis:7"]))).toMatchObject({ runsImage: true, rolledOutAt: "2026-11-25T10:00:00Z" });
    expect(toPreviewEnv({ ...base, imageTag: tag }, false, "PASS", app([`${ecr}:nb-plo-2611-twizz-sentinel-000000000000`]))).toMatchObject({ runsImage: false });
    expect(toPreviewEnv({ ...base, imageTag: tag }, false, "PASS", app([`${ecr}:${tag}`, `${ecr}:nb-plo-2611-twizz-sentinel-000000000000`]))).toMatchObject({ runsImage: false }); // mid-rollout: both
    expect(toPreviewEnv({ ...base, imageTag: tag }, false, "PASS", app([]))).toMatchObject({ runsImage: false });
    expect(toPreviewEnv({ ...base, imageTag: tag }, false, "PASS", app(undefined, null))).toMatchObject({ runsImage: false, rolledOutAt: null });
    expect(toPreviewEnv({ ...base, imageTag: tag }, true, "PASS", app([`${ecr}:${tag}`]))).toMatchObject({ runsImage: false, rolledOutAt: null }); // still building
    // the owner is what makes an env a bundle preview candidate at all
    expect(toPreviewEnv({ ...base, owner: "rohitagrohia", imageTag: tag }, false, "PASS").trusted).toBe(false);
    vi.stubEnv("NEBULA_OPERATORS", "someone-else");
    expect(toPreviewEnv({ ...base, imageTag: tag }, false, "PASS").trusted).toBe(false);
    vi.unstubAllEnvs();
    const building = toPreviewEnv({ ...base, build: { status: "RUNNING", expectedTag: "t", startedAt: "2026-11-25T11:00:00Z" } }, true, "PASS");
    expect(building).toMatchObject({ build: "building", imageTag: null, argo: null });
    expect(toPreviewEnv({ ...base, build: { status: "FAIL", expectedTag: "t", startedAt: "x", reason: "docker build exited 1" } }, true, null)).toMatchObject({ build: "failed", buildReason: "docker build exited 1" });
    expect(toPreviewEnv({ ...base, source: undefined, imageTag: "build-x" }, false, "UNKNOWN")).toMatchObject({ sourceRepo: null, sourceRef: null, sourceSha: null, argo: "UNKNOWN" });
  });
});

describe("bundleSetHash", () => {
  const services = [
    { service: "twizz-sentinel", repo: "twizz-app/twizz-sentinel", promotable: true, stagingHost: "h" },
    { service: "moly-backend", repo: "twizz-app/Moly-backend", promotable: false, stagingHost: null },
  ];
  const a = bundle("twizz-app/twizz-sentinel", SHA_SENTINEL);
  const b = bundle("twizz-app/Moly-backend", SHA_BACKEND);

  it("is a sha256 hex digest of the exact (repository, commit) set, whatever the order or case", () => {
    const h = bundleSetHash([a, b], services);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(bundleSetHash([b, a], services)).toBe(h);
    expect(bundleSetHash([{ ...a, github: "Twizz-App/TWIZZ-SENTINEL" }, b], services)).toBe(h);
  });

  it("changes when a head moves or a repository joins or leaves the set", () => {
    const h = bundleSetHash([a, b], services);
    expect(bundleSetHash([{ ...a, headSha: "c".repeat(40) }, b], services)).not.toBe(h);
    expect(bundleSetHash([a], services)).not.toBe(h);
  });

  it("covers only what Nebula can preview", () => {
    const h = bundleSetHash([a, b], services);
    expect(bundleSetHash([a, b, bundle("twizz-app/lolygram-discover", SHA_SENTINEL), bundle("twizz-app/twizz-sentinel", null)], services)).toBe(h);
    expect(bundleSetHash([a, b], [services[0]])).not.toBe(h);
  });
});

describe("requestDedupeKey", () => {
  it("plan and cve are identical by kind; smoke by scope and bundle", () => {
    expect(requestDedupeKey("plan", {})).toBe("plan");
    expect(requestDedupeKey("cve", {})).toBe("cve");
    const p = { scope: "preview", bundleKey: KEY, targets: [{ name: "a", baseUrl: "https://a.prv.twizz.com" }] };
    expect(requestDedupeKey("smoke", p)).toBe(requestDedupeKey("smoke", { ...p, targets: [] }));
    expect(requestDedupeKey("smoke", p)).not.toBe(requestDedupeKey("smoke", { ...p, scope: "stg" }));
    expect(requestDedupeKey("smoke", p)).not.toBe(requestDedupeKey("smoke", { ...p, bundleKey: OTHER_KEY }));
    expect(requestDedupeKey("smoke", null)).toBe("smoke:undefined:undefined");
  });
});

/** the slice of Prisma the reader uses, over arrays */
function fakePrisma(state: { snapshots: ReturnType<typeof snap>[]; requests?: unknown[]; audits?: unknown[]; fail?: boolean }) {
  const loads: string[][] = [];
  const byRunId: string[][] = [];
  const guard = () => {
    if (state.fail) throw new Error("db down");
  };
  const prisma = {
    lifecycleSnapshot: {
      findMany: async (args: { where?: { id: { in: string[] }; runId?: { in: string[] }; job?: string }; select: Record<string, boolean> }) => {
        guard();
        // a smoke result fetched by the run id its request is bound to (pass 3 #10)
        if (args.where?.runId) {
          byRunId.push([...args.where.runId.in]);
          return state.snapshots.filter((s) => s.job === args.where!.job && args.where!.runId!.in.includes(s.runId));
        }
        if (args.where) {
          loads.push([...args.where.id.in].sort());
          return state.snapshots.filter((s) => args.where!.id.in.includes(s.id)).map((s) => ({ id: s.id, data: s.data }));
        }
        return [...state.snapshots].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).map(({ data: _data, ...meta }) => meta);
      },
    },
    lifecycleRequest: { findMany: async () => (guard(), state.requests ?? []) },
    auditLog: { findMany: async () => (guard(), state.audits ?? []) },
    $queryRaw: async () => (guard(), []),
  };
  return { prisma: prisma as unknown as PrismaClient, loads, byRunId };
}

describe("readSnapshots", () => {
  it("loads only the payloads the views need, once, and reloads a replaced row", async () => {
    const old = snap("plan", ago(9 * DAY));
    const plan = snap("plan", ago(DAY), { runId: "plan-current" });
    const cve = snap("cve", ago(HOUR));
    const state = { snapshots: [old, plan, cve] };
    const { prisma, loads } = fakePrisma(state);
    const first = await readSnapshots(prisma);
    expect(first.rows.map((r) => r.id).sort()).toEqual([plan.id, cve.id].sort());
    expect(first.metas).toHaveLength(3);
    expect(loads).toEqual([[plan.id, cve.id].sort()]);
    // nothing changed: no payload is fetched again
    await readSnapshots(prisma);
    expect(loads).toHaveLength(1);
    // the same runId was re-ingested (createdAt moved): only that payload is fetched again
    state.snapshots = [old, { ...plan, createdAt: new Date(), data: { ...plan.data, error: "replaced" } }, cve];
    const third = await readSnapshots(prisma);
    expect(loads).toEqual([[plan.id, cve.id].sort(), [plan.id]]);
    expect(third.rows.find((r) => r.id === plan.id)?.data.error).toBe("replaced");
  });

  it("pass 3 #10: the result bound to the open bundle's latest smoke request is loaded by run id when it is outside the window", async () => {
    const sourceRow = snap("source", ago(2 * DAY), { runId: "source-1", bundles: [bundle("twizz-app/twizz-sentinel", SHA_SENTINEL)], bundleKey: lifecycleBundleKey([bundle("twizz-app/twizz-sentinel", SHA_SENTINEL)])! });
    const key = sourceRow.data.bundleKey!;
    const target = [{ name: "twizz-sentinel", baseUrl: "http://twizz-sentinel.env-plo-2611-twizz-sentinel.svc.cluster.local:8090" }];
    const req = { id: "req-preview", kind: "smoke", params: { scope: "preview", bundleKey: key, targets: target }, requestedBy: "nick", status: "done", createdAt: ago(30 * HOUR), claimedAt: ago(30 * HOUR - 60_000), finishedAt: ago(30 * HOUR - 180_000), runId: "smoke-preview-1", error: null };
    const result = snap("smoke", ago(30 * HOUR - 120_000), { runId: "smoke-preview-1", requestId: req.id, smoke: { scope: "preview", bundleKey: key, results: [{ name: "twizz-sentinel/health", url: `${target[0].baseUrl}/health`, ok: true, status: 200, ms: 9, detail: "ok" }] } });
    // 31 newer smoke snapshots (other runs) push it out of the views' window
    const later = Array.from({ length: 31 }, (_, i) => snap("smoke", ago((20 - i * 0.5) * HOUR), { runId: `smoke-other-${i}`, smoke: { scope: "stg", bundleKey: OTHER_KEY, results: [] } }));
    const { prisma, byRunId } = fakePrisma({ snapshots: [sourceRow, result, ...later], requests: [req] });
    expect((await readSnapshots(prisma)).rows.some((r) => r.runId === "smoke-preview-1")).toBe(false);
    vi.stubEnv("GITHUB_TOKEN", "");
    const input = await readPreviewInput(prisma);
    expect(byRunId).toEqual([["smoke-preview-1"]]);
    expect(input.rows.filter((r) => r.runId === "smoke-preview-1")).toHaveLength(1);
    expect(smokeVerdict("preview", key, input.requests, input.rows)).toMatchObject({ verdict: "pass", runId: "smoke-preview-1" });
    expect(boundSmokeRunIds(input.requests, key)).toEqual(["smoke-preview-1"]);
    expect(boundSmokeRunIds(input.requests, null)).toEqual([]);
    // nothing to fetch when the bound result is already in the window
    expect(await readSmokeSnapshotsByRunId(prisma, [])).toEqual({ rows: [], unreadable: [] });
  });

  it("drops a row stored by another schema version instead of crashing the page", async () => {
    const good = snap("cve", ago(HOUR));
    const bad = { ...snap("plan", ago(HOUR), { runId: "plan-v0" }), data: { schemaVersion: 0, legacy: true } as never };
    const { prisma } = fakePrisma({ snapshots: [good, bad] });
    const read = await readSnapshots(prisma);
    expect(read.rows.map((r) => r.id)).toEqual([good.id]);
    expect(read.unreadable).toEqual([{ runId: "plan-v0", job: "plan" }]);
  });
});

describe("lifecycle router", () => {
  const session = { user: { name: "nick" }, login: "nick" };
  const caller = (prisma: PrismaClient, signedIn = true) => lifecycleRouter.createCaller({ session: signedIn ? session : null, prisma } as unknown as Context);

  it("is queries only: overview, advisories, preview, history", () => {
    const procs = lifecycleRouter._def.procedures as Record<string, { _def: { type: string } }>;
    expect(Object.keys(procs).sort()).toEqual(["advisories", "history", "overview", "preview"]);
    expect(Object.values(procs).every((p) => p._def.type === "query")).toBe(true);
  });

  it("refuses every query without a session", async () => {
    const c = caller(fakePrisma({ snapshots: [] }).prisma, false);
    for (const call of [() => c.overview(), () => c.advisories(), () => c.preview(), () => c.history()]) await expect(call()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("answers from an empty database: default schedule, UNKNOWN staleness, no bundle", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    const c = caller(fakePrisma({ snapshots: [] }).prisma);
    const overview = await c.overview();
    expect("ok" in overview.data && overview.data.ok.schedule.source).toBe("default");
    expect("ok" in overview.data && overview.data.ok.stale.plan.word).toBe("UNKNOWN");
    expect(overview.bundle).toMatchObject({ ok: { state: "no-bundle", bundleKey: null } });
    expect(await c.advisories()).toMatchObject({ data: { ok: { total: 0, scan: null } } });
    expect(await c.history({ limit: 10 })).toMatchObject({ data: { ok: { snapshots: [], requests: [] } } });
    const preview = await c.preview();
    // GitHub is not configured here: reported as data, and the state machine fails closed
    expect("ok" in preview.data && preview.data.ok.blockers.join("\n")).toMatch(/GITHUB_TOKEN is not configured/);
    expect(preview).toMatchObject({ data: { ok: { state: "no-bundle" } } });
  });

  it("overview carries every fixed environment, even from an empty database — as not observed", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    const overview = await caller(fakePrisma({ snapshots: [] }).prisma).overview({ components: false });
    expect("ok" in overview.environments && overview.environments.ok.environments.map((e) => [e.name, e.word, e.observation.state])).toEqual([
      ["nonprod", "UNKNOWN", "not-observed"],
      ["staging", "UNKNOWN", "not-observed"],
      ["prod", "UNKNOWN", "not-observed"],
    ]);
    expect("ok" in overview.environments && overview.environments.ok).toMatchObject({ observed: 0, fixed: 3 });
  });

  it("a database failure is the environments part's error, never an empty or green list", async () => {
    const overview = await caller(fakePrisma({ snapshots: [], fail: true }).prisma).overview();
    expect(overview.environments).toEqual({ error: "db down" });
    expect(overview.data).toEqual({ error: "db down" });
  });

  it("readPlanCoverage keeps only what parses: a row without (or with a malformed) coverage vouches for nothing", async () => {
    const cov = [{ environment: "prod", clusters: ["EKS-Moly-Prod"], tiers: [{ tier: "control-plane", state: "observed", components: 1, gaps: [] }] }];
    const prisma = {
      $queryRaw: async () => [
        { runId: "plan-3", ok: true, finishedAt: ago(HOUR), coverage: cov },
        { runId: "plan-2", ok: true, finishedAt: ago(DAY), coverage: null },
        { runId: "plan-1", ok: false, finishedAt: ago(2 * DAY), coverage: [{ environment: "prod", tiers: [{ tier: "control-plane", state: "fine" }] }] },
      ],
    } as unknown as PrismaClient;
    expect(await readPlanCoverage(prisma)).toEqual([
      { job: "plan", runId: "plan-3", ok: true, finishedAt: ago(HOUR), coverage: cov },
      { job: "plan", runId: "plan-2", ok: true, finishedAt: ago(DAY), coverage: null },
      { job: "plan", runId: "plan-1", ok: false, finishedAt: ago(2 * DAY), coverage: null },
    ]);
  });

  it("builds the views from stored snapshots", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    // the key Nebula itself computes for this bundle — any other is not accepted (see the next test)
    const REAL_KEY = lifecycleBundleKey([{ github: "twizz-app/twizz-sentinel", headSha: SHA_SENTINEL }])!;
    const source = snap("source", ago(DAY), { bundleKey: REAL_KEY, bundles: [bundle("twizz-app/twizz-sentinel", SHA_SENTINEL)] });
    const c = caller(fakePrisma({ snapshots: [source, snap("plan", ago(2 * DAY))] }).prisma);
    const overview = await c.overview({ components: false });
    expect(overview.bundle).toMatchObject({ ok: { state: "bundle-ready", key12: REAL_KEY.slice(0, 12) } });
    expect("ok" in overview.data && overview.data.ok.runs.plan?.ok).toBe(true);
    const preview = await c.preview();
    // the named envs could not be read (no GitHub token): no write is offered
    expect("ok" in preview.data && preview.data.ok.actions.createPreview).toEqual({ allowed: false, reason: "the named-env manifests could not be read" });
  });

  // external review 2026-11-25, idp #2: the key is a claim until Nebula recomputes it
  it("a source snapshot whose bundleKey is not the hash of its own bundles never becomes a bundle", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    const honest = lifecycleBundleKey([{ github: "twizz-app/twizz-sentinel", headSha: SHA_SENTINEL }])!;
    // the key of the tested commit, re-pointed at another commit (stored before ingest checked it, or written around it)
    const forged = snap("source", ago(HOUR), { runId: "source-forged", bundleKey: honest, bundles: [bundle("twizz-app/twizz-sentinel", SHA_BACKEND)] });
    const c = caller(fakePrisma({ snapshots: [forged] }).prisma);
    const preview = await c.preview();
    expect(preview).toMatchObject({ data: { ok: { state: "no-bundle", bundleKey: null } } });
    expect("ok" in preview.data && preview.data.ok.blockers.join("\n")).toMatch(/source snapshot source-forged is ignored: its bundleKey is not the hash of its own bundles/);
    expect("ok" in preview.data && Object.values(preview.data.ok.actions).every((a) => !a.allowed)).toBe(true);
    expect(sourceKeyProblem(forged)).toMatch(/is ignored/);
    expect(sourceKeyProblem(snap("source", ago(HOUR), { bundleKey: honest, bundles: [bundle("twizz-app/twizz-sentinel", SHA_SENTINEL)] }))).toBeNull();
    expect(sourceKeyProblem(snap("source", ago(HOUR), { bundles: [bundle("twizz-app/twizz-sentinel", null)] }))).toBeNull();
    expect(sourceKeyProblem(snap("source", ago(HOUR), { bundles: [bundle("twizz-app/twizz-sentinel", SHA_SENTINEL)] }))).toMatch(/is ignored/);
    expect(sourceKeyProblem(snap("plan", ago(HOUR)))).toBeNull();
  });

  it("says so, on the page, while the dispatcher credential is not configured (nobody can answer a smoke request)", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("LIFECYCLE_INGEST_TOKEN", "i".repeat(40));
    vi.stubEnv("LIFECYCLE_DISPATCH_TOKEN", "");
    const c = caller(fakePrisma({ snapshots: [] }).prisma);
    const shared = await c.preview();
    expect("ok" in shared.data && shared.data.ok.blockers).toContain(DISPATCH_TOKEN_MISSING_NOTICE);
    vi.stubEnv("LIFECYCLE_DISPATCH_TOKEN", "d".repeat(40));
    invalidateLifecycleCache();
    const split = await c.preview();
    expect("ok" in split.data && split.data.ok.blockers).not.toContain(DISPATCH_TOKEN_MISSING_NOTICE);
    // the same secret twice is not a second credential
    vi.stubEnv("LIFECYCLE_DISPATCH_TOKEN", "i".repeat(40));
    const same = await c.preview();
    expect("ok" in same.data && same.data.ok.blockers).toContain(DISPATCH_TOKEN_MISSING_NOTICE);
  });

  // external review 2026-11-25, idp #15: fixed look-back windows must not drop the evidence of an open bundle
  it("reads smoke requests on their own and sign-offs by bundle key, so neither can age out behind unrelated rows", async () => {
    const calls: Array<{ model: string; where: unknown; take: unknown }> = [];
    const smoke = { id: "smoke-old", kind: "smoke", params: {}, requestedBy: "nick", status: "done", createdAt: ago(20 * DAY), claimedAt: null, finishedAt: null, runId: null, error: null };
    const plans = Array.from({ length: 100 }, (_, i) => ({ ...smoke, id: `plan-${i}`, kind: "plan", createdAt: ago(i * HOUR) }));
    const prisma = {
      lifecycleRequest: {
        findMany: async (args: { where?: { kind?: string }; take?: number }) => {
          calls.push({ model: "request", where: args.where ?? null, take: args.take });
          return args.where?.kind === "smoke" ? [smoke] : plans;
        },
      },
      auditLog: {
        findMany: async (args: { where: unknown; take?: number }) => {
          calls.push({ model: "audit", where: args.where, take: args.take });
          return [];
        },
      },
    } as unknown as PrismaClient;
    const requests = await readRequestsForPreview(prisma);
    expect(requests).toHaveLength(101);
    expect(requests.map((r) => r.id)).toContain("smoke-old");
    expect(calls).toContainEqual({ model: "request", where: { kind: "smoke" }, take: 200 });
    await readSignoffs(prisma, KEY);
    expect(calls.at(-1)).toMatchObject({ model: "audit", where: { action: "nebula.lifecycle_signoff", allowed: true, resource: { contains: `"bundleKey":"${KEY}"` } } });
  });

  it("pass 3 #2: toPreviewEnv says whether Argo was READ — unreachable is not, a building env has nothing to read", () => {
    const m: NamedEnvManifest = { name: "plo-2611-twizz-sentinel", kind: "backend", service: "twizz-sentinel", owner: "nick", imageTag: "nb-plo-2611-twizz-sentinel-a1a1a1a1a1a1", expiresAt: "2026-11-28T12:00:00.000Z", db: { mode: "none", generation: 0 }, frontendOrigins: [] };
    expect(toPreviewEnv(m, false, "UNKNOWN", { sync: null, health: null, unreachable: true })).toMatchObject({ argo: "UNKNOWN", argoUnread: true, runsImage: false, rolledOutAt: null });
    expect(toPreviewEnv(m, false, "PENDING", { sync: null, health: null })).toMatchObject({ argo: "PENDING", argoUnread: false });
    expect(toPreviewEnv(m, false, "PASS", { sync: "Synced", health: "Healthy", images: [], operationFinishedAt: null })).toMatchObject({ argoUnread: false });
    expect(toPreviewEnv({ ...m, imageTag: undefined, build: { status: "RUNNING", expectedTag: "t", startedAt: "2026-11-25T11:00:00Z" } }, true, null)).toMatchObject({ argo: null, argoUnread: false });
  });

  it("pass 3 #1: named-env writes are read back from the audit log, from the smoke request on, and a full window is 'not known'", async () => {
    const at = new Date("2026-11-25T11:20:00.000Z");
    const row = (action: string, fields: Record<string, string>, over: { allowed?: boolean } = {}) => ({ action, allowed: over.allowed ?? true, resource: JSON.stringify(fields), createdAt: at });
    expect(parseEnvChangeAudit(row("nebula.rebuild_env", { name: "plo-2611-moly-backend", sha: "a".repeat(40) }))).toEqual([{ envName: "plo-2611-moly-backend", action: "nebula.rebuild_env", at }]);
    expect(parseEnvChangeAudit(row("mcp.set_env_vars", { name: "plo-2611-moly-backend", varNames: "A", varsHash: "x" }))).toHaveLength(1);
    expect(parseEnvChangeAudit(row("nebula.lifecycle_create_preview", { bundleKey: KEY, setHash: "x", envs: "plo-2611-moly-backend plo-2611-twizz-sentinel", ttlHours: "72" })).map((c) => c.envName)).toEqual(["plo-2611-moly-backend", "plo-2611-twizz-sentinel"]);
    // a denial changed nothing; teardown and extend are not changes to what an env runs; other envs are not ours
    expect(parseEnvChangeAudit(row("nebula.rebuild_env", { name: "plo-2611-moly-backend" }, { allowed: false }))).toEqual([]);
    expect(parseEnvChangeAudit(row("nebula.teardown_named_env", { name: "plo-2611-moly-backend" }))).toEqual([]);
    expect(parseEnvChangeAudit(row("nebula.extend_named_env", { name: "plo-2611-moly-backend", ttlHours: "24" }))).toEqual([]);
    expect(parseEnvChangeAudit(row("nebula.rebuild_env", { name: "my-env" }))).toEqual([]);
    expect(parseEnvChangeAudit({ action: "nebula.rebuild_env", allowed: true, resource: "not json", createdAt: at })).toEqual([]);

    const calls: unknown[] = [];
    const prismaWith = (rows: unknown[]) => ({ auditLog: { findMany: async (q: unknown) => (calls.push(q), rows) } }) as unknown as PrismaClient;
    // no preview smoke was ever requested: there is no pass to tie to anything, and nothing is read
    expect(await readEnvChanges(prismaWith([]), null)).toEqual([]);
    expect(calls).toEqual([]);
    const since = new Date("2026-11-25T11:00:00.000Z");
    expect(await readEnvChanges(prismaWith([row("nebula.rebuild_env", { name: "plo-2611-moly-backend" })]), since)).toEqual([{ envName: "plo-2611-moly-backend", action: "nebula.rebuild_env", at }]);
    expect(calls[0]).toMatchObject({ where: { allowed: true, createdAt: { gte: since }, resource: { contains: "plo-" }, action: { in: expect.arrayContaining(["nebula.rebuild_env", "nebula.set_env_vars", "nebula.clone_staging_db", "nebula.lifecycle_create_preview", "mcp.rebuild_env"]) } }, take: 500 });
    // a full window may have cut an older change off: not known, never "none"
    expect(await readEnvChanges(prismaWith(Array.from({ length: 500 }, () => row("nebula.rebuild_env", { name: "plo-2611-moly-backend" }))), since)).toBeNull();

    const smoke = (scope: string, key: string, createdAt: Date) => ({ id: `r-${scope}-${createdAt.getTime()}`, kind: "smoke", params: { scope, bundleKey: key, targets: [{ name: "twizz-sentinel", baseUrl: scope === "stg" ? "https://sentinel-stg.prv.twizz.com" : "http://twizz-sentinel.env-plo-2611-twizz-sentinel.svc.cluster.local:8090" }] }, requestedBy: "nick", status: "done", createdAt, claimedAt: null, finishedAt: null, runId: null, error: null });
    const requests = [smoke("preview", KEY, ago(3 * HOUR)), smoke("preview", KEY, ago(HOUR)), smoke("stg", KEY, ago(60_000)), smoke("preview", OTHER_KEY, ago(30_000))];
    expect(latestPreviewSmokeRequestedAt(requests, KEY)).toEqual(ago(HOUR));
    expect(latestPreviewSmokeRequestedAt(requests, null)).toBeNull();
    expect(latestPreviewSmokeRequestedAt([], KEY)).toBeNull();
  });

  it("returns a database failure as data, never as a thrown error", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    const c = caller(fakePrisma({ snapshots: [], fail: true }).prisma);
    expect(await c.overview()).toMatchObject({ data: { error: "db down" }, bundle: { error: "db down" } });
    expect(await c.advisories()).toMatchObject({ data: { error: "db down" } });
    expect(await c.preview()).toMatchObject({ data: { error: "db down" } });
    expect(await c.history()).toMatchObject({ data: { error: "db down" } });
  });

  it("validates the history limit", async () => {
    const c = caller(fakePrisma({ snapshots: [] }).prisma);
    await expect(c.history({ limit: 0 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(c.history({ limit: 201 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
