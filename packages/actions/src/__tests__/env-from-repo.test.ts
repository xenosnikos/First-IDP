import { describe, expect, it } from "vitest";
import { TwizzYamlV2 } from "@twizz-idp/shared";
import { FakeBuilds, FakeEcr, FakeGitops, FakeSecrets } from "./fakes";
import { createEnvFromRepo, genericEnvSecret, isValidBranch, isValidRepo, rebuildEnv, setEnvVars } from "../env-from-repo";
import { findEnv, listNamedEnvs, parseManifest, teardownNamedEnv } from "../named-envs";
import { envValuesYaml, serviceValuesYaml } from "../values";
import { parseTwizzYaml, stringifyTwizzYaml } from "../twizz-yaml";

const NOW = new Date("2026-09-10T12:00:00Z");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const backendCfg = TwizzYamlV2.parse({ version: 2, kind: "backend", port: 8090, healthPath: "/health", secrets: ["ANTHROPIC_API_KEY"], env: { LOG_LEVEL: "info" }, needs: { mongo: true } });
const frontendCfg = TwizzYamlV2.parse({ version: 2, kind: "frontend", port: 80, healthPath: "/", build: { args: { VITE_BACKEND_URL: "${NEBULA_API_URL}", VITE_SELF: "${NEBULA_ENV_URL}" } }, frontend: { framework: "vite", apiEnvVar: "VITE_BACKEND_URL", serve: "static" } });

function deps() {
  const gitops = new FakeGitops();
  const secrets = new FakeSecrets();
  secrets.store.set("preview/_defaults", { MONGO_URI: "mongodb+srv://u:p@nonprod.mongodb.net/?retryWrites=true" });
  const images = new FakeEcr({});
  const builds = new FakeBuilds();
  return { gitops, secrets, images, builds, now: () => NOW };
}

const base = { name: "sentinel-nebula-test", repo: "twizz-app/twizz-sentinel", ref: "nebula-test", sha: SHA, kind: "backend" as const, db: "isolated" as const, ttlHours: 168, config: backendCfg, envVars: { ANTHROPIC_API_KEY: "sk-ant-secret-value-123", LOG_LEVEL: "debug" }, actor: "rohitagrohia", prNumber: 12, prUrl: "https://github.com/twizz-app/twizz-sentinel/pull/12" };

