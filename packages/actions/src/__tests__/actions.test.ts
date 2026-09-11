import { describe, expect, it } from "vitest";
import { FakeEcr, FakeGitops, FakeSecrets } from "./fakes";
import {
  cloneStagingDb,
  createNamedEnv,
  extendNamedEnv,
  listNamedEnvs,
  listReleaseImages,
  manifestToYaml,
  parseManifest,
  teardownNamedEnv,
  type GitopsRepo,
  type ImageInfo,
  type ImageRegistry,
  type SecretStore,
} from "../named-envs";

const TAG = "build-75b95f51-a1de-432d-8132-33a2802f622c";
const NOW = new Date("2026-09-07T12:00:00Z");

function deps(overrides: Partial<{ maxNamedEnvs: number }> = {}) {
  const gitops = new FakeGitops();
  gitops.files.set("named-envs/README.md", "# not an env");
  const secrets = new FakeSecrets();
  const images = new FakeEcr({
    molybackend: [
      { tags: ["latest", "prod", TAG], pushedAt: new Date("2026-08-31T17:43:21Z"), digest: "sha256:aaa" },
      { tags: ["dev", "build-ca68a294-91b7-427f-aefe-d9c3e03c7ab8"], pushedAt: new Date("2026-08-20T15:59:09Z"), digest: "sha256:bbb" },
      { tags: ["build-00000000-0000-0000-0000-000000000000"], pushedAt: new Date("2026-01-01T00:00:00Z"), digest: "sha256:ccc" },
      { tags: ["pr-12-deadbeef"], pushedAt: new Date("2026-09-01T00:00:00Z"), digest: "sha256:ddd" },
    ],
  });
  return { gitops, secrets, images, now: () => NOW, ...overrides };
}

const input = { name: "smoke", service: "moly-backend" as const, imageTag: TAG, db: "clone" as const, ttlHours: 168, actor: "local:nick" };

