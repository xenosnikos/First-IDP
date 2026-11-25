import { afterEach, describe, expect, it, vi } from "vitest";
import type { NamedEnvManifest } from "@twizz-idp/actions";
import type { PrismaClient } from "@twizz-idp/db";
import { bundleSetHash, invalidateLifecycleCache, lifecycleServices, readSnapshots, requestDedupeKey, toPreviewEnv } from "../lifecycle";
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
      expiresAt: "2026-11-28T12:00:00.000Z",
      url: "https://plo-2611-twizz-sentinel.prv.twizz.com",
    });
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
  const guard = () => {
    if (state.fail) throw new Error("db down");
  };
  const prisma = {
    lifecycleSnapshot: {
      findMany: async (args: { where?: { id: { in: string[] } }; select: Record<string, boolean> }) => {
        guard();
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
  return { prisma: prisma as unknown as PrismaClient, loads };
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

  it("builds the views from stored snapshots", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    const source = snap("source", ago(DAY), { bundleKey: KEY, bundles: [bundle("twizz-app/twizz-sentinel", SHA_SENTINEL)] });
    const c = caller(fakePrisma({ snapshots: [source, snap("plan", ago(2 * DAY))] }).prisma);
    const overview = await c.overview({ components: false });
    expect(overview.bundle).toMatchObject({ ok: { state: "bundle-ready", key12: KEY.slice(0, 12) } });
    expect("ok" in overview.data && overview.data.ok.runs.plan?.ok).toBe(true);
    const preview = await c.preview();
    // the named envs could not be read (no GitHub token): no write is offered
    expect("ok" in preview.data && preview.data.ok.actions.createPreview).toEqual({ allowed: false, reason: "the named-env manifests could not be read" });
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
