import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { TRPCError } from "@trpc/server";
import { MemoryNonceStore, createGate, loadPolicyFile, type BuildInputs, type FileChange } from "@twizz-idp/actions";

// The self-service create path end to end against fake ports: the gate sees
// names + hashes, secret VALUES reach only the secret store, and nothing that
// lands in git, the audit log, the summary or the result carries a value.

const SHA = "0123456789abcdef0123456789abcdef01234567";
const HEAD_AFTER_COMMIT = "fedcba9876543210fedcba9876543210fedcba98";
const SECRET = "sk-ant-THE-SECRET-VALUE-123";

const audit: Array<{ actor: string; action: string; resource?: string; allowed: boolean; detail?: unknown }> = [];
const gitops = { files: new Map<string, string>(), atomic: [] as string[][] };
const secrets = new Map<string, Record<string, string>>();
const dispatched: BuildInputs[] = [];
const github = { refs: new Map<string, string>(), prs: [] as Array<{ head: string; base: string; title: string; body: string }>, blobs: [] as string[] };

const shaOf = (c: string) => `sha-${c.length}`;
const fakeOctokit = () => ({
  git: {
    getRef: async ({ ref }: { ref: string }) => {
      const sha = github.refs.get(ref.replace(/^heads\//, ""));
      if (!sha) throw Object.assign(new Error("Not Found"), { status: 404 });
      return { data: { object: { sha } } };
    },
    createRef: async ({ ref, sha }: { ref: string; sha: string }) => {
      github.refs.set(ref.replace(/^refs\/heads\//, ""), sha);
      return { data: {} };
    },
    updateRef: async ({ ref, sha }: { ref: string; sha: string }) => {
      github.refs.set(ref.replace(/^heads\//, ""), sha);
      return { data: {} };
    },
    createBlob: async ({ content }: { content: string }) => {
      github.blobs.push(content);
      return { data: { sha: "blob" } };
    },
    createTree: async () => ({ data: { sha: "tree" } }),
    createCommit: async () => ({ data: { sha: HEAD_AFTER_COMMIT } }),
  },
  pulls: {
    create: async (p: { head: string; base: string; title: string; body: string }) => {
      github.prs.push(p);
      return { data: { number: github.prs.length, html_url: `https://github.com/twizz-app/twizz-sentinel/pull/${github.prs.length}` } };
    },
  },
});

const nonces = new MemoryNonceStore();
vi.mock("../deps", () => ({
  octokit: () => fakeOctokit(),
  gateFor: (_prisma: unknown, actor: string) =>
    createGate({
      policy: loadPolicyFile(resolve(__dirname, "../../../../../mcp/policy.yaml")),
      nonces,
      audit: async (e) => {
        audit.push({ actor, ...e });
      },
      actionPrefix: "nebula.",
    }),
  namedEnvDeps: () => ({
    gitops: {
      async getFile(path: string) {
        const c = gitops.files.get(path);
        return c === undefined ? null : { content: c, sha: shaOf(c) };
      },
      async putFile(path: string, content: string) {
        gitops.files.set(path, content);
      },
      async deleteFile(path: string) {
        gitops.files.delete(path);
      },
      async listDir(dir: string) {
        return [...gitops.files.keys()].filter((p) => p.startsWith(dir + "/") && !p.slice(dir.length + 1).includes("/")).map((p) => p.slice(dir.length + 1));
      },
      async commit(changes: FileChange[]) {
        for (const c of changes) c.content === null ? gitops.files.delete(c.path) : gitops.files.set(c.path, c.content);
        gitops.atomic.push(changes.map((c) => c.path));
        return "c1";
      },
    },
    secrets: {
      async getJson(name: string) {
        const v = secrets.get(name);
        if (!v) throw new Error(`ResourceNotFoundException: ${name}`);
        return { ...v };
      },
      async createJson(name: string, value: Record<string, string>) {
        secrets.set(name, value);
      },
      async putJson(name: string, value: Record<string, string>) {
        secrets.set(name, value);
      },
      async deleteNow(name: string) {
        secrets.delete(name);
      },
    },
    images: { async describeTag() { return null; }, async listImages() { return []; } },
    builds: {
      async dispatch(i: BuildInputs) {
        dispatched.push(i);
      },
      async findRun() {
        return null;
      },
      async getRun() {
        throw new Error("n/a");
      },
      displayTitle: (i: { envName: string; service: string; sha: string }) => `nebula-build ${i.envName} ${i.service} ${i.sha}`,
    },
  }),
}));
vi.mock("../argo", () => ({ readArgoApplications: async () => ({ reachable: false, reason: "test", apps: [] }), argoStatusFor: () => ({ sync: null, health: null, unreachable: true }) }));

const { actionsRouter } = await import("../../routers/actions");

const prismaRows: unknown[] = [];
const prisma = { auditLog: { create: async ({ data }: { data: unknown }) => { prismaRows.push(data); return data; } } } as never;
const callerFor = (login: string) => actionsRouter.createCaller({ session: { user: { name: login }, login, accessToken: "t" } as never, prisma });

const twizzYaml = ["version: 2", "kind: backend", "port: 8090", "healthPath: /health", "secrets:", "  - ANTHROPIC_API_KEY", "needs:", "  mongo: true", ""].join("\n");
const dockerfile = "FROM node:20-alpine\nCMD [\"node\",\"dist/main.js\"]\n";
const base = {
  name: "sentinel-feat-x",
  repo: "twizz-app/twizz-sentinel",
  ref: "feature/x",
  sha: SHA,
  defaultBranch: "main",
  db: "isolated" as const,
  ttlHours: 48,
  files: [{ path: "twizz.yaml", content: twizzYaml }, { path: "Dockerfile", content: dockerfile }],
  twizzYaml,
  secretNames: [] as string[],
  envOverrides: { LOG_LEVEL: "debug" },
  prTarget: "chosen+default" as const,
};

beforeEach(() => {
  audit.length = 0;
  prismaRows.length = 0;
  gitops.files.clear();
  gitops.atomic.length = 0;
  secrets.clear();
  secrets.set("preview/_defaults", { MONGO_URI: "mongodb+srv://u:p@nonprod.mongodb.net/?retryWrites=true" });
  dispatched.length = 0;
  github.refs.clear();
  github.refs.set("main", "1".repeat(40));
  github.refs.set("feature/x", SHA);
  github.prs.length = 0;
  github.blobs.length = 0;
});

describe("actions.createEnvFromRepo (self-service, gated)", () => {
  it("refuses secret values on the request call and credential-shaped env overrides", async () => {
    const caller = callerFor("rohitagrohia");
    await expect(caller.createEnvFromRepo({ ...base, secretValues: { ANTHROPIC_API_KEY: SECRET } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.createEnvFromRepo({ ...base, envOverrides: { TOKEN: "eyJabcdefghijklmnop.x.y" } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.createEnvFromRepo({ ...base, twizzYaml: "version: 2\nkind: backend\n" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(audit).toEqual([]);
  });

  it("issues a nonce bound to names + hashes; the summary lists every effect and no value", async () => {
    const caller = callerFor("rohitagrohia");
    const r = await caller.createEnvFromRepo(base);
    expect(r).toMatchObject({ confirmationRequired: true });
    const summary = (r as { summary: string }).summary;
    expect(summary).toContain("commit twizz.yaml + Dockerfile on nebula/sentinel-feat-x (off feature/x) and open a PR -> feature/x and a second PR -> main");
    expect(summary).toContain("preview/twizz-sentinel/sentinel-feat-x with 1 declared secret (ANTHROPIC_API_KEY)");
    expect(summary).toContain("named-envs/pending/sentinel-feat-x.yaml");
    expect(summary).toContain("dispatch nebula-build.yml");
    expect(summary).not.toContain("debug");
    expect(gitops.files.size).toBe(0);
    expect(dispatched).toEqual([]);
  });

  it("policy denies prod-shaped names before anything is written, and audits it", async () => {
    const r = await callerFor("rohitagrohia").createEnvFromRepo({ ...base, name: "sentinel-prod" });
    expect(r).toMatchObject({ denied: true });
    expect(audit[0]).toMatchObject({ action: "nebula.create_env_from_repo", allowed: false });
  });

  it("on confirm: branch → config PRs → secret (values) → one gitops commit → dispatch; values never leave the secret store", async () => {
    const caller = callerFor("rohitagrohia");
    const args = { ...base, ref: "feature/new", newBranch: { from: "feature/x" } };
    const issued = (await caller.createEnvFromRepo(args)) as { confirm: string };
    await expect(caller.createEnvFromRepo({ ...args, confirm: issued.confirm, secretValues: { WRONG: "x" } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const done = await caller.createEnvFromRepo({ ...args, confirm: issued.confirm, secretValues: { ANTHROPIC_API_KEY: SECRET } });
    expect(done).toMatchObject({ done: true });
    const result = (done as { result: Record<string, unknown> }).result;
    expect(result).toMatchObject({ name: "sentinel-feat-x", url: "https://sentinel-feat-x.prv.twizz.com", branchCreated: true, source: { ref: "nebula/sentinel-feat-x", sha: HEAD_AFTER_COMMIT }, pr: { number: 1 }, prDefault: { number: 2 }, unsetSecrets: [] });
    // GitHub side
    expect(github.refs.get("feature/new")).toBe(SHA);
    expect(github.refs.get("nebula/sentinel-feat-x")).toBe(HEAD_AFTER_COMMIT);
    expect(github.prs.map((p) => [p.head, p.base])).toEqual([["nebula/sentinel-feat-x", "feature/new"], ["nebula/sentinel-feat-x", "main"]]);
    expect(github.blobs).toEqual([twizzYaml, dockerfile]);
    // secret store: the only place the value lands
    expect(secrets.get("preview/twizz-sentinel/sentinel-feat-x")).toMatchObject({ ANTHROPIC_API_KEY: SECRET, LOG_LEVEL: "debug", PORT: "8090", MONGO_URI: "mongodb+srv://u:p@nonprod.mongodb.net/nebula_sentinel-feat-x?retryWrites=true" });
    // gitops: one atomic commit, pending manifest with the PR, no values
    expect(gitops.atomic).toEqual([["apps/twizz-sentinel/values.yaml", "apps/twizz-sentinel/envs/sentinel-feat-x.yaml", "named-envs/pending/sentinel-feat-x.yaml"]]);
    const manifest = gitops.files.get("named-envs/pending/sentinel-feat-x.yaml")!;
    expect(manifest).toContain("ref: nebula/sentinel-feat-x");
    expect(manifest).toContain("prNumber: 1");
    expect(manifest).toContain("owner: rohitagrohia");
    for (const c of gitops.files.values()) expect(c).not.toContain(SECRET);
    // builder
    expect(dispatched).toEqual([{ repo: "twizz-sentinel", ref: "nebula/sentinel-feat-x", sha: HEAD_AFTER_COMMIT, service: "twizz-sentinel", envName: "sentinel-feat-x", dockerfile: "Dockerfile", context: ".", buildArgs: {} }]);
    // audit + result: names and hashes only
    const rows = JSON.stringify(audit) + JSON.stringify(prismaRows) + JSON.stringify(result);
    expect(rows).not.toContain(SECRET);
    expect(rows).not.toContain("debug");
    expect(audit.at(-1)).toMatchObject({ action: "nebula.create_env_from_repo", allowed: true });
    expect(JSON.parse(audit.at(-1)!.resource!)).toMatchObject({ name: "sentinel-feat-x", secretNames: "ANTHROPIC_API_KEY", newBranch: "feature/new", newBranchFrom: "feature/x", prTarget: "chosen+default" });
  });

  it("refuses to confirm when the pinned branch moved", async () => {
    const caller = callerFor("rohitagrohia");
    const issued = (await caller.createEnvFromRepo(base)) as { confirm: string };
    github.refs.set("feature/x", "2".repeat(40));
    const r = await caller.createEnvFromRepo({ ...base, confirm: issued.confirm, secretValues: { ANTHROPIC_API_KEY: "" } });
    expect(r).toMatchObject({ error: expect.stringMatching(/moved since you pinned it/) });
    expect(gitops.files.size).toBe(0);
    expect(secrets.has("preview/twizz-sentinel/sentinel-feat-x")).toBe(false);
  });

  it("builds the branch as-is when no files are committed (repo already configured)", async () => {
    const caller = callerFor("rohitagrohia");
    const args = { ...base, files: [], prTarget: "chosen" as const };
    const issued = (await caller.createEnvFromRepo(args)) as { confirm: string; summary: string };
    expect(issued.summary).toContain("no config PR");
    const done = (await caller.createEnvFromRepo({ ...args, confirm: issued.confirm, secretValues: { ANTHROPIC_API_KEY: "" } })) as { result: { source: { ref: string; sha: string }; pr?: unknown; unsetSecrets: string[] } };
    expect(done.result.source).toEqual({ ref: "feature/x", sha: SHA });
    expect(done.result.pr).toBeUndefined();
    expect(done.result.unsetSecrets).toEqual(["ANTHROPIC_API_KEY"]);
    expect(github.prs).toEqual([]);
    expect(secrets.get("preview/twizz-sentinel/sentinel-feat-x")!.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe("owner-or-operator", () => {
  it("teardown/extend are refused (and audited) for a non-owner non-operator, allowed for the owner", async () => {
    const owner = callerFor("rohitagrohia");
    const args = { ...base, files: [], prTarget: "chosen" as const };
    const issued = (await owner.createEnvFromRepo(args)) as { confirm: string };
    await owner.createEnvFromRepo({ ...args, confirm: issued.confirm, secretValues: { ANTHROPIC_API_KEY: "" } });

    const stranger = callerFor("someone-else");
    await expect(stranger.teardownNamedEnv({ name: "sentinel-feat-x" })).rejects.toSatisfy((e: unknown) => e instanceof TRPCError && e.code === "FORBIDDEN");
    await expect(stranger.extendNamedEnv({ name: "sentinel-feat-x", ttlHours: 24 })).rejects.toSatisfy((e: unknown) => e instanceof TRPCError && e.code === "FORBIDDEN");
    expect(prismaRows.filter((r) => (r as { allowed: boolean }).allowed === false).map((r) => (r as { action: string }).action)).toEqual(["nebula.teardown_named_env", "nebula.extend_named_env"]);

    expect(await owner.teardownNamedEnv({ name: "sentinel-feat-x" })).toMatchObject({ confirmationRequired: true, summary: expect.stringMatching(/pending manifest/) });
    expect(await callerFor("nick").teardownNamedEnv({ name: "sentinel-feat-x" })).toMatchObject({ confirmationRequired: true });
    await expect(stranger.teardownNamedEnv({ name: "does-not-exist" })).rejects.toSatisfy((e: unknown) => e instanceof TRPCError && e.code === "NOT_FOUND");
  });

  it("setEnvVars binds names + a hash, never values", async () => {
    const owner = callerFor("rohitagrohia");
    const args = { ...base, files: [], prTarget: "chosen" as const };
    const issued = (await owner.createEnvFromRepo(args)) as { confirm: string };
    await owner.createEnvFromRepo({ ...args, confirm: issued.confirm, secretValues: { ANTHROPIC_API_KEY: "" } });
    const r = (await owner.setEnvVars({ name: "sentinel-feat-x", vars: { ANTHROPIC_API_KEY: SECRET, LOG_LEVEL: "" } })) as { confirm: string; summary: string };
    expect(r.summary).toContain("Set 2 env vars on 'sentinel-feat-x' (twizz-sentinel): ANTHROPIC_API_KEY; delete LOG_LEVEL");
    expect(r.summary).not.toContain(SECRET);
    const done = await owner.setEnvVars({ name: "sentinel-feat-x", vars: { ANTHROPIC_API_KEY: SECRET, LOG_LEVEL: "" }, confirm: r.confirm });
    expect(done).toMatchObject({ done: true, result: { rev: 2, envVarNames: ["ANTHROPIC_API_KEY"] } });
    expect(secrets.get("preview/twizz-sentinel/sentinel-feat-x")).toMatchObject({ ANTHROPIC_API_KEY: SECRET });
    expect(secrets.get("preview/twizz-sentinel/sentinel-feat-x")!.LOG_LEVEL).toBeUndefined();
    expect(JSON.stringify(audit)).not.toContain(SECRET);
    expect(JSON.parse(audit.at(-1)!.resource!)).toMatchObject({ name: "sentinel-feat-x", varNames: "ANTHROPIC_API_KEY LOG_LEVEL" });
  });
});
