import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { MemoryNonceStore, createGate, loadPolicyFile, manifestToYaml, nebulaTag, parseManifest, type BuildInputs, type FileChange, type NamedEnvManifest, type PromotionPr } from "@twizz-idp/actions";
import { KEY, OTHER_KEY, SHA_BACKEND, SHA_SENTINEL, bundle, snap } from "./lifecycle-fixtures";

// The five Lifecycle writes end to end through the tRPC procedures: the real
// reader and state machine, the real gate and policy.yaml, the real GitHub
// adapter over a fake Octokit, fake gitops / secrets / ECR / builder /
// promotion ports and an in-memory slice of Prisma. What is asserted here is
// what only the wiring can break: operators only, fields that bind the effect
// (and never say prod), refusals audited, the action re-planning inside the
// gate, and the whole bundle → preview → smoke → staging → sign-off path.

const SENTINEL = "twizz-app/twizz-sentinel";
const BACKEND = "twizz-app/Moly-backend";
const BRANCH = "plo/bundle/2026-11";
const ENV_S = "plo-2611-twizz-sentinel";
const ENV_B = "plo-2611-moly-backend";
const TAG_S = nebulaTag(ENV_S, SHA_SENTINEL);
const STAGING_VALUES = "apps/twizz-sentinel/values-staging.yaml";
const VALUES = (tag: string) => `nameOverride: twizz-sentinel\n\nimage:\n  repository: 848281935985.dkr.ecr.eu-west-1.amazonaws.com/twizz-sentinel\n  tag: ${tag} # promoted by Nebula\n`;
const OLD_TAG = "main-0000000000000000000000000000000000000000";
const BACKEND_YAML = ["version: 2", "kind: backend", "port: 8090", "healthPath: /health", "secrets:", "  - ANTHROPIC_API_KEY", ""].join("\n");

type Audit = { actor: string; action: string; resource?: string | null; allowed: boolean; detail?: unknown; createdAt: Date };
type Req = { id: string; kind: string; params: unknown; requestedBy: string; status: string; createdAt: Date; claimedAt: Date | null; finishedAt: Date | null; runId: string | null; error: string | null };

const db = { snapshots: [] as ReturnType<typeof snap>[], requests: [] as Req[], audits: [] as Audit[] };
const gitops = { files: new Map<string, string>(), commits: 0 };
const secrets = new Map<string, Record<string, string>>();
const images = new Set<string>();
const dispatched: BuildInputs[] = [];
const promos = { main: new Map<string, string>(), prs: [] as Array<PromotionPr & { files: Record<string, string> }>, merged: 0 };
const github = {
  heads: new Map<string, string>(),
  files: new Map<string, string>(),
  comments: [] as Array<{ repo: string; pr: number; body: string }>,
  /** the Nth head read (1-based) and every later one returns `moved` */
  moveHeadsFromRead: 0,
  headReads: 0,
  calls: [] as string[],
};
const argo = { apps: {} as Record<string, { sync: string; health: string }> };
const HEALTHY = { sync: "Synced", health: "Healthy" };

const notFound = () => Object.assign(new Error("Not Found"), { status: 404 });
const fakeOctokit = () => {
  const issues = {
    listComments: async ({ owner, repo, issue_number }: { owner: string; repo: string; issue_number: number }) => ({ data: github.comments.filter((c) => c.repo === `${owner}/${repo}` && c.pr === issue_number).map((c) => ({ body: c.body })) }),
    createComment: async ({ owner, repo, issue_number, body }: { owner: string; repo: string; issue_number: number; body: string }) => {
      github.calls.push("issues.createComment");
      github.comments.push({ repo: `${owner}/${repo}`, pr: issue_number, body });
      return { data: { html_url: `https://github.com/${owner}/${repo}/pull/${issue_number}#issuecomment-${github.comments.length}` } };
    },
  };
  return {
    git: {
      getRef: async ({ owner, repo, ref }: { owner: string; repo: string; ref: string }) => {
        github.calls.push("git.getRef");
        github.headReads += 1;
        const sha = github.heads.get(`${owner}/${repo}#${ref.replace(/^heads\//, "")}`);
        if (!sha) throw notFound();
        return { data: { object: { sha: github.moveHeadsFromRead && github.headReads >= github.moveHeadsFromRead ? "9".repeat(40) : sha } } };
      },
    },
    repos: {
      getContent: async ({ owner, repo, path, ref }: { owner: string; repo: string; path: string; ref: string }) => {
        github.calls.push("repos.getContent");
        const c = github.files.get(`${owner}/${repo}@${ref}:${path}`);
        if (c === undefined) throw notFound();
        return { data: { type: "file", content: Buffer.from(c, "utf8").toString("base64"), sha: "blob" } };
      },
    },
    issues,
    paginate: async (fn: (a: unknown) => Promise<{ data: unknown[] }>, args: unknown) => {
      github.calls.push("issues.listComments");
      return (await fn(args)).data;
    },
  };
};