describe("createNamedEnv", () => {
  it("writes the derived secret then the manifest, and returns the env facts", async () => {
    const d = deps();
    const res = await createNamedEnv(d, input);

    const secret = d.secrets.store.get("preview/moly-backend/smoke")!;
    expect(secret.MONGO_URI).toBe("mongodb+srv://u:p@host/nebula_smoke?retryWrites=true");
    expect(secret.SHIFT_FOUR_MONGO_URI).toBe("mongodb+srv://u:p@host/nebula_smoke");
    expect(secret.BUSINESS_URL).toBe("https://smoke-frontend.prv.twizz.com");
    expect(secret.TOKEN_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(secret.REDIS_HOST).toBe("redis");
    expect(secret.REDIS_PASSWORD).toBe("");
    expect(d.secrets.tags.get("preview/moly-backend/smoke")).toEqual({ "nebula-env": "smoke", "nebula-service": "moly-backend" });

    const manifest = parseManifest(d.gitops.files.get("named-envs/smoke.yaml")!);
    expect(manifest).toEqual({
      name: "smoke",
      service: "moly-backend",
      kind: "backend",
      owner: "local-nick",
      imageTag: TAG,
      expiresAt: "2026-09-14T12:00:00.000Z",
      db: { mode: "clone", generation: 1 },
      frontendOrigins: ["https://smoke-frontend.prv.twizz.com"],
    });
    expect(d.gitops.commits).toEqual(["nebula: create env smoke (local:nick)"]);
    expect(res.url).toBe("https://smoke.prv.twizz.com");
    expect(res.argoApp).toBe("env-smoke");
    expect(res.db).toBe("nebula_smoke");
    expect(res.image.aliases).toEqual(["latest", "prod"]);
  });

  it("refuses an env that already exists (idempotent) without touching secrets", async () => {
    const d = deps();
    await createNamedEnv(d, input);
    await expect(createNamedEnv(d, input)).rejects.toThrow(/already exists/);
    expect(d.gitops.commits).toHaveLength(1);
    expect(d.secrets.store.size).toBe(2);
  });

  it("refuses alias tags and tags missing from ECR before writing anything", async () => {
    const d = deps();
    await expect(createNamedEnv(d, { ...input, imageTag: "latest" })).rejects.toThrow(/immutable build-\*/);
    await expect(createNamedEnv(d, { ...input, imageTag: "build-ffffffff-ffff-ffff-ffff-ffffffffffff" })).rejects.toThrow(/not found in ECR/);
    expect(d.secrets.store.size).toBe(1);
    expect(d.gitops.commits).toHaveLength(0);
  });

  it("enforces the live-env cap (README.md is not an env)", async () => {
    const d = deps({ maxNamedEnvs: 2 });
    await createNamedEnv(d, { ...input, name: "one" });
    await createNamedEnv(d, { ...input, name: "two" });
    await expect(createNamedEnv(d, { ...input, name: "three" })).rejects.toThrow(/cap reached \(2\/2\)/);
  });

  it("validates name, ttl and frontendOrigin", async () => {
    const d = deps();
    await expect(createNamedEnv(d, { ...input, name: "Bad" })).rejects.toThrow(/invalid env name/);
    await expect(createNamedEnv(d, { ...input, ttlHours: 0 })).rejects.toThrow(/ttlHours/);
    await expect(createNamedEnv(d, { ...input, ttlHours: 337 })).rejects.toThrow(/ttlHours/);
    await expect(createNamedEnv(d, { ...input, frontendOrigins: ["http://insecure"] })).rejects.toThrow(/https/);
  });

  it("accepts several frontend origins; the first one becomes BUSINESS_URL", async () => {
    const d = deps();
    await createNamedEnv(d, { ...input, frontendOrigins: ["https://smoke-fe.prv.twizz.com", "https://smoke-business.prv.twizz.com"] });
    expect(parseManifest(d.gitops.files.get("named-envs/smoke.yaml")!).frontendOrigins).toEqual(["https://smoke-fe.prv.twizz.com", "https://smoke-business.prv.twizz.com"]);
    expect(d.secrets.store.get("preview/moly-backend/smoke")!.BUSINESS_URL).toBe("https://smoke-fe.prv.twizz.com");
  });
});

describe("teardownNamedEnv", () => {
  it("deletes the manifest and force-deletes the secret", async () => {
    const d = deps();
    await createNamedEnv(d, input);
    const res = await teardownNamedEnv(d, { name: "smoke", actor: "local:nick" });
    expect(d.gitops.files.has("named-envs/smoke.yaml")).toBe(false);
    expect(d.secrets.store.has("preview/moly-backend/smoke")).toBe(false);
    expect(res.secretDeleted).toBe(true);
    expect(res.note).toMatch(/Namespace env-smoke is reaped separately/);
    expect(d.gitops.commits.at(-1)).toBe("nebula: teardown env smoke (local:nick)");
  });
  it("refuses an unknown env, and reports (not throws) a missing secret", async () => {
    const d = deps();
    await expect(teardownNamedEnv(d, { name: "ghost", actor: "a" })).rejects.toThrow(/does not exist/);
    await createNamedEnv(d, input);
    d.secrets.store.delete("preview/moly-backend/smoke");
    const res = await teardownNamedEnv(d, { name: "smoke", actor: "a" });
    expect(res.manifestDeleted).toBe(true);
    expect(res.secretDeleted).toBe(false);
    expect(res.secretError).toMatch(/ResourceNotFound/);
  });
});

describe("cloneStagingDb / extendNamedEnv / list", () => {
  it("bumps db.generation and forces clone mode", async () => {
    const d = deps();
    await createNamedEnv(d, { ...input, db: "isolated" });
    const res = await cloneStagingDb(d, { name: "smoke", actor: "a" });
    expect(res.generation).toBe(2);
    expect(res.previousMode).toBe("isolated");
    expect(res.source).toBe("preview/moly-backend");
    expect(parseManifest(d.gitops.files.get("named-envs/smoke.yaml")!).db).toEqual({ mode: "clone", generation: 2 });
  });
  it("extends expiresAt from now and keeps everything else", async () => {
    const d = deps();
    await createNamedEnv(d, input);
    const later = { ...d, now: () => new Date("2026-09-10T00:00:00Z") };
    const res = await extendNamedEnv(later, { name: "smoke", ttlHours: 24, actor: "a" });
    expect(res.previousExpiresAt).toBe("2026-09-14T12:00:00.000Z");
    expect(res.expiresAt).toBe("2026-09-11T00:00:00.000Z");
    const m = parseManifest(d.gitops.files.get("named-envs/smoke.yaml")!);
    expect(m.expiresAt).toBe("2026-09-11T00:00:00.000Z");
    expect(m.imageTag).toBe(TAG);
  });
  it("lists envs sorted by name, ignoring README", async () => {
    const d = deps();
    await createNamedEnv(d, { ...input, name: "zeta" });
    await createNamedEnv(d, { ...input, name: "alpha" });
    expect((await listNamedEnvs(d)).envs.map((m) => m.name)).toEqual(["alpha", "zeta"]);
  });
  it("isolates a broken manifest and lists pending envs separately", async () => {
    const d = deps();
    await createNamedEnv(d, { ...input, name: "alpha" });
    d.gitops.files.set("named-envs/broken.yaml", "name: Bad\nservice: x\n");
    d.gitops.files.set("named-envs/pending/beta.yaml", manifestToYaml({ name: "beta", kind: "backend", service: "twizz-sentinel", owner: "x", expiresAt: "2026-09-17T12:00:00.000Z", db: { mode: "none", generation: 0 }, frontendOrigins: [], build: { status: "RUNNING", expectedTag: "nb-beta-aaaaaaaaaaaa", startedAt: "2026-09-10T12:00:00.000Z" } }));
    const r = await listNamedEnvs(d);
    expect(r.envs.map((m) => m.name)).toEqual(["alpha"]);
    expect(r.pending.map((m) => m.name)).toEqual(["beta"]);
    expect(r.broken).toEqual([{ path: "named-envs/broken.yaml", error: expect.stringMatching(/invalid name/) }]);
    // the cap counts pending too
    await expect(createNamedEnv({ ...d, maxNamedEnvs: 2 }, { ...input, name: "gamma" })).rejects.toThrow(/cap/);
    // teardown of a pending env removes it in one commit
    const t = await teardownNamedEnv(d, { name: "beta", actor: "x" });
    expect(t.pending).toBe(true);
    expect(d.gitops.files.has("named-envs/pending/beta.yaml")).toBe(false);
  });
  it("lists release images newest first with aliases, skipping non-build tags", async () => {
    const d = deps();
    const imgs = await listReleaseImages(d, "moly-backend", 2);
    expect(imgs.map((i) => i.tag)).toEqual([TAG, "build-ca68a294-91b7-427f-aefe-d9c3e03c7ab8"]);
    expect(imgs[0].aliases).toEqual(["latest", "prod"]);
    expect(imgs[1].aliases).toEqual(["dev"]);
    expect(imgs[0].pushedAt).toBe("2026-08-31T17:43:21.000Z");
  });
});