describe("createEnvFromRepo", () => {
  it("writes the secret, one commit with service values + env values + pending manifest, then dispatches the builder", async () => {
    const d = deps();
    const r = await createEnvFromRepo(d, base);
    expect(r).toMatchObject({ name: base.name, pending: true, service: "twizz-sentinel", expectedTag: `nb-${base.name}-0123456789ab`, secret: "preview/twizz-sentinel/sentinel-nebula-test" });
    // secret: generic blob + user values; never in git
    const blob = d.secrets.store.get(r.secret)!;
    expect(blob).toMatchObject({ PORT: "8090", APP_URL: "https://sentinel-nebula-test.prv.twizz.com", MONGO_URI: "mongodb+srv://u:p@nonprod.mongodb.net/nebula_sentinel-nebula-test?retryWrites=true", ANTHROPIC_API_KEY: "sk-ant-secret-value-123", LOG_LEVEL: "debug" });
    for (const content of d.gitops.files.values()) expect(content).not.toContain("sk-ant-secret-value-123");
    // one atomic commit with the three files
    expect(d.gitops.atomic).toEqual([["apps/twizz-sentinel/values.yaml", "apps/twizz-sentinel/envs/sentinel-nebula-test.yaml", "named-envs/pending/sentinel-nebula-test.yaml"]]);
    const m = parseManifest(d.gitops.files.get("named-envs/pending/sentinel-nebula-test.yaml")!, { where: "pending" });
    expect(m).toMatchObject({ kind: "backend", service: "twizz-sentinel", owner: "rohitagrohia", db: { mode: "isolated", generation: 1 }, source: { repo: base.repo, ref: "nebula-test", sha: SHA, prNumber: 12 }, build: { status: "PENDING", expectedTag: r.expectedTag, startedAt: NOW.toISOString() }, config: { port: 8090, healthPath: "/health", rev: 1, envVarNames: ["ANTHROPIC_API_KEY", "LOG_LEVEL"] } });
    expect(m.imageTag).toBeUndefined();
    // env values carry twizz.yaml defaults, not the dashboard secret
    const envValues = d.gitops.files.get("apps/twizz-sentinel/envs/sentinel-nebula-test.yaml")!;
    expect(envValues).toContain("LOG_LEVEL: info");
    expect(envValues).toContain("path: /health");
    expect(envValues).not.toContain("ANTHROPIC");
    // dispatch
    expect(d.builds.dispatched).toEqual([{ repo: "twizz-sentinel", ref: "nebula-test", sha: SHA, service: "twizz-sentinel", envName: base.name, dockerfile: "Dockerfile", context: ".", buildArgs: {} }]);
    expect(await d.builds.findRun({ displayTitle: r.displayTitle, createdAfter: NOW })).toMatchObject({ status: "queued" });
    // listed as pending; nothing deployable
    const list = await listNamedEnvs(d);
    expect(list.pending.map((x) => x.name)).toEqual([base.name]);
    expect(list.envs).toEqual([]);
  });

  it("does not rewrite the service values file once it exists, and refuses duplicates and the cap", async () => {
    const d = deps();
    await createEnvFromRepo(d, base);
    await createEnvFromRepo(d, { ...base, name: "sentinel-two", sha: "f".repeat(40) });
    expect(d.gitops.atomic[1]).toEqual(["apps/twizz-sentinel/envs/sentinel-two.yaml", "named-envs/pending/sentinel-two.yaml"]);
    await expect(createEnvFromRepo(d, base)).rejects.toThrow(/already exists/);
    await expect(createEnvFromRepo({ ...d, maxNamedEnvs: 2 }, { ...base, name: "sentinel-three" })).rejects.toThrow(/cap/);
  });

  it("frontends substitute placeholders, attach to a deployed backend (one commit), and need attachUrl", async () => {
    const d = deps();
    // a deployed backend to attach to
    const be = { name: "api-main", kind: "backend" as const, service: "twizz-sentinel", owner: "x", imageTag: "nb-api-main-aaaaaaaaaaaa", expiresAt: "2026-09-17T12:00:00.000Z", db: { mode: "none" as const, generation: 0 }, frontendOrigins: [] as string[] };
    const { manifestToYaml } = await import("../named-envs");
    d.gitops.files.set("named-envs/api-main.yaml", manifestToYaml(be));
    await expect(createEnvFromRepo(d, { ...base, name: "biz-feat", repo: "twizz-app/business", kind: "frontend", db: "none", config: frontendCfg, envVars: {}, attachTo: "api-main" })).rejects.toThrow(/attachUrl/);
    const r = await createEnvFromRepo(d, { ...base, name: "biz-feat", repo: "twizz-app/business", kind: "frontend", db: "none", config: frontendCfg, envVars: {}, attachTo: "api-main", attachUrl: "https://api-main.prv.twizz.com" });
    expect(d.builds.dispatched[0].buildArgs).toEqual({ VITE_BACKEND_URL: "https://api-main.prv.twizz.com", VITE_SELF: "https://biz-feat.prv.twizz.com" });
    expect(d.gitops.atomic[0]).toContain("named-envs/api-main.yaml");
    expect(parseManifest(d.gitops.files.get("named-envs/api-main.yaml")!).frontendOrigins).toEqual(["https://biz-feat.prv.twizz.com"]);
    expect(r.manifest.attachTo).toBe("api-main");
    expect(r.manifest.db).toEqual({ mode: "none", generation: 0 });
    expect(d.gitops.files.get("apps/business/values.yaml")).toContain("port: 80");
  });

  it("records FAIL when the dispatch fails, and rethrows", async () => {
    const d = deps();
    d.builds.failDispatch = true;
    await expect(createEnvFromRepo(d, base)).rejects.toThrow(/workflow_dispatch/);
    const m = parseManifest(d.gitops.files.get("named-envs/pending/sentinel-nebula-test.yaml")!, { where: "pending" });
    expect(m.build).toMatchObject({ status: "FAIL", reason: expect.stringMatching(/dispatch/) });
  });

  it("validates inputs before touching anything", async () => {
    const d = deps();
    await expect(createEnvFromRepo(d, { ...base, repo: "someone-else/x" })).rejects.toThrow(/twizz-app/);
    await expect(createEnvFromRepo(d, { ...base, sha: "abc" })).rejects.toThrow(/sha/);
    await expect(createEnvFromRepo(d, { ...base, db: "clone" })).rejects.toThrow(/moly-backend/);
    await expect(createEnvFromRepo(d, { ...base, envVars: { bad: "x" } })).rejects.toThrow(/UPPER_SNAKE/);
    await expect(createEnvFromRepo(d, { ...base, ref: "feat/../x" })).rejects.toThrow(/ref/);
    expect(d.secrets.store.size).toBe(2);
    expect(d.gitops.commits).toEqual([]);
  });

  it("moly-backend keeps its legacy blob derivation and ECR repo", async () => {
    const d = deps();
    const r = await createEnvFromRepo(d, { ...base, name: "moly-feat", repo: "twizz-app/Moly-backend", db: "clone", config: TwizzYamlV2.parse({ version: 2, kind: "backend", port: 8080, healthPath: "/health" }) });
    expect(r.service).toBe("moly-backend");
    expect(d.secrets.store.get("preview/moly-backend/moly-feat")).toMatchObject({ REDIS_HOST: "redis", MONGO_URI: "mongodb+srv://u:p@host/nebula_moly-feat?retryWrites=true" });
    expect(d.gitops.files.get("apps/moly-backend/values.yaml")).toContain("molybackend");
    expect(r.manifest.db).toEqual({ mode: "clone", generation: 1 });
  });
});