const policy = loadPolicyFile(resolve(__dirname, "../../../../../mcp/policy.yaml"));
const nonces = new MemoryNonceStore();
vi.mock("../deps", () => ({
  octokit: () => fakeOctokit(),
  policy: () => policy,
  gateFor: (_prisma: unknown, actor: string) =>
    createGate({
      policy,
      nonces,
      // the same store readSignoffs reads: a sign-off is the gate's own audit row
      audit: async (e) => {
        db.audits.push({ actor, createdAt: new Date(), ...e });
      },
      actionPrefix: "nebula.",
      actor,
    }),
  namedEnvDeps: () => ({
    gitops: {
      async getFile(path: string) {
        const c = gitops.files.get(path);
        return c === undefined ? null : { content: c, sha: `sha-${c.length}` };
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
        for (const c of changes) {
          if (c.content === null) gitops.files.delete(c.path);
          else gitops.files.set(c.path, c.content);
        }
        gitops.commits += 1;
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
        if (secrets.has(name)) throw new Error(`ResourceExistsException: ${name}`);
        secrets.set(name, value);
      },
      async putJson(name: string, value: Record<string, string>) {
        secrets.set(name, value);
      },
      async deleteNow(name: string) {
        secrets.delete(name);
      },
    },
    images: {
      async describeTag(repo: string, tag: string) {
        return images.has(`${repo}:${tag}`) ? { tags: [tag], pushedAt: new Date(), digest: "sha256:x" } : null;
      },
      async listImages() {
        return [];
      },
    },
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
    promotions: {
      async readFile(path: string) {
        const c = promos.main.get(path);
        return c === undefined ? null : { content: c, sha: "s" };
      },
      async openPr(input: { branch: string; files: Record<string, string>; title: string }) {
        const number = 100 + promos.prs.length + 1;
        const url = `https://github.com/TwizzyNicky/twizz-gitops/pull/${number}`;
        promos.prs.push({ number, url, title: input.title, branch: input.branch, headSha: "d".repeat(40), author: "nebula", createdAt: new Date().toISOString(), state: "open", files: input.files });
        return { number, url, headSha: "d".repeat(40) };
      },
      async listOpenPrs(prefix: string) {
        return promos.prs.filter((p) => p.state === "open" && p.branch.startsWith(prefix)).map(({ files: _f, ...p }) => p);
      },
      async getPr() {
        return null;
      },
      async mergePr() {
        promos.merged += 1;
        throw new Error("the Lifecycle writes must never merge");
      },
      async listPrFiles() {
        return [];
      },
      async changedOnBaseSince() {
        return [];
      },
    },
  }),
}));
vi.mock("../argo", () => ({
  STAGING_LABEL: "twizz-idp/tier=staging",
  readArgoApplications: async () => ({ reachable: true, apps: argo.apps }),
  argoStatusFor: (map: { apps: Record<string, unknown> }, name: string) => map.apps[name] ?? { sync: null, health: null },
}));

const { actionsRouter } = await import("../../routers/actions");
const { bundleSetHash, invalidateLifecycleCache, lifecyclePreviewState } = await import("../lifecycle");

type Where = { kind?: string; status?: { in: string[] }; id?: { in: string[] }; action?: string; allowed?: boolean };
const matches = (r: Req, w: Where = {}) => (!w.kind || r.kind === w.kind) && (!w.status || w.status.in.includes(r.status));
let reqSeq = 0;
const prisma = {
  lifecycleSnapshot: {
    findMany: async (args: { where?: Where }) => {
      if (args.where?.id) return db.snapshots.filter((s) => args.where!.id!.in.includes(s.id)).map((s) => ({ id: s.id, data: s.data }));
      return [...db.snapshots].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).map(({ data: _d, ...meta }) => meta);
    },
  },
  lifecycleRequest: {
    findMany: async (args: { where?: Where }) => db.requests.filter((r) => matches(r, args.where)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    findFirst: async (args: { where?: Where }) => db.requests.find((r) => matches(r, args.where)) ?? null,
    create: async ({ data }: { data: { kind: string; params: unknown; requestedBy: string } }) => {
      const row: Req = { id: `req${String(++reqSeq).padStart(4, "0")}`, ...data, status: "pending", createdAt: new Date(), claimedAt: null, finishedAt: null, runId: null, error: null };
      db.requests.push(row);
      return { id: row.id };
    },
  },
  auditLog: {
    findMany: async (args: { where?: Where }) => db.audits.filter((a) => (!args.where?.action || a.action === args.where.action) && (args.where?.allowed === undefined || a.allowed === args.where.allowed)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    create: async ({ data }: { data: Omit<Audit, "createdAt"> }) => {
      db.audits.push({ ...data, createdAt: new Date() });
      return data;
    },
  },
  $executeRaw: async () => 1,
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
} as never;

const callerFor = (login: string) => actionsRouter.createCaller({ session: { user: { name: login }, login, accessToken: "t" } as never, prisma });
const nick = () => callerFor("nick");

type Gated = { confirmationRequired?: true; summary: string; confirm: string; done?: true; result: Record<string, unknown>; error?: string; denied?: true; reason?: string };
/** request, then confirm with the issued nonce */
async function twoStep<A extends object>(call: (a: A & { confirm?: string }) => Promise<unknown>, args: A): Promise<{ issued: Gated; done: Gated }> {
  const issued = (await call(args)) as Gated;
  expect(issued, JSON.stringify(issued)).toMatchObject({ confirmationRequired: true });
  const done = (await call({ ...args, confirm: issued.confirm })) as Gated;
  return { issued, done };
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

/** what the build-watcher does when an image lands: pending → deployable */
function promoteBuilds(builtAt = minutesAgo(30)) {
  for (const [path, text] of [...gitops.files]) {
    if (!path.startsWith("named-envs/pending/")) continue;
    const m = parseManifest(text, { where: "pending" });
    const next: NamedEnvManifest = { ...m, imageTag: m.build!.expectedTag, build: { ...m.build!, status: "PASS", startedAt: new Date(builtAt.getTime() - 10 * 60_000).toISOString(), finishedAt: builtAt.toISOString() } };
    gitops.files.delete(path);
    gitops.files.set(`named-envs/${m.name}.yaml`, manifestToYaml(next));
    argo.apps[`env-${m.name}`] = HEALTHY;
    images.add(`${m.service === "moly-backend" ? "molybackend" : m.service}:${next.imageTag}`);
  }
}

/** what plo-dispatch does with the newest pending smoke request */
function runSmoke(over: { ok?: boolean } = {}) {
  const req = db.requests.filter((r) => r.kind === "smoke" && r.status === "pending").at(-1)!;
  const p = req.params as { scope: "preview" | "stg"; bundleKey: string; targets: Array<{ name: string; baseUrl: string }> };
  Object.assign(req, { status: "done", claimedAt: new Date(), finishedAt: new Date(), runId: `smoke-${p.scope}-${req.id}` });
  db.snapshots.push(
    snap("smoke", new Date(), {
      runId: req.runId!,
      requestId: req.id,
      smoke: { scope: p.scope, bundleKey: p.bundleKey, results: p.targets.map((t) => ({ name: `${t.name}/health`, url: `${t.baseUrl}/health`, ok: over.ok ?? true, status: over.ok === false ? 503 : 200, ms: 12, detail: "status 200" })) },
    }),
  );
  return req;
}

/** what merging the promotion PR and Argo's sync do */
function mergePromotionAndSync() {
  for (const pr of promos.prs) {
    pr.state = "merged";
    for (const [path, content] of Object.entries(pr.files)) promos.main.set(path, content);
  }
  argo.apps["staging-twizz-sentinel"] = HEALTHY;
}

beforeEach(() => {
  invalidateLifecycleCache();
  db.snapshots = [snap("source", minutesAgo(24 * 60), { runId: "source-nov", bundleKey: KEY, bundles: [bundle(SENTINEL, SHA_SENTINEL), bundle(BACKEND, SHA_BACKEND)] })];
  db.requests = [];
  db.audits = [];
  gitops.files.clear();
  gitops.commits = 0;
  secrets.clear();
  secrets.set("preview/moly-backend", { MONGO_URI: "mongodb+srv://u:p@host/moly", TOKEN_SECRET: "old" });
  images.clear();
  dispatched.length = 0;
  promos.main.clear();
  promos.main.set(STAGING_VALUES, VALUES(OLD_TAG));
  promos.main.set("apps/twizz-admin/values-staging.yaml", VALUES(OLD_TAG));
  promos.prs.length = 0;
  promos.merged = 0;
  github.heads.clear();
  github.heads.set(`${SENTINEL}#${BRANCH}`, SHA_SENTINEL);
  github.heads.set(`${BACKEND}#${BRANCH}`, SHA_BACKEND);
  github.files.clear();
  for (const [repo, sha] of [[SENTINEL, SHA_SENTINEL], [BACKEND, SHA_BACKEND]] as const) {
    github.files.set(`${repo}@${sha}:twizz.yaml`, BACKEND_YAML);
    github.files.set(`${repo}@${sha}:Dockerfile`, "FROM node:22-alpine\n");
  }
  github.comments.length = 0;
  github.moveHeadsFromRead = 0;
  github.headReads = 0;
  github.calls.length = 0;
  argo.apps = { "staging-twizz-sentinel": HEALTHY, "staging-twizz-admin": HEALTHY };
  vi.unstubAllEnvs();
});

const denials = () => db.audits.filter((a) => !a.allowed);
const fieldsOf = (a: Audit) => JSON.parse(a.resource ?? "{}") as Record<string, string>;

describe("who may", () => {
  it("every Lifecycle write is operators only, and the refusal is audited", async () => {
    const dev = callerFor("rohitagrohia");
    const calls: Array<[string, () => Promise<unknown>]> = [
      ["lifecycleRequestRun", () => dev.lifecycleRequestRun({ kind: "plan" })],
      ["lifecycleCreatePreview", () => dev.lifecycleCreatePreview({ bundleKey: KEY })],
      ["lifecycleRequestSmoke", () => dev.lifecycleRequestSmoke({ scope: "preview", bundleKey: KEY })],
      ["lifecycleDeployStg", () => dev.lifecycleDeployStg({ bundleKey: KEY })],
      ["lifecycleSignoff", () => dev.lifecycleSignoff({ bundleKey: KEY })],
    ];
    for (const [, call] of calls) await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(denials().map((a) => [a.actor, a.action])).toEqual(calls.map(([name]) => ["rohitagrohia", `nebula.${name}`]));
    expect(db.requests).toEqual([]);
    expect(gitops.commits).toBe(0);
  });

  it("refuses without a session and validates the input shape", async () => {
    const anon = actionsRouter.createCaller({ session: null, prisma } as never);
    await expect(anon.lifecycleSignoff({ bundleKey: KEY })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(nick().lifecycleCreatePreview({ bundleKey: "latest" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(nick().lifecycleRequestRun({ kind: "smoke" as never })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(nick().lifecycleRequestRun({ kind: "source" as never })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(nick().lifecycleRequestSmoke({ scope: "staging" as never, bundleKey: KEY })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(nick().lifecycleRequestSmoke({ scope: "production" as never, bundleKey: KEY })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("lifecycleRequestRun", () => {
  it("queues a plan run after the two-step confirm; a second one is refused and audited while it is in flight", async () => {
    const { issued, done } = await twoStep(nick().lifecycleRequestRun, { kind: "plan" as const });
    expect(issued.summary).toContain("Request an on-demand plan run");
    expect(db.requests).toHaveLength(1);
    expect(done).toMatchObject({ done: true, result: { kind: "plan", status: "pending", requestId: db.requests[0].id } });
    expect(db.requests[0]).toMatchObject({ kind: "plan", params: {}, requestedBy: "nick", status: "pending" });
    expect(db.audits.at(-1)).toMatchObject({ action: "nebula.lifecycle_request_run", allowed: true, resource: JSON.stringify({ kind: "plan" }) });

    await expect(callerFor("igor").lifecycleRequestRun({ kind: "plan" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/a plan run is already pending \(requested by nick/) });
    expect(denials().at(-1)).toMatchObject({ actor: "igor", action: "nebula.lifecycle_request_run", detail: { reason: expect.stringMatching(/already pending/) } });
    // a cve run is a different request
    expect((await twoStep(callerFor("igor").lifecycleRequestRun, { kind: "cve" as const })).done).toMatchObject({ done: true });
    expect(db.requests.map((r) => r.kind)).toEqual(["plan", "cve"]);
  });

  it("when two operators confirm at once, the insert refuses the second", async () => {
    const a = (await nick().lifecycleRequestRun({ kind: "cve" })) as Gated;
    const b = (await callerFor("igor").lifecycleRequestRun({ kind: "cve" })) as Gated;
    expect(await nick().lifecycleRequestRun({ kind: "cve", confirm: a.confirm })).toMatchObject({ done: true });
    await expect(callerFor("igor").lifecycleRequestRun({ kind: "cve", confirm: b.confirm })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(db.requests).toHaveLength(1);
  });

  it("another operator cannot use a nonce issued to someone else", async () => {
    const a = (await nick().lifecycleRequestRun({ kind: "plan" })) as Gated;
    expect(await callerFor("igor").lifecycleRequestRun({ kind: "plan", confirm: a.confirm })).toMatchObject({ denied: true });
    expect(db.requests).toEqual([]);
  });
});

describe("the whole path: bundle → preview → smoke → staging → sign-off", () => {
  it("runs each step only when the one before it is evidenced, binds every effect, and never says prod or merges", async () => {
    const c = nick();

    // ── nothing can be skipped ──
    await expect(c.lifecycleRequestSmoke({ scope: "preview", bundleKey: KEY })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "the preview envs are not all up yet" });
    await expect(c.lifecycleDeployStg({ bundleKey: KEY })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "the latest preview smoke for this bundle has not passed" });
    await expect(c.lifecycleSignoff({ bundleKey: KEY })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "staging is not running this bundle" });
    expect(denials().map((a) => a.action)).toEqual(["nebula.lifecycle_request_smoke", "nebula.lifecycle_deploy_stg", "nebula.lifecycle_signoff"]);
    await expect(c.lifecycleCreatePreview({ bundleKey: OTHER_KEY })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/the bundle changed/) });

    // ── 1. create the preview ──
    const created = await twoStep(c.lifecycleCreatePreview, { bundleKey: KEY });
    expect(created.issued.summary).toContain(`Create the preview for bundle ${KEY.slice(0, 12)}: 2 named envs (0 of 6 in use now), ttl 72h`);
    expect(created.issued.summary).toContain(`- ${ENV_S} (backend twizz-sentinel) from ${SENTINEL}@${BRANCH}@${SHA_SENTINEL.slice(0, 7)} -> https://${ENV_S}.prv.twizz.com; db=none; 1 declared secret left unset (ANTHROPIC_API_KEY)`);
    expect(created.done).toMatchObject({ done: true, result: { ttlHours: 72, created: [{ name: ENV_B }, { name: ENV_S, expectedTag: TAG_S }] } });
    const createFields = fieldsOf(db.audits.at(-1)!);
    const { input } = await lifecyclePreviewState(prisma);
    // the bound set hash is the reader's own: one definition of "the exact (repo, sha) set"
    expect(createFields).toEqual({ bundleKey: KEY, setHash: bundleSetHash(db.snapshots[0].data.bundles!, input.services), envs: `${ENV_B} ${ENV_S}`, ttlHours: "72" });
    expect(parseManifest(gitops.files.get(`named-envs/pending/${ENV_S}.yaml`)!, { where: "pending" })).toMatchObject({ owner: "nick", source: { repo: SENTINEL, ref: BRANCH, sha: SHA_SENTINEL } });
    expect(dispatched.map((d) => [d.envName, d.sha])).toEqual([[ENV_B, SHA_BACKEND], [ENV_S, SHA_SENTINEL]]);

    // a replay is refused clearly (and so is a smoke while the builds run)
    await expect(c.lifecycleCreatePreview({ bundleKey: KEY })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "every bundled service already has a preview env for this bundle" });
    await expect(c.lifecycleRequestSmoke({ scope: "preview", bundleKey: KEY })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(dispatched).toHaveLength(2);

    // ── 2. preview smoke: targets are built here, whatever the caller sends ──
    promoteBuilds();
    const smokeArgs = { scope: "preview" as const, bundleKey: KEY, targets: [{ name: "x", baseUrl: "http://169.254.169.254" }], baseUrl: "https://evil.example.com" };
    const smoke = await twoStep(c.lifecycleRequestSmoke, smokeArgs);
    const targets = [{ name: "moly-backend", baseUrl: `https://${ENV_B}.prv.twizz.com` }, { name: "twizz-sentinel", baseUrl: `https://${ENV_S}.prv.twizz.com` }];
    expect(smoke.done).toMatchObject({ done: true, result: { scope: "preview", targets } });
    expect(db.requests.at(-1)).toMatchObject({ kind: "smoke", requestedBy: "nick", params: { scope: "preview", bundleKey: KEY, targets } });
    expect(fieldsOf(db.audits.at(-1)!)).toMatchObject({ scope: "preview", targets: `moly-backend=https://${ENV_B}.prv.twizz.com twizz-sentinel=https://${ENV_S}.prv.twizz.com` });
    await expect(c.lifecycleRequestSmoke({ scope: "preview", bundleKey: KEY })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "a preview smoke run is already in flight" });
    await expect(c.lifecycleDeployStg({ bundleKey: KEY })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    runSmoke();

    // ── 3. staging: a promotion PR with the preview's image; nothing merged ──
    await expect(c.lifecycleRequestSmoke({ scope: "stg", bundleKey: KEY })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "staging is not running this bundle yet" });
    const deploy = await twoStep(c.lifecycleDeployStg, { bundleKey: KEY });
    expect(deploy.issued.summary).toContain(`- twizz-sentinel: ${TAG_S} (the image preview env ${ENV_S} runs), replacing ${OLD_TAG} -> ${STAGING_VALUES}, https://sentinel-stg.prv.twizz.com`);
    expect(deploy.issued.summary).toContain(`- ${BACKEND}: no staging route in Nebula (deploys via the repo's own pipeline on merge)`);
    expect(deploy.done).toMatchObject({ done: true, result: { promotions: [{ service: "twizz-sentinel", imageTag: TAG_S, prNumber: 101, existing: false }], noRoute: [{ github: BACKEND }] } });
    expect(fieldsOf(db.audits.at(-1)!)).toMatchObject({ scope: "stg", bundleKey: KEY, promote: `twizz-sentinel:${TAG_S}` });
    expect(promos.prs.map((p) => p.branch)).toEqual([`promote/twizz-sentinel/staging/${TAG_S}`]);
    expect(promos.main.get(STAGING_VALUES)).toBe(VALUES(OLD_TAG));
    // replay: the PR is open, so there is nothing left to promote
    await expect(c.lifecycleDeployStg({ bundleKey: KEY })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "every promotable service is already promoted or deployed for this bundle" });
    // not deployed yet: no staging smoke, no sign-off
    await expect(c.lifecycleRequestSmoke({ scope: "stg", bundleKey: KEY })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(c.lifecycleSignoff({ bundleKey: KEY })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "staging is not running this bundle" });

    // ── 4. staging smoke, against the fixed staging host ──
    mergePromotionAndSync();
    await expect(c.lifecycleSignoff({ bundleKey: KEY })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "the latest staging smoke for this bundle has not passed" });
    const stg = await twoStep(c.lifecycleRequestSmoke, { scope: "stg" as const, bundleKey: KEY });
    expect(stg.done).toMatchObject({ done: true, result: { scope: "stg", targets: [{ name: "twizz-sentinel", baseUrl: "https://sentinel-stg.prv.twizz.com" }] } });
    runSmoke();

    // ── 5. the human gate ──
    const before = db.audits.length;
    const sign = await twoStep(callerFor("igor").lifecycleSignoff, { bundleKey: KEY });
    expect(sign.issued.summary).toContain(`Sign off bundle ${KEY.slice(0, 12)} as igor: 2 repositories, evidence = the staging smoke`);
    expect(sign.issued.summary).toContain(`comment on 2 pull requests: ${BACKEND}#7, ${SENTINEL}#7`);
    expect(sign.issued.summary).toContain("nothing is merged");
    expect(sign.done).toMatchObject({ done: true, result: { signedOffBy: "igor", scope: "stg", merged: false, comments: [{ repo: BACKEND, number: 7, status: "posted" }, { repo: SENTINEL, number: 7, status: "posted" }] } });
    expect(github.comments.map((x) => `${x.repo}#${x.pr}`)).toEqual([`${BACKEND}#7`, `${SENTINEL}#7`]);
    expect(github.comments[1].body).toContain(`Signed off in Nebula by igor for bundle ${KEY.slice(0, 12)}; preview + smoke evidence:`);
    expect(github.comments[1].body).toContain("- Staging smoke: PASS, 1 check");
    // the sign-off IS the gate's audit row, read back by the state machine
    expect(db.audits.slice(before)).toEqual([expect.objectContaining({ actor: "igor", action: "nebula.lifecycle_signoff", allowed: true, detail: expect.objectContaining({ result: expect.any(String) }) })]);
    expect(fieldsOf(db.audits.at(-1)!)).toMatchObject({ bundleKey: KEY, scope: "stg", prs: "2", evidenceHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const after = await lifecyclePreviewState(prisma, { fresh: true });
    expect(after.view).toMatchObject({ state: "signed-off", signoff: { by: "igor" } });

    // a second sign-off, and anything else on a signed-off bundle, is refused
    await expect(c.lifecycleSignoff({ bundleKey: KEY })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/already signed off \(by igor/) });
    await expect(c.lifecycleRequestSmoke({ scope: "stg", bundleKey: KEY })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "this bundle is already signed off" });
    expect(github.comments).toHaveLength(2);

    // ── across the whole run ──
    expect(promos.merged).toBe(0);
    expect(github.calls.filter((x) => !["git.getRef", "repos.getContent", "issues.listComments", "issues.createComment"].includes(x))).toEqual([]);
    // no gate field of any lifecycle tool ever carried a denied word; staging is `stg`
    for (const a of db.audits.filter((x) => x.action.startsWith("nebula.lifecycle_") && x.resource)) expect(a.resource, a.action).not.toMatch(/prod|staging/i);
    expect(db.audits.filter((x) => x.allowed && x.action.startsWith("nebula.lifecycle_")).map((x) => x.action)).toEqual([
      "nebula.lifecycle_create_preview",
      "nebula.lifecycle_request_smoke",
      "nebula.lifecycle_deploy_stg",
      "nebula.lifecycle_request_smoke",
      "nebula.lifecycle_signoff",
    ]);
  });
});

describe("the action re-plans inside the gate", () => {
  it("create: a branch that moves after the nonce was checked is refused by the action itself, and nothing is created", async () => {
    const issued = (await nick().lifecycleCreatePreview({ bundleKey: KEY })) as Gated;
    // heads are read twice per plan (two bundles): let the pre-gate plan of the confirm call pass, move them for the action's own plan
    github.moveHeadsFromRead = github.headReads + 3;
    const r = (await nick().lifecycleCreatePreview({ bundleKey: KEY, confirm: issued.confirm })) as Gated;
    expect(r.error).toMatch(/moved since the snapshot/);
    expect(gitops.commits).toBe(0);
    expect(dispatched).toEqual([]);
    expect([...secrets.keys()]).toEqual(["preview/moly-backend"]);
    // audited as a run that failed, never as a success
    expect(db.audits.at(-1)).toMatchObject({ action: "nebula.lifecycle_create_preview", allowed: true, detail: { error: expect.stringMatching(/moved since the snapshot/) } });
  });

  it("create: a head that moved before the confirm is refused before the gate, and audited", async () => {
    const issued = (await nick().lifecycleCreatePreview({ bundleKey: KEY })) as Gated;
    github.heads.set(`${SENTINEL}#${BRANCH}`, "9".repeat(40));
    await expect(nick().lifecycleCreatePreview({ bundleKey: KEY, confirm: issued.confirm })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/moved since the snapshot \(a1a1a1a -> 9999999\)/) });
    expect(denials().at(-1)).toMatchObject({ action: "nebula.lifecycle_create_preview", detail: { reason: expect.stringMatching(/moved/) } });
    expect(gitops.commits).toBe(0);
  });

  it("create: the nonce is bound to the envs it would create — a different set needs a new confirmation", async () => {
    const issued = (await nick().lifecycleCreatePreview({ bundleKey: KEY })) as Gated;
    // someone created the sentinel env for this bundle in the meantime
    gitops.files.set(
      `named-envs/pending/${ENV_S}.yaml`,
      manifestToYaml({ name: ENV_S, kind: "backend", service: "twizz-sentinel", owner: "igor", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), db: { mode: "none", generation: 0 }, frontendOrigins: [], source: { repo: SENTINEL, ref: BRANCH, sha: SHA_SENTINEL }, build: { status: "PENDING", expectedTag: TAG_S, startedAt: new Date().toISOString() } }),
    );
    const r = (await nick().lifecycleCreatePreview({ bundleKey: KEY, confirm: issued.confirm })) as Gated;
    expect(r).toMatchObject({ denied: true, reason: "confirm token was issued for different arguments" });
    expect(dispatched).toEqual([]);
  });

  it("create: all or nothing against the cap — refused before the gate with nothing written", async () => {
    for (const n of ["a", "b", "c", "d", "e"]) gitops.files.set(`named-envs/other-${n}.yaml`, "x");
    await expect(nick().lifecycleCreatePreview({ bundleKey: KEY })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/named-env cap: this preview needs 2 envs but only 1 of 6 are free/) });
    expect(gitops.commits).toBe(0);
    expect(dispatched).toEqual([]);
    expect(denials().at(-1)).toMatchObject({ action: "nebula.lifecycle_create_preview", detail: { reason: expect.stringMatching(/nothing was created/) } });
  });

  it("deploy: refused when the preview was rebuilt after its smoke passed", async () => {
    const c = nick();
    await twoStep(c.lifecycleCreatePreview, { bundleKey: KEY });
    promoteBuilds();
    await twoStep(c.lifecycleRequestSmoke, { scope: "preview" as const, bundleKey: KEY });
    runSmoke();
    // rebuilt a minute from now: later than the smoke request
    const m = parseManifest(gitops.files.get(`named-envs/${ENV_S}.yaml`)!);
    gitops.files.set(`named-envs/${ENV_S}.yaml`, manifestToYaml({ ...m, build: { ...m.build!, finishedAt: new Date(Date.now() + 60_000).toISOString() } }));
    await expect(c.lifecycleDeployStg({ bundleKey: KEY })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/plo-2611-twizz-sentinel was \(re\)built at .* after the preview smoke was requested/) });
    expect(promos.prs).toEqual([]);
    expect(denials().at(-1)).toMatchObject({ action: "nebula.lifecycle_deploy_stg" });
  });

  it("deploy: a failed preview smoke, or one for another bundle, never opens a promotion", async () => {
    const c = nick();
    await twoStep(c.lifecycleCreatePreview, { bundleKey: KEY });
    promoteBuilds();
    await twoStep(c.lifecycleRequestSmoke, { scope: "preview" as const, bundleKey: KEY });
    runSmoke({ ok: false });
    await expect(c.lifecycleDeployStg({ bundleKey: KEY })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "the latest preview smoke for this bundle has not passed" });
    // a pass recorded for a DIFFERENT bundle key proves nothing about this one
    const other = { id: "req-other", kind: "smoke", params: { scope: "preview", bundleKey: OTHER_KEY, targets: [{ name: "twizz-sentinel", baseUrl: `https://${ENV_S}.prv.twizz.com` }] }, requestedBy: "nick", status: "done", createdAt: new Date(), claimedAt: new Date(), finishedAt: new Date(), runId: "smoke-other", error: null };
    db.requests.push(other);
    db.snapshots.push(snap("smoke", new Date(), { runId: "smoke-other", requestId: other.id, smoke: { scope: "preview", bundleKey: OTHER_KEY, results: [{ name: "twizz-sentinel/health", url: `https://${ENV_S}.prv.twizz.com/health`, ok: true, status: 200, ms: 1, detail: "ok" }] } }));
    await expect(c.lifecycleDeployStg({ bundleKey: KEY })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(promos.prs).toEqual([]);
  });

  it("sign-off: refused when a bundle branch moved after it was tested, and no comment is posted", async () => {
    const c = nick();
    await twoStep(c.lifecycleCreatePreview, { bundleKey: KEY });
    promoteBuilds();
    await twoStep(c.lifecycleRequestSmoke, { scope: "preview" as const, bundleKey: KEY });
    runSmoke();
    await twoStep(c.lifecycleDeployStg, { bundleKey: KEY });
    mergePromotionAndSync();
    await twoStep(c.lifecycleRequestSmoke, { scope: "stg" as const, bundleKey: KEY });
    runSmoke();
    const issued = (await c.lifecycleSignoff({ bundleKey: KEY })) as Gated;
    expect(issued).toMatchObject({ confirmationRequired: true });
    // moves between the confirm call's own pre-gate plan and the action's plan
    github.moveHeadsFromRead = github.headReads + 3;
    const r = (await c.lifecycleSignoff({ bundleKey: KEY, confirm: issued.confirm })) as Gated;
    expect(r.error).toMatch(/moved since the snapshot/);
    expect(github.comments).toEqual([]);
    // an errored run is not a sign-off
    expect((await lifecyclePreviewState(prisma, { fresh: true })).view.state).toBe("awaiting-signoff");
    github.moveHeadsFromRead = 0;
    github.heads.set(`${BACKEND}#${BRANCH}`, "8".repeat(40));
    await expect(c.lifecycleSignoff({ bundleKey: KEY })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/Moly-backend: plo\/bundle\/2026-11 moved since the snapshot/) });
    expect(github.comments).toEqual([]);
  });

  it("sign-off: a preview-only bundle is signed off on its preview smoke", async () => {
    db.snapshots = [snap("source", minutesAgo(24 * 60), { runId: "source-nov", bundleKey: KEY, bundles: [bundle(BACKEND, SHA_BACKEND)] })];
    const c = nick();
    await expect(c.lifecycleDeployStg({ bundleKey: KEY })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/no bundled service is on the release train: no staging route in Nebula/) });
    await twoStep(c.lifecycleCreatePreview, { bundleKey: KEY });
    promoteBuilds();
    await expect(c.lifecycleSignoff({ bundleKey: KEY })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "the latest preview smoke for this bundle has not passed" });
    await twoStep(c.lifecycleRequestSmoke, { scope: "preview" as const, bundleKey: KEY });
    runSmoke();
    const sign = await twoStep(c.lifecycleSignoff, { bundleKey: KEY });
    expect(sign.done).toMatchObject({ done: true, result: { scope: "preview", merged: false, comments: [{ repo: BACKEND, number: 7, status: "posted" }] } });
    expect(fieldsOf(db.audits.at(-1)!)).toMatchObject({ scope: "preview" });
  });
});