describe("rebuild / setEnvVars / teardown", () => {
  it("rebuild writes a pending manifest with the new sha and re-dispatches with the stored build inputs", async () => {
    const d = deps();
    await createEnvFromRepo(d, base);
    // pretend the watcher promoted it
    const pending = parseManifest(d.gitops.files.get("named-envs/pending/sentinel-nebula-test.yaml")!, { where: "pending" });
    const { manifestToYaml } = await import("../named-envs");
    d.gitops.files.delete("named-envs/pending/sentinel-nebula-test.yaml");
    d.gitops.files.set("named-envs/sentinel-nebula-test.yaml", manifestToYaml({ ...pending, imageTag: pending.build!.expectedTag, build: { ...pending.build!, status: "PASS" } }));
    const r = await rebuildEnv(d, { name: base.name, sha: "e".repeat(40), actor: "x" });
    expect(r.expectedTag).toBe(`nb-${base.name}-eeeeeeeeeeee`);
    expect(d.gitops.files.has("named-envs/sentinel-nebula-test.yaml")).toBe(true); // still running the old image
    const p = parseManifest(d.gitops.files.get("named-envs/pending/sentinel-nebula-test.yaml")!, { where: "pending" });
    expect(p.build?.status).toBe("PENDING");
    expect(p.source?.sha).toBe("e".repeat(40));
    expect(d.builds.dispatched.at(-1)).toMatchObject({ sha: "e".repeat(40), dockerfile: "Dockerfile", buildArgs: {} });
  });

  it("setEnvVars merges into the SM blob, deletes on empty, bumps config.rev", async () => {
    const d = deps();
    await createEnvFromRepo(d, base);
    const r = await setEnvVars(d, { name: base.name, vars: { NEW_FLAG: "on", LOG_LEVEL: "" }, actor: "x" });
    expect(r).toEqual({ name: base.name, rev: 2, envVarNames: ["ANTHROPIC_API_KEY", "NEW_FLAG"] });
    const blob = d.secrets.store.get("preview/twizz-sentinel/sentinel-nebula-test")!;
    expect(blob.NEW_FLAG).toBe("on");
    expect(blob.LOG_LEVEL).toBeUndefined();
    expect((await findEnv(d, base.name))!.manifest.config?.rev).toBe(2);
    for (const content of d.gitops.files.values()) expect(content).not.toContain("sk-ant-secret-value-123");
  });

  it("teardown of a pending env removes manifest + env values in one commit and the secret", async () => {
    const d = deps();
    await createEnvFromRepo(d, base);
    const t = await teardownNamedEnv(d, { name: base.name, actor: "x" });
    expect(t.secretDeleted).toBe(true);
    expect(d.gitops.atomic.at(-1)).toEqual(["named-envs/pending/sentinel-nebula-test.yaml", "apps/twizz-sentinel/envs/sentinel-nebula-test.yaml"]);
    expect(d.gitops.files.has("apps/twizz-sentinel/values.yaml")).toBe(true); // service file stays
  });
});

describe("helpers", () => {
  it("validates repos and branch names", () => {
    expect(isValidRepo("twizz-app/x")).toBe(true);
    expect(isValidRepo("Twizz-App/x")).toBe(true);
    expect(isValidRepo("other/x")).toBe(false);
    expect(isValidBranch("feat/add-login")).toBe(true);
    expect(isValidBranch("nebula/biz-feat")).toBe(true);
    expect(isValidBranch("bad..name")).toBe(false);
    expect(isValidBranch("/lead")).toBe(false);
    expect(isValidBranch("x.lock")).toBe(false);
  });
  it("genericEnvSecret needs MONGO_URI only when mongo is needed", () => {
    expect(() => genericEnvSecret({ name: "a", port: 1, needsMongo: true, defaults: {}, envVars: {} })).toThrow(/MONGO_URI/);
    expect(genericEnvSecret({ name: "a", port: 1, needsMongo: false, defaults: {}, envVars: { X: "1", EMPTY: "" } })).toMatchObject({ X: "1", REDIS_HOST: "redis" });
    expect(genericEnvSecret({ name: "a", port: 1, needsMongo: false, defaults: {}, envVars: { EMPTY: "" } }).EMPTY).toBeUndefined();
  });
  it("values generators are deterministic snapshots", () => {
    expect(serviceValuesYaml({ service: "twizz-sentinel", ecrRepo: "twizz-sentinel", kind: "backend" })).toMatchSnapshot();
    expect(envValuesYaml({ name: "x", port: 8090, healthPath: "/health", env: { B: "2", A: "1" }, kind: "backend" })).toMatchSnapshot();
  });
  it("twizz.yaml text round-trips with stable order and omitted defaults", () => {
    const text = stringifyTwizzYaml(backendCfg);
    expect(text).not.toContain("dockerfile:");
    expect(text.indexOf("version: 2")).toBeLessThan(text.indexOf("kind: backend"));
    const back = parseTwizzYaml(text);
    expect(back).toMatchObject({ ok: true, legacy: false });
    if (back.ok) expect(back.config).toEqual(backendCfg);
    expect(parseTwizzYaml("name: x\nkind: backend-k8s\n")).toMatchObject({ ok: true, legacy: true });
    expect(parseTwizzYaml("version: 2\nkind: [\n")).toMatchObject({ ok: false });
  });
});
