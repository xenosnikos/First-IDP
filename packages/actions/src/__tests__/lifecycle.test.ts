import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LIFECYCLE_NO_STAGING_ROUTE,
  LIFECYCLE_PREVIEW_TTL_HOURS,
  LifecycleRefusal,
  createLifecyclePreview,
  deployLifecycleStg,
  deployPromoteField,
  lifecycleSetHash,
  planDeployStg,
  planPreview,
  planRequestRun,
  planSignoff,
  planSmoke,
  previewEnvsField,
  requestLifecycleRun,
  requestLifecycleSmoke,
  signoffCommentBody,
  signoffLifecycle,
  signoffMarker,
  smokeGap,
  smokeTargetsField,
  type LifecycleBundleState,
  type LifecycleDeps,
  type LifecycleSmokeEvidence,
  type LifecycleState,
} from "../lifecycle";
import { manifestToYaml, nebulaTag, parseManifest, type ImageInfo, type NamedEnvManifest } from "../named-envs";
import { evaluatePolicy as evaluate, loadPolicyFile, type Policy } from "../policy";
import { releaseTarget } from "../registry";
import { FakeBuilds, FakeEcr, FakeGitops, FakeLifecycleQueue, FakeLifecycleRepos, FakePromotions, FakeSecrets } from "./fakes";

// The five Lifecycle writes against fake ports and the REAL policy.yaml. Every
// refusal path is exercised at the action (the function the gate runs), not at
// the page: a refused call must have written nothing.

const policy = loadPolicyFile(join(__dirname, "..", "..", "..", "..", "apps", "mcp", "policy.yaml"));

const NOW = new Date("2026-11-25T12:00:00.000Z");
const KEY = "0a1b2c3d".repeat(8);
const OTHER_KEY = "f".repeat(64);
const BRANCH = "plo/bundle/2026-11";
const SENTINEL = "twizz-app/twizz-sentinel";
const BACKEND = "twizz-app/Moly-backend";
const ADMIN = "twizz-app/front-admin";
const SHA_S = "a1".repeat(20);
const SHA_B = "b2".repeat(20);
const SHA_A = "c3".repeat(20);
const ENV_S = "plo-2611-twizz-sentinel";
const ENV_B = "plo-2611-moly-backend";
const ENV_A = "plo-2611-twizz-admin";
const TAG_S = nebulaTag(ENV_S, SHA_S);
const TAG_A = nebulaTag(ENV_A, SHA_A);
const origin = (env: string) => `https://${env}.prv.twizz.com`;
const STG_S = "https://sentinel-stg.prv.twizz.com";
const STG_A = "https://admin-stg.prv.twizz.com";

const BACKEND_YAML = ["version: 2", "kind: backend", "port: 8090", "healthPath: /health", "secrets:", "  - ANTHROPIC_API_KEY", "needs:", "  mongo: true", ""].join("\n");
const LEGACY_YAML = ["version: 2", "kind: backend", "port: 3000", "healthPath: /health", ""].join("\n");
const FRONTEND_YAML = (attach = true) =>
  ["version: 2", "kind: frontend", "port: 3000", "healthPath: /", "build:", "  args:", '    NEXT_PUBLIC_API_URL: "${NEBULA_API_URL}"', "frontend:", "  framework: next", "  apiEnvVar: NEXT_PUBLIC_API_URL", "  serve: next-standalone", ...(attach ? ["attach:", "  backendService: twizz-sentinel"] : []), ""].join("\n");
const VALUES = (svc: string) => `nameOverride: ${svc}\n\nimage:\n  repository: 848281935985.dkr.ecr.eu-west-1.amazonaws.com/${svc}\n  tag: main-0000000000000000000000000000000000000000 # promoted by Nebula\n`;

const yes = { allowed: true } as const;
const no = (reason: string) => ({ allowed: false as const, reason });

function bundle(github: string, sha: string | null, service: string | null, over: Partial<LifecycleBundleState> = {}): LifecycleBundleState {
  const promotable = !!service && !!releaseTarget(service, "staging");
  return {
    github,
    branch: BRANCH,
    headSha: sha,
    included: [{ repo: github, number: 7, url: `https://github.com/${github}/pull/7` }],
    service,
    promotable,
    previewable: !!service && !!sha,
    note: service ? null : "not a Nebula registry service: no preview route in Nebula",
    envName: service ? `plo-2611-${service}` : null,
    env: null,
    staging: promotable ? { deployed: false, promotion: null } : null,
    ...over,
  };
}

const noSmoke: LifecycleSmokeEvidence = { verdict: "none", detail: "not requested yet", request: null, runId: null, finishedAt: null, results: [], targets: [] };
function passed(scope: "preview" | "stg", targets: Array<{ name: string; baseUrl: string }>, over: Partial<LifecycleSmokeEvidence> = {}): LifecycleSmokeEvidence {
  return {
    verdict: "pass",
    detail: `${targets.length} of ${targets.length} checks passed`,
    request: { id: `req-${scope}`, createdAt: "2026-11-25T11:00:00.000Z" },
    runId: `smoke-${scope}-1`,
    finishedAt: "2026-11-25T11:05:00.000Z",
    results: targets.map((t) => ({ name: `${t.name}/health`, url: `${t.baseUrl}/health`, ok: true })),
    targets,
    ...over,
  };
}

function world(bundles: LifecycleBundleState[] = [bundle(SENTINEL, SHA_S, "twizz-sentinel"), bundle(BACKEND, SHA_B, "moly-backend")], opts: { policy?: Policy } = {}) {
  const gitops = new FakeGitops();
  const secrets = new FakeSecrets();
  secrets.store.set("preview/_defaults", { MONGO_URI: "mongodb+srv://u:p@nonprod.mongodb.net/?retryWrites=true" });
  const imageTable: Record<string, ImageInfo[]> = { "twizz-sentinel": [{ tags: [TAG_S], pushedAt: NOW, digest: "sha256:s" }], "twizz-admin": [{ tags: [TAG_A], pushedAt: NOW, digest: "sha256:a" }] };
  const images = new FakeEcr(imageTable);
  const builds = new FakeBuilds();
  const promotions = new FakePromotions();
  promotions.main.set("apps/twizz-sentinel/values-staging.yaml", VALUES("twizz-sentinel"));
  promotions.main.set("apps/twizz-admin/values-staging.yaml", VALUES("twizz-admin"));
  const repos = new FakeLifecycleRepos();
  const queue = new FakeLifecycleQueue();
  const w = {
    gitops,
    secrets,
    imageTable,
    builds,
    promotions,
    repos,
    queue,
    state: {
      bundleKey: KEY,
      bundles,
      smoke: { preview: noSmoke, stg: noSmoke },
      signoff: null,
      actions: { createPreview: yes, smokePreview: yes, deployStg: yes, smokeStg: yes, signoff: yes },
    } as LifecycleState,
    stateReads: 0,
    deps: undefined as unknown as LifecycleDeps,
  };
  w.deps = {
    gitops,
    secrets,
    images,
    builds,
    promotions,
    repos,
    queue,
    policy: opts.policy ?? policy,
    now: () => NOW,
    state: async () => {
      w.stateReads += 1;
      return w.state;
    },
    stagingApiUrl: null,
  };
  for (const b of bundles) if (b.headSha) repos.heads.set(`${b.github}#${b.branch}`, b.headSha);
  const file = (repo: string, sha: string, path: string, content: string) => repos.files.set(`${repo}@${sha}:${path}`, content);
  file(SENTINEL, SHA_S, "twizz.yaml", BACKEND_YAML);
  file(SENTINEL, SHA_S, "Dockerfile", "FROM node:22-alpine\n");
  file(BACKEND, SHA_B, "twizz.yaml", LEGACY_YAML);
  file(BACKEND, SHA_B, "Dockerfile", "FROM node:22-alpine\n");
  file(ADMIN, SHA_A, "twizz.yaml", FRONTEND_YAML());
  file(ADMIN, SHA_A, "Dockerfile", "FROM node:22-alpine\n");
  return w;
}
type World = ReturnType<typeof world>;

/** a deployable named env built by the central builder from a bundle head */
function deployed(w: World, name: string, repo: string, sha: string, service: string, over: Partial<NamedEnvManifest> = {}, where: "deployable" | "pending" = "deployable") {
  const m: NamedEnvManifest = {
    name,
    kind: "backend",
    service,
    owner: "nick",
    imageTag: nebulaTag(name, sha),
    expiresAt: "2026-11-28T10:00:00.000Z",
    db: { mode: "none", generation: 0 },
    frontendOrigins: [],
    source: { repo, ref: BRANCH, sha },
    build: { status: "PASS", expectedTag: nebulaTag(name, sha), startedAt: "2026-11-25T10:00:00.000Z", finishedAt: "2026-11-25T10:10:00.000Z" },
    config: { port: 8080, healthPath: "/health", rev: 1, envVarNames: [] },
    ...over,
  };
  w.gitops.files.set(`${where === "pending" ? "named-envs/pending" : "named-envs"}/${name}.yaml`, manifestToYaml(m));
  const b = w.state.bundles.find((x) => x.github === repo);
  if (b) b.env = { name, up: where === "deployable" };
}

/** both previews up and smoked: the state a deploy to staging starts from */
function smokedPreview(bundles?: LifecycleBundleState[]) {
  const w = world(bundles);
  const targets: Array<{ name: string; baseUrl: string }> = [];
  for (const b of w.state.bundles) {
    if (!b.previewable) continue;
    deployed(w, b.envName!, b.github, b.headSha!, b.service!);
    targets.push({ name: b.service!, baseUrl: origin(b.envName!) });
  }
  w.state.smoke.preview = passed("preview", targets);
  return w;
}

const refusal = (re: RegExp) => expect.objectContaining({ name: "LifecycleRefusal", message: expect.stringMatching(re) });
const wrote = (w: World) => ({ git: w.gitops.commits.length, secrets: [...w.secrets.store.keys()].filter((k) => k.includes("/plo-")), builds: w.builds.dispatched.length, prs: w.promotions.prs.length, comments: w.repos.comments.length, queued: w.queue.rows.length });
const NOTHING = { git: 0, secrets: [], builds: 0, prs: 0, comments: 0, queued: 0 };

describe("lifecycleSetHash", () => {
  it("is sha256 over the sorted, lower-cased owner/name@sha lines", () => {
    const expected = createHash("sha256").update([`twizz-app/moly-backend@${SHA_B}`, `twizz-app/twizz-sentinel@${SHA_S}`].join("\n"), "utf8").digest("hex");
    expect(lifecycleSetHash([{ repo: SENTINEL, sha: SHA_S }, { repo: BACKEND, sha: SHA_B }])).toBe(expected);
    expect(lifecycleSetHash([{ repo: "TWIZZ-APP/moly-BACKEND", sha: SHA_B }, { repo: SENTINEL, sha: SHA_S }])).toBe(expected);
    expect(lifecycleSetHash([{ repo: SENTINEL, sha: SHA_A }, { repo: BACKEND, sha: SHA_B }])).not.toBe(expected);
    expect(lifecycleSetHash([{ repo: SENTINEL, sha: SHA_S }])).not.toBe(expected);
  });
});

describe("policy.yaml — lifecycle tools", () => {
  const evaluatePolicy = (tool: string, f: Record<string, string>) => evaluate(policy, tool, f);
  const H = "a".repeat(64);
  it("has an entry for each of the five tools and no field exempt from the global deny", () => {
    for (const tool of ["lifecycle_request_run", "lifecycle_create_preview", "lifecycle_request_smoke", "lifecycle_deploy_stg", "lifecycle_signoff"]) {
      expect(policy.write_tools?.[tool], tool).toBeDefined();
      expect(policy.write_tools?.[tool]?.exempt_global_deny, tool).toBeUndefined();
    }
  });
  it("allows exactly the shapes the router sends", () => {
    expect(evaluatePolicy("lifecycle_request_run", { kind: "plan" })).toEqual({ allowed: true });
    expect(evaluatePolicy("lifecycle_request_run", { kind: "cve" })).toEqual({ allowed: true });
    expect(evaluatePolicy("lifecycle_create_preview", { bundleKey: KEY, setHash: H, envs: `${ENV_B} ${ENV_S}`, ttlHours: "72" })).toEqual({ allowed: true });
    expect(evaluatePolicy("lifecycle_request_smoke", { scope: "stg", bundleKey: KEY, setHash: H, targets: `twizz-sentinel=${STG_S}` })).toEqual({ allowed: true });
    expect(evaluatePolicy("lifecycle_deploy_stg", { scope: "stg", bundleKey: KEY, setHash: H, promote: `twizz-sentinel:${TAG_S}` })).toEqual({ allowed: true });
    expect(evaluatePolicy("lifecycle_signoff", { bundleKey: KEY, setHash: H, scope: "stg", evidenceHash: H, prs: "3" })).toEqual({ allowed: true });
  });
  it("refuses anything else: other kinds, the word staging as a scope, prod-shaped values, a missing binding", () => {
    const denied = (tool: string, f: Record<string, string>) => expect(evaluatePolicy(tool, f).allowed, JSON.stringify(f)).toBe(false);
    denied("lifecycle_request_run", { kind: "smoke" });
    denied("lifecycle_request_run", { kind: "source" });
    denied("lifecycle_create_preview", { bundleKey: KEY, setHash: H, envs: "my-env", ttlHours: "72" });
    denied("lifecycle_create_preview", { bundleKey: KEY, setHash: H, envs: ENV_S, ttlHours: "336" });
    denied("lifecycle_create_preview", { bundleKey: KEY, setHash: H, envs: "plo-2611-prod-api", ttlHours: "72" });
    denied("lifecycle_create_preview", { bundleKey: KEY, envs: ENV_S, ttlHours: "72" });
    denied("lifecycle_request_smoke", { scope: "staging", bundleKey: KEY, setHash: H, targets: `x=${STG_S}` });
    denied("lifecycle_request_smoke", { scope: "production", bundleKey: KEY, setHash: H, targets: `x=${STG_S}` });
    denied("lifecycle_request_smoke", { scope: "stg", bundleKey: KEY, setHash: H, targets: "x=https://api.twizz.com" });
    denied("lifecycle_request_smoke", { scope: "stg", bundleKey: KEY, setHash: H, targets: "x=https://prod-api.prv.twizz.com" });
    denied("lifecycle_deploy_stg", { scope: "preview", bundleKey: KEY, setHash: H, promote: `twizz-sentinel:${TAG_S}` });
    denied("lifecycle_deploy_stg", { scope: "stg", bundleKey: KEY, setHash: H, promote: "twizz-sentinel:main" });
    denied("lifecycle_deploy_stg", { scope: "prod", bundleKey: KEY, setHash: H, promote: `twizz-sentinel:${TAG_S}` });
    denied("lifecycle_signoff", { bundleKey: KEY, setHash: H, scope: "production", evidenceHash: H, prs: "1" });
    denied("lifecycle_signoff", { bundleKey: KEY, setHash: H, scope: "stg", prs: "1" });
  });
});

describe("lifecycle_request_run", () => {
  it("queues one plan or cve request", async () => {
    const w = world();
    expect(await requestLifecycleRun(w.deps, { kind: "plan", actor: "nick" })).toMatchObject({ requestId: "req-1", kind: "plan", status: "pending" });
    expect(await requestLifecycleRun(w.deps, { kind: "cve", actor: "igor" })).toMatchObject({ requestId: "req-2", kind: "cve" });
    expect(w.queue.rows.map((r) => [r.kind, r.params, r.requestedBy])).toEqual([["plan", {}, "nick"], ["cve", {}, "igor"]]);
  });

  it("refuses while an identical kind is pending or claimed — at plan time and at the insert", async () => {
    const w = world();
    await requestLifecycleRun(w.deps, { kind: "plan", actor: "nick" });
    await expect(planRequestRun(w.deps, { kind: "plan" })).rejects.toEqual(refusal(/a plan run is already pending \(requested by nick/));
    await expect(requestLifecycleRun(w.deps, { kind: "plan", actor: "igor" })).rejects.toEqual(refusal(/already pending/));
    w.queue.rows[0].status = "claimed";
    await expect(requestLifecycleRun(w.deps, { kind: "plan", actor: "igor" })).rejects.toEqual(refusal(/already claimed/));
    // the race the peek cannot see: the insert itself refuses
    const racing = { queue: { findActive: async () => null, enqueue: w.queue.enqueue.bind(w.queue) } };
    await expect(requestLifecycleRun(racing, { kind: "plan", actor: "igor" })).rejects.toEqual(refusal(/already claimed/));
    expect(w.queue.rows).toHaveLength(1);
    // a finished one no longer blocks
    w.queue.rows[0].status = "done";
    await expect(requestLifecycleRun(w.deps, { kind: "plan", actor: "igor" })).resolves.toMatchObject({ kind: "plan" });
  });

  it("refuses any other kind", async () => {
    const w = world();
    await expect(requestLifecycleRun(w.deps, { kind: "smoke" as never, actor: "nick" })).rejects.toEqual(refusal(/only plan and cve/));
    await expect(requestLifecycleRun(w.deps, { kind: "source" as never, actor: "nick" })).rejects.toBeInstanceOf(LifecycleRefusal);
    expect(w.queue.rows).toEqual([]);
  });
});

describe("lifecycle_create_preview", () => {
  const create = async (w: World, actor = "nick") => {
    const plan = await planPreview(w.deps, { bundleKey: KEY });
    return createLifecyclePreview(w.deps, { bundleKey: KEY, setHash: plan.setHash, envs: previewEnvsField(plan), actor });
  };

  it("plans one env per bundled registry service, pinned to the bundle head, and skips what Nebula cannot preview", async () => {
    const w = world([bundle(SENTINEL, SHA_S, "twizz-sentinel"), bundle(BACKEND, SHA_B, "moly-backend"), bundle("twizz-app/lolygram-discover", SHA_A, null), bundle("twizz-app/front-business", null, "business", { previewable: false, note: "nothing could be bundled for this repository" })]);
    const plan = await planPreview(w.deps, { bundleKey: KEY });
    expect(plan.create.map((c) => [c.envName, c.repo, c.branch, c.sha, c.service, c.kind, c.db])).toEqual([
      [ENV_B, BACKEND, BRANCH, SHA_B, "moly-backend", "backend", "isolated"],
      [ENV_S, SENTINEL, BRANCH, SHA_S, "twizz-sentinel", "backend", "isolated"],
    ]);
    expect(plan.create[1]).toMatchObject({ secretNames: ["ANTHROPIC_API_KEY"], expectedTag: TAG_S, url: origin(ENV_S) });
    expect(plan.skipped).toEqual([{ github: "twizz-app/lolygram-discover", reason: "not a Nebula registry service: no preview route in Nebula" }]);
    expect(plan.setHash).toBe(lifecycleSetHash([{ repo: SENTINEL, sha: SHA_S }, { repo: BACKEND, sha: SHA_B }]));
    expect(previewEnvsField(plan)).toBe(`${ENV_B} ${ENV_S}`);
    expect(plan.cap).toEqual({ live: 0, max: 6 });
    expect(wrote(w)).toEqual(NOTHING);
  });

  it("creates every env through createEnvFromRepo: secret, one commit, pending manifest from the bundle branch at its head, ttl 72 h, build dispatched", async () => {
    const w = world();
    const r = await create(w, "igor");
    expect(r).toMatchObject({ bundleKey: KEY, key12: KEY.slice(0, 12), ttlHours: 72, existing: [], skipped: [] });
    expect(r.created).toEqual([
      { name: ENV_B, url: origin(ENV_B), service: "moly-backend", kind: "backend", expectedTag: nebulaTag(ENV_B, SHA_B), unsetSecrets: [] },
      { name: ENV_S, url: origin(ENV_S), service: "twizz-sentinel", kind: "backend", expectedTag: TAG_S, unsetSecrets: ["ANTHROPIC_API_KEY"] },
    ]);
    const m = parseManifest(w.gitops.files.get(`named-envs/pending/${ENV_S}.yaml`)!, { where: "pending" });
    expect(m).toMatchObject({ name: ENV_S, service: "twizz-sentinel", owner: "igor", source: { repo: SENTINEL, ref: BRANCH, sha: SHA_S }, build: { status: "PENDING", expectedTag: TAG_S }, expiresAt: new Date(NOW.getTime() + LIFECYCLE_PREVIEW_TTL_HOURS * 3_600_000).toISOString() });
    expect(parseManifest(w.gitops.files.get(`named-envs/pending/${ENV_B}.yaml`)!, { where: "pending" })).toMatchObject({ service: "moly-backend", source: { repo: BACKEND, sha: SHA_B }, db: { mode: "isolated" } });
    expect(w.gitops.atomic).toHaveLength(2);
    expect([...w.secrets.store.keys()].filter((k) => k.includes("/plo-")).sort()).toEqual([`preview/moly-backend/${ENV_B}`, `preview/twizz-sentinel/${ENV_S}`]);
    expect(w.builds.dispatched.map((d) => [d.envName, d.repo, d.ref, d.sha, d.service])).toEqual([
      [ENV_B, "Moly-backend", BRANCH, SHA_B, "moly-backend"],
      [ENV_S, "twizz-sentinel", BRANCH, SHA_S, "twizz-sentinel"],
    ]);
    // the action re-read the state inside itself: once to plan here, once in the action
    expect(w.stateReads).toBe(2);
  });

  it("is refused clearly on a replay: every service already has its env", async () => {
    const w = world();
    await create(w);
    const before = wrote(w);
    for (const b of w.state.bundles) b.env = { name: b.envName!, up: false };
    await expect(planPreview(w.deps, { bundleKey: KEY })).rejects.toEqual(refusal(/every bundled service already has a preview env for this bundle/));
    await expect(createLifecyclePreview(w.deps, { bundleKey: KEY, setHash: "x".repeat(64), envs: `${ENV_B} ${ENV_S}`, actor: "nick" })).rejects.toEqual(refusal(/already has a preview env/));
    expect(wrote(w)).toEqual(before);
  });

  it("creates only what is missing and keeps the env that exists for this bundle", async () => {
    const w = world();
    deployed(w, ENV_S, SENTINEL, SHA_S, "twizz-sentinel");
    const plan = await planPreview(w.deps, { bundleKey: KEY });
    expect(plan.create.map((c) => c.envName)).toEqual([ENV_B]);
    expect(plan.existing).toEqual([{ envName: ENV_S, service: "twizz-sentinel" }]);
    expect(plan.cap.live).toBe(1);
    const r = await createLifecyclePreview(w.deps, { bundleKey: KEY, setHash: plan.setHash, envs: previewEnvsField(plan), actor: "nick" });
    expect(r.created.map((c) => c.name)).toEqual([ENV_B]);
    expect(w.builds.dispatched.map((d) => d.envName)).toEqual([ENV_B]);
  });

  it("refuses a bundle that is not the one Nebula has, a malformed key and no bundle at all", async () => {
    const w = world();
    await expect(planPreview(w.deps, { bundleKey: OTHER_KEY })).rejects.toEqual(refusal(/the bundle changed: Nebula now has bundle 0a1b2c3d0a1b, not ffffffffffff/));
    await expect(planPreview(w.deps, { bundleKey: "not-a-key" })).rejects.toEqual(refusal(/sha256 hex/));
    w.state.bundleKey = null;
    await expect(planPreview(w.deps, { bundleKey: KEY })).rejects.toEqual(refusal(/there is no bundle/));
    expect(wrote(w)).toEqual(NOTHING);
  });

  it("refuses when the state machine does not allow it (signed off, manifests unreadable, …)", async () => {
    const w = world();
    w.state.actions.createPreview = no("the named-env manifests could not be read");
    await expect(create(w)).rejects.toEqual(refusal(/named-env manifests could not be read/));
    expect(wrote(w)).toEqual(NOTHING);
  });

  it("refuses when a bundle branch moved or vanished since the snapshot — also for a repo whose env already exists", async () => {
    const w = world();
    w.repos.heads.set(`${SENTINEL}#${BRANCH}`, "9".repeat(40));
    await expect(create(w)).rejects.toEqual(refusal(/twizz-app\/twizz-sentinel: plo\/bundle\/2026-11 moved since the snapshot \(a1a1a1a -> 9999999\)/));
    w.repos.heads.delete(`${SENTINEL}#${BRANCH}`);
    await expect(create(w)).rejects.toEqual(refusal(/branch plo\/bundle\/2026-11 no longer exists/));
    const w2 = world();
    deployed(w2, ENV_S, SENTINEL, SHA_S, "twizz-sentinel");
    w2.repos.heads.set(`${SENTINEL}#${BRANCH}`, "9".repeat(40));
    await expect(create(w2)).rejects.toEqual(refusal(/moved since the snapshot/));
    expect(wrote(w)).toEqual(NOTHING);
    expect(w2.builds.dispatched).toEqual([]);
  });

  it("refuses a head that moved between review and confirm", async () => {
    const w = world();
    const plan = await planPreview(w.deps, { bundleKey: KEY });
    w.repos.heads.set(`${BACKEND}#${BRANCH}`, "8".repeat(40));
    await expect(createLifecyclePreview(w.deps, { bundleKey: KEY, setHash: plan.setHash, envs: previewEnvsField(plan), actor: "nick" })).rejects.toEqual(refusal(/moved since the snapshot/));
    expect(wrote(w)).toEqual(NOTHING);
  });

  it("refuses a confirm whose bound set or env list is not what the plan is now", async () => {
    const w = world();
    const plan = await planPreview(w.deps, { bundleKey: KEY });
    await expect(createLifecyclePreview(w.deps, { bundleKey: KEY, setHash: "0".repeat(64), envs: previewEnvsField(plan), actor: "nick" })).rejects.toEqual(refusal(/changed since you reviewed/));
    await expect(createLifecyclePreview(w.deps, { bundleKey: KEY, setHash: plan.setHash, envs: ENV_S, actor: "nick" })).rejects.toEqual(refusal(/changed since you reviewed/));
    expect(wrote(w)).toEqual(NOTHING);
  });

  it("is all or nothing against the env cap: refused up front, nothing created", async () => {
    const w = world();
    for (const n of ["a1", "a2", "a3", "a4", "a5"]) w.gitops.files.set(`named-envs/env-${n}.yaml`, "x");
    await expect(create(w)).rejects.toEqual(refusal(/named-env cap: this preview needs 2 envs but only 1 of 6 are free \(5 live\).*nothing was created/));
    expect(w.builds.dispatched).toEqual([]);
    expect([...w.secrets.store.keys()].filter((k) => k.includes("/plo-"))).toEqual([]);
    // the override is honoured
    await expect(planPreview({ ...w.deps, maxNamedEnvs: 7 }, { bundleKey: KEY })).resolves.toMatchObject({ cap: { live: 5, max: 7 } });
  });

  it("refuses when an env of that name already exists from another commit (an earlier bundle of the month)", async () => {
    const w = world();
    deployed(w, ENV_S, SENTINEL, "7".repeat(40), "twizz-sentinel");
    w.state.bundles[0].env = null; // the state machine does not count it: wrong commit
    await expect(create(w)).rejects.toEqual(refusal(/env "plo-2611-twizz-sentinel" already exists from twizz-app\/twizz-sentinel@7777777.*tear it down/));
    expect(w.builds.dispatched).toEqual([]);
  });

  it("refuses a repository without a valid twizz.yaml or without its Dockerfile", async () => {
    const w = world();
    w.repos.files.delete(`${SENTINEL}@${SHA_S}:twizz.yaml`);
    await expect(create(w)).rejects.toEqual(refusal(/twizz-app\/twizz-sentinel@a1a1a1a has no twizz\.yaml/));
    w.repos.files.set(`${SENTINEL}@${SHA_S}:twizz.yaml`, "version: 2\nkind: backend\n");
    await expect(create(w)).rejects.toEqual(refusal(/twizz\.yaml is invalid/));
    w.repos.files.set(`${SENTINEL}@${SHA_S}:twizz.yaml`, BACKEND_YAML.replace("port: 8090", "port: 8090\ndockerfile: docker/Dockerfile.api\ncontext: services/api"));
    await expect(create(w)).rejects.toEqual(refusal(/has no services\/api\/docker\/Dockerfile\.api/));
    expect(wrote(w)).toEqual(NOTHING);
  });

  it("refuses a repository outside the org, a malformed head and a registry mapping that changed", async () => {
    await expect(create(world([bundle("xenosnikos/twizz-support", SHA_S, "twizz-support")]))).rejects.toEqual(refusal(/not a twizz-app repository/));
    await expect(create(world([bundle(SENTINEL, "abc123", "twizz-sentinel")]))).rejects.toEqual(refusal(/malformed/));
    await expect(create(world([bundle(SENTINEL, SHA_S, "twizz-sentinel", { branch: "plo/../main" })]))).rejects.toEqual(refusal(/malformed/));
    await expect(create(world([bundle(SENTINEL, SHA_S, "moly-backend")]))).rejects.toEqual(refusal(/resolves to service twizz-sentinel, not moly-backend/));
    await expect(create(world([bundle(SENTINEL, SHA_S, "twizz-sentinel", { envName: "sentinel-mine" })]))).rejects.toEqual(refusal(/not a valid preview env name/));
  });

  it("evaluates the create_env_from_repo policy entry for every env: a prod-shaped name is refused", async () => {
    const repo = "twizz-app/prod-reports";
    const w = world([bundle(SENTINEL, SHA_S, "twizz-sentinel"), bundle(repo, SHA_A, "prod-reports")]);
    w.repos.files.set(`${repo}@${SHA_A}:twizz.yaml`, LEGACY_YAML);
    w.repos.files.set(`${repo}@${SHA_A}:Dockerfile`, "FROM scratch\n");
    await expect(create(w)).rejects.toEqual(refusal(/env plo-2611-prod-reports: policy \(create_env_from_repo\) refuses it/));
    // and with no entry at all the tool is denied by default
    const bare = world(undefined, { policy: { global_deny: [], write_tools: {} } });
    await expect(create(bare)).rejects.toEqual(refusal(/policy \(create_env_from_repo\) refuses it.*denied by default/));
    expect(wrote(w)).toEqual(NOTHING);
  });

  it("builds a frontend against the bundled backend it names, else the staging API, else refuses", async () => {
    const both = world([bundle(SENTINEL, SHA_S, "twizz-sentinel"), bundle(ADMIN, SHA_A, "twizz-admin")]);
    const plan = await planPreview(both.deps, { bundleKey: KEY });
    // backends are created first
    expect(plan.create.map((c) => [c.envName, c.kind, c.attachUrl])).toEqual([[ENV_S, "backend", undefined], [ENV_A, "frontend", origin(ENV_S)]]);
    await createLifecyclePreview(both.deps, { bundleKey: KEY, setHash: plan.setHash, envs: previewEnvsField(plan), actor: "nick" });
    expect(both.builds.dispatched[1]).toMatchObject({ envName: ENV_A, buildArgs: { NEXT_PUBLIC_API_URL: origin(ENV_S) } });

    const alone = world([bundle(ADMIN, SHA_A, "twizz-admin")]);
    await expect(planPreview(alone.deps, { bundleKey: KEY })).rejects.toEqual(refusal(/is a frontend and has no API to build against/));
    await expect(planPreview({ ...alone.deps, stagingApiUrl: "https://evil.example.com" }, { bundleKey: KEY })).rejects.toEqual(refusal(/no API to build against/));
    await expect(planPreview({ ...alone.deps, stagingApiUrl: "https://api-stg.twizz.com/path" }, { bundleKey: KEY })).rejects.toEqual(refusal(/no API to build against/));
    expect((await planPreview({ ...alone.deps, stagingApiUrl: "https://api-stg.twizz.com" }, { bundleKey: KEY })).create[0].attachUrl).toBe("https://api-stg.twizz.com");
  });

  it("rolls back what it created when a later env fails, and never touches an env it did not make", async () => {
    const w = world();
    w.gitops.files.set("named-envs/someone-else.yaml", "untouched");
    w.secrets.store.set("preview/moly-backend/someone-else", { A: "1" });
    const dispatch = w.builds.dispatch.bind(w.builds);
    let n = 0;
    w.builds.dispatch = async (i) => {
      if (++n === 2) throw new Error("workflow_dispatch failed (422)");
      return dispatch(i);
    };
    await expect(create(w)).rejects.toThrow(/preview not created: plo-2611-twizz-sentinel failed \(workflow_dispatch failed \(422\)\)\. Rolled back: plo-2611-moly-backend removed; plo-2611-twizz-sentinel removed\./);
    expect([...w.gitops.files.keys()].filter((p) => p.includes("plo-"))).toEqual([]);
    expect([...w.secrets.store.keys()].filter((k) => k.includes("/plo-"))).toEqual([]);
    expect(w.gitops.files.get("named-envs/someone-else.yaml")).toBe("untouched");
    expect(w.secrets.store.has("preview/moly-backend/someone-else")).toBe(true);
  });

  it("when the first env fails nothing had been created; a lost race for a name removes nothing of the winner", async () => {
    const w = world();
    // another confirm won the race for the first name between this call's plan and its create
    const taken = `preview/moly-backend/${ENV_B}`;
    const createJson = w.secrets.createJson.bind(w.secrets);
    w.secrets.createJson = async (name, value, tags) => {
      if (name === taken && !w.secrets.store.has(taken)) w.secrets.store.set(taken, { WINNER: "1" });
      return createJson(name, value, tags);
    };
    await expect(create(w)).rejects.toThrow(/preview not created: plo-2611-moly-backend failed \(ResourceExistsException.*Nothing had been created\./);
    expect(w.secrets.store.get(taken)).toEqual({ WINNER: "1" });
    expect(w.builds.dispatched).toEqual([]);
  });

  it("reports an env it could not roll back instead of hiding it", async () => {
    const w = world();
    const dispatch = w.builds.dispatch.bind(w.builds);
    let n = 0;
    w.builds.dispatch = async (i) => {
      if (++n === 2) {
        w.gitops.commit = async () => {
          throw new Error("GitHub 503");
        };
        throw new Error("workflow_dispatch failed (422)");
      }
      return dispatch(i);
    };
    await expect(create(w)).rejects.toThrow(/plo-2611-moly-backend could NOT be removed \(GitHub 503\) — tear it down on \/environments/);
  });
});

describe("lifecycle_request_smoke", () => {
  const up = () => {
    const w = world();
    deployed(w, ENV_S, SENTINEL, SHA_S, "twizz-sentinel");
    deployed(w, ENV_B, BACKEND, SHA_B, "moly-backend");
    return w;
  };
  const request = async (w: World, scope: "preview" | "stg") => {
    const plan = await planSmoke(w.deps, { scope, bundleKey: KEY });
    return requestLifecycleSmoke(w.deps, { scope, bundleKey: KEY, setHash: plan.setHash, targets: smokeTargetsField(plan.targets), actor: "nick" });
  };

  it("preview: targets are the bundle's own env origins, named by registry service", async () => {
    const w = up();
    const r = await request(w, "preview");
    expect(r).toMatchObject({ requestId: "req-1", scope: "preview", bundleKey: KEY, status: "pending" });
    expect(r.targets).toEqual([{ name: "moly-backend", baseUrl: origin(ENV_B) }, { name: "twizz-sentinel", baseUrl: origin(ENV_S) }]);
    expect(w.queue.rows[0]).toMatchObject({ kind: "smoke", requestedBy: "nick", params: { scope: "preview", bundleKey: KEY, targets: r.targets } });
  });

  it("stg: targets are the fixed staging hosts of the release-train services only", async () => {
    const w = world([bundle(SENTINEL, SHA_S, "twizz-sentinel"), bundle(ADMIN, SHA_A, "twizz-admin"), bundle(BACKEND, SHA_B, "moly-backend")]);
    for (const b of w.state.bundles) if (b.staging) b.staging.deployed = true;
    const r = await request(w, "stg");
    expect(r.targets).toEqual([{ name: "twizz-admin", baseUrl: STG_A }, { name: "twizz-sentinel", baseUrl: STG_S }]);
  });

  it("refuses when the state machine says no, an env is not up, or staging does not run the bundle", async () => {
    const w = up();
    w.state.actions.smokePreview = no("a preview smoke run is already in flight");
    await expect(request(w, "preview")).rejects.toEqual(refusal(/already in flight/));
    w.state.actions.smokePreview = yes;
    w.state.bundles[1].env = { name: ENV_B, up: false };
    await expect(request(w, "preview")).rejects.toEqual(refusal(/moly-backend: its preview env is not up/));
    w.state.bundles[1].env = null;
    await expect(request(w, "preview")).rejects.toEqual(refusal(/its preview env is not up/));
    await expect(request(w, "stg")).rejects.toEqual(refusal(/twizz-sentinel: staging is not running this bundle/));
    w.state.actions.smokeStg = no("staging is not running this bundle yet");
    await expect(request(w, "stg")).rejects.toEqual(refusal(/not running this bundle yet/));
    expect(w.queue.rows).toEqual([]);
  });

  it("refuses an unknown scope, another bundle, an env that is not a bundle env, and a bundle with nothing to smoke", async () => {
    const w = up();
    await expect(planSmoke(w.deps, { scope: "production" as never, bundleKey: KEY })).rejects.toEqual(refusal(/scope must be preview or stg/));
    await expect(planSmoke(w.deps, { scope: "preview", bundleKey: OTHER_KEY })).rejects.toEqual(refusal(/the bundle changed/));
    w.state.bundles[0].env = { name: "sentinel-mine", up: true };
    await expect(planSmoke(w.deps, { scope: "preview", bundleKey: KEY })).rejects.toEqual(refusal(/is not a bundle preview env/));
    const none = world([bundle(BACKEND, SHA_B, "moly-backend")]);
    await expect(planSmoke(none.deps, { scope: "stg", bundleKey: KEY })).rejects.toEqual(refusal(/no bundled service has a staging route/));
    const empty = world([bundle("twizz-app/lolygram-discover", SHA_A, null)]);
    await expect(planSmoke(empty.deps, { scope: "preview", bundleKey: KEY })).rejects.toEqual(refusal(/no bundled repository maps to a Nebula service/));
  });

  it("refuses a confirm whose targets are not what would be called now, and a second request while one is in flight", async () => {
    const w = up();
    const plan = await planSmoke(w.deps, { scope: "preview", bundleKey: KEY });
    await expect(requestLifecycleSmoke(w.deps, { scope: "preview", bundleKey: KEY, setHash: plan.setHash, targets: "twizz-sentinel=https://evil.prv.twizz.com", actor: "nick" })).rejects.toEqual(refusal(/changed since you reviewed/));
    await expect(requestLifecycleSmoke(w.deps, { scope: "preview", bundleKey: KEY, setHash: "0".repeat(64), targets: smokeTargetsField(plan.targets), actor: "nick" })).rejects.toEqual(refusal(/changed since you reviewed/));
    expect(w.queue.rows).toEqual([]);
    await request(w, "preview");
    await expect(request(w, "preview")).rejects.toEqual(refusal(/a preview smoke for this bundle is already pending \(requested by nick/));
    expect(w.queue.rows).toHaveLength(1);
  });
});

describe("smokeGap (what 'the smoke passed' means for a write)", () => {
  const want = [{ service: "twizz-sentinel", origins: [origin(ENV_S)] }];
  const ok = passed("preview", [{ name: "twizz-sentinel", baseUrl: origin(ENV_S) }]);
  it("holds for a pass that covered every service where it runs", () => {
    expect(smokeGap(ok, "preview", want)).toBeNull();
  });
  it("names the gap otherwise", () => {
    expect(smokeGap(noSmoke, "preview", want)).toMatch(/has not passed \(not requested yet\)/);
    expect(smokeGap({ ...ok, verdict: "running", detail: "smoke checks running" }, "preview", want)).toMatch(/has not passed/);
    expect(smokeGap({ ...ok, verdict: "fail", detail: "1 of 2 checks failed" }, "stg", want)).toMatch(/latest staging smoke for this bundle has not passed \(1 of 2 checks failed\)/);
    expect(smokeGap({ ...ok, request: null }, "preview", want)).toMatch(/has not passed/);
    expect(smokeGap({ ...ok, results: [...ok.results, { name: "twizz-sentinel/x", url: `${origin(ENV_S)}/x`, ok: false }] }, "preview", want)).toMatch(/failing checks/);
    expect(smokeGap(ok, "preview", [...want, { service: "moly-backend", origins: [origin(ENV_B)] }])).toMatch(/did not cover moly-backend/);
    expect(smokeGap(ok, "preview", [{ service: "twizz-sentinel", origins: [STG_S] }])).toMatch(/checked twizz-sentinel at https:\/\/plo-2611-twizz-sentinel\.prv\.twizz\.com, which is not where this bundle runs/);
    // a service whose inventory has no checks was verified by nobody
    expect(smokeGap({ ...ok, results: [] }, "preview", want)).toMatch(/verified nothing for twizz-sentinel/);
    expect(smokeGap({ ...ok, results: [{ name: "moly-backend/health", url: `${origin(ENV_S)}/health`, ok: true }] }, "preview", want)).toMatch(/verified nothing for twizz-sentinel/);
    expect(smokeGap({ ...ok, results: [{ name: "twizz-sentinel/health", url: "https://elsewhere.prv.twizz.com/health", ok: true }] }, "preview", want)).toMatch(/verified nothing for twizz-sentinel/);
    // a look-alike host is not the origin
    expect(smokeGap({ ...ok, results: [{ name: "twizz-sentinel/health", url: `${origin(ENV_S)}.evil.com/health`, ok: true }] }, "preview", want)).toMatch(/verified nothing/);
  });
});

describe("lifecycle_deploy_stg", () => {
  const deploy = async (w: World) => {
    const plan = await planDeployStg(w.deps, { bundleKey: KEY });
    return deployLifecycleStg(w.deps, { bundleKey: KEY, setHash: plan.setHash, promote: deployPromoteField(plan), actor: "nick" });
  };

  it("opens the promotion PR with the preview env's built image, reports what has no staging route, and merges nothing", async () => {
    const w = smokedPreview();
    const plan = await planDeployStg(w.deps, { bundleKey: KEY });
    expect(plan.promote).toEqual([{ service: "twizz-sentinel", envName: ENV_S, imageTag: TAG_S, from: "main-0000000000000000000000000000000000000000", host: "sentinel-stg.prv.twizz.com", valuesFile: "apps/twizz-sentinel/values-staging.yaml", argoApp: "staging-twizz-sentinel" }]);
    expect(plan.noRoute).toEqual([{ github: BACKEND, service: "moly-backend", note: LIFECYCLE_NO_STAGING_ROUTE }]);
    expect(deployPromoteField(plan)).toBe(`twizz-sentinel:${TAG_S}`);
    expect(w.promotions.prs).toEqual([]);
    const r = await deploy(w);
    expect(r.promotions).toEqual([{ service: "twizz-sentinel", imageTag: TAG_S, prNumber: 101, prUrl: "https://github.com/TwizzyNicky/twizz-gitops/pull/101", existing: false, host: "sentinel-stg.prv.twizz.com" }]);
    expect(r.noRoute[0].note).toBe("no staging route in Nebula (deploys via the repo's own pipeline on merge)");
    expect(w.promotions.prs.map((p) => p.branch)).toEqual([`promote/twizz-sentinel/staging/${TAG_S}`]);
    expect(w.promotions.prs[0].files["apps/twizz-sentinel/values-staging.yaml"]).toContain(`tag: ${TAG_S}`);
    expect(w.promotions.merged).toEqual([]);
    // gitops main is untouched: nothing deploys until the PR is merged
    expect(w.promotions.main.get("apps/twizz-sentinel/values-staging.yaml")).toBe(VALUES("twizz-sentinel"));
  });

  it("refuses unless the latest preview smoke for exactly this bundle passed", async () => {
    const w = smokedPreview();
    const pass = w.state.smoke.preview;
    for (const ev of [noSmoke, { ...pass, verdict: "running" as const, detail: "smoke checks running" }, { ...pass, verdict: "fail" as const, detail: "1 of 2 checks failed" }]) {
      w.state.smoke.preview = ev;
      await expect(deploy(w)).rejects.toEqual(refusal(/the latest preview smoke for this bundle has not passed/));
    }
    w.state.smoke.preview = pass;
    w.state.actions.deployStg = no("the latest preview smoke for this bundle has not passed");
    await expect(deploy(w)).rejects.toEqual(refusal(/has not passed/));
    await expect(planDeployStg(w.deps, { bundleKey: OTHER_KEY })).rejects.toEqual(refusal(/the bundle changed/));
    expect(w.promotions.prs).toEqual([]);
  });

  it("refuses a pass that did not cover every bundled service where it runs", async () => {
    const w = smokedPreview();
    const full = w.state.smoke.preview;
    w.state.smoke.preview = passed("preview", [{ name: "twizz-sentinel", baseUrl: origin(ENV_S) }]);
    await expect(deploy(w)).rejects.toEqual(refusal(/did not cover moly-backend/));
    w.state.smoke.preview = passed("preview", [{ name: "twizz-sentinel", baseUrl: "https://plo-2610-twizz-sentinel.prv.twizz.com" }, { name: "moly-backend", baseUrl: origin(ENV_B) }]);
    await expect(deploy(w)).rejects.toEqual(refusal(/checked twizz-sentinel at https:\/\/plo-2610-twizz-sentinel\.prv\.twizz\.com, which is not where this bundle runs/));
    w.state.smoke.preview = { ...full, results: full.results.filter((r) => !r.name.startsWith("twizz-sentinel/")) };
    await expect(deploy(w)).rejects.toEqual(refusal(/verified nothing for twizz-sentinel/));
    expect(w.promotions.prs).toEqual([]);
  });

  it("refuses a smoke that is older than the preview it would vouch for (rebuilt or recreated since)", async () => {
    const w = smokedPreview();
    // the sentinel env was rebuilt at 11:30, the smoke was requested at 11:00
    deployed(w, ENV_S, SENTINEL, SHA_S, "twizz-sentinel", { build: { status: "PASS", expectedTag: TAG_S, startedAt: "2026-11-25T11:20:00.000Z", finishedAt: "2026-11-25T11:30:00.000Z" } });
    await expect(deploy(w)).rejects.toEqual(refusal(/plo-2611-twizz-sentinel was \(re\)built at 2026-11-25T11:30:00\.000Z, after the preview smoke was requested \(2026-11-25T11:00:00\.000Z\) — run the preview smoke again/));
    // the same holds for a bundled service that is not on the release train
    const w2 = smokedPreview();
    deployed(w2, ENV_B, BACKEND, SHA_B, "moly-backend", { build: { status: "PASS", expectedTag: nebulaTag(ENV_B, SHA_B), startedAt: "2026-11-25T11:20:00.000Z" } });
    await expect(deploy(w2)).rejects.toEqual(refusal(/plo-2611-moly-backend was \(re\)built at 2026-11-25T11:20:00\.000Z, after/));
    // exactly-equal instants do not count as "after the build"
    const w3 = smokedPreview();
    deployed(w3, ENV_S, SENTINEL, SHA_S, "twizz-sentinel", { build: { status: "PASS", expectedTag: TAG_S, startedAt: "2026-11-25T10:00:00.000Z", finishedAt: "2026-11-25T11:00:00.000Z" } });
    await expect(deploy(w3)).rejects.toEqual(refusal(/after the preview smoke was requested/));
    // no build record at all: the smoke cannot be tied to the env
    const w4 = smokedPreview();
    deployed(w4, ENV_S, SENTINEL, SHA_S, "twizz-sentinel", { build: undefined });
    await expect(deploy(w4)).rejects.toEqual(refusal(/has no build record/));
    for (const x of [w, w2, w3, w4]) expect(x.promotions.prs).toEqual([]);
  });

  it("refuses when the preview env to promote from is gone, rebuilding, from another commit, or not on the bundle image", async () => {
    const gone = smokedPreview();
    gone.state.bundles[0].env = null;
    await expect(deploy(gone)).rejects.toEqual(refusal(/twizz-sentinel: its preview env is gone/));

    const vanished = smokedPreview();
    vanished.gitops.files.delete(`named-envs/${ENV_S}.yaml`);
    await expect(deploy(vanished)).rejects.toEqual(refusal(/preview env plo-2611-twizz-sentinel no longer exists/));

    const rebuilding = smokedPreview();
    rebuilding.gitops.files.delete(`named-envs/${ENV_S}.yaml`);
    deployed(rebuilding, ENV_S, SENTINEL, SHA_S, "twizz-sentinel", { imageTag: undefined, build: { status: "RUNNING", expectedTag: TAG_S, startedAt: "2026-11-25T11:30:00.000Z" } }, "pending");
    rebuilding.state.bundles[0].env = { name: ENV_S, up: false };
    await expect(deploy(rebuilding)).rejects.toEqual(refusal(/is being \(re\)built/));

    const other = smokedPreview();
    deployed(other, ENV_S, SENTINEL, "7".repeat(40), "twizz-sentinel");
    await expect(deploy(other)).rejects.toEqual(refusal(/is not built from twizz-app\/twizz-sentinel@a1a1a1a any more/));

    const swapped = smokedPreview();
    deployed(swapped, ENV_S, SENTINEL, SHA_S, "twizz-sentinel", { imageTag: "build-75b95f51-a1de-432d-8132-33a2802f622c" });
    await expect(deploy(swapped)).rejects.toEqual(refusal(/runs build-75b95f51-a1de-432d-8132-33a2802f622c, which is not the bundle image/));

    for (const x of [gone, vanished, rebuilding, other, swapped]) expect(x.promotions.prs).toEqual([]);
  });

  it("an expired preview env of a service that is NOT promoted does not undo a recorded pass", async () => {
    const w = smokedPreview();
    w.state.bundles[1].env = null;
    w.gitops.files.delete(`named-envs/${ENV_B}.yaml`);
    await expect(deploy(w)).resolves.toMatchObject({ promotions: [{ service: "twizz-sentinel" }] });
  });

  it("refuses an image that is not in ECR, a staging target that is not bootstrapped, and a tag promote_release would not allow", async () => {
    const noImage = smokedPreview();
    noImage.imageTable["twizz-sentinel"] = [];
    await expect(deploy(noImage)).rejects.toEqual(refusal(/ECR twizz-sentinel:nb-plo-2611-twizz-sentinel-a1a1a1a1a1a1 does not exist/));

    const noValues = smokedPreview();
    noValues.promotions.main.delete("apps/twizz-sentinel/values-staging.yaml");
    await expect(deploy(noValues)).rejects.toEqual(refusal(/values-staging\.yaml does not exist in gitops/));

    const strict: Policy = { ...policy, write_tools: { ...policy.write_tools, promote_release: { allow: { service: ["twizz-admin"], target: ["staging"], imageTag: ["nb-*"] } } } };
    const denied = smokedPreview();
    denied.deps.policy = strict;
    await expect(deploy(denied)).rejects.toEqual(refusal(/promoting twizz-sentinel: policy \(promote_release\) refuses it/));
    for (const x of [noImage, noValues, denied]) expect(x.promotions.prs).toEqual([]);
  });

  it("refuses when nothing is on the release train, and when everything is already promoted or deployed", async () => {
    const none = smokedPreview([bundle(BACKEND, SHA_B, "moly-backend")]);
    await expect(deploy(none)).rejects.toEqual(refusal(/no bundled service is on the release train: no staging route in Nebula \(deploys via the repo's own pipeline on merge\)/));

    const open = smokedPreview();
    open.state.bundles[0].staging = { deployed: false, promotion: { number: 77, url: "https://github.com/TwizzyNicky/twizz-gitops/pull/77", imageTag: TAG_S } };
    await expect(deploy(open)).rejects.toEqual(refusal(/every promotable service is already promoted or deployed/));

    const live = smokedPreview();
    live.state.bundles[0].staging = { deployed: true, promotion: null };
    await expect(deploy(live)).rejects.toEqual(refusal(/already promoted or deployed/));

    // gitops already on the image, Argo not confirmed yet: nothing to open either
    const merged = smokedPreview();
    merged.promotions.main.set("apps/twizz-sentinel/values-staging.yaml", VALUES("twizz-sentinel").replace(/tag: \S+/, `tag: ${TAG_S}`));
    await expect(deploy(merged)).rejects.toEqual(refusal(/already promoted or deployed/));
    for (const x of [none, open, live, merged]) expect(x.promotions.prs).toEqual([]);
  });

  it("promotes only what still needs it and lists the rest", async () => {
    const w = smokedPreview([bundle(SENTINEL, SHA_S, "twizz-sentinel"), bundle(ADMIN, SHA_A, "twizz-admin")]);
    w.state.bundles[0].staging = { deployed: false, promotion: { number: 77, url: "https://github.com/TwizzyNicky/twizz-gitops/pull/77", imageTag: TAG_S } };
    const plan = await planDeployStg(w.deps, { bundleKey: KEY });
    expect(plan.promote.map((p) => [p.service, p.imageTag])).toEqual([["twizz-admin", TAG_A]]);
    expect(plan.already).toEqual([{ service: "twizz-sentinel", reason: "promotion PR #77 is open — merge it on /releases", prNumber: 77, prUrl: "https://github.com/TwizzyNicky/twizz-gitops/pull/77" }]);
  });

  it("is idempotent when replayed: an identical open PR is returned, not opened twice", async () => {
    const w = smokedPreview();
    const plan = await planDeployStg(w.deps, { bundleKey: KEY });
    const args = { bundleKey: KEY, setHash: plan.setHash, promote: deployPromoteField(plan), actor: "nick" };
    await deployLifecycleStg(w.deps, args);
    // two operators confirmed at once: the state machine has not caught up for the second
    const again = await deployLifecycleStg(w.deps, args);
    expect(again.promotions).toEqual([expect.objectContaining({ prNumber: 101, existing: true })]);
    expect(w.promotions.prs).toHaveLength(1);
  });

  it("refuses a confirm whose bound images are not what would be promoted now", async () => {
    const w = smokedPreview();
    const plan = await planDeployStg(w.deps, { bundleKey: KEY });
    await expect(deployLifecycleStg(w.deps, { bundleKey: KEY, setHash: plan.setHash, promote: "twizz-sentinel:nb-plo-2611-twizz-sentinel-000000000000", actor: "nick" })).rejects.toEqual(refusal(/changed since you reviewed/));
    await expect(deployLifecycleStg(w.deps, { bundleKey: KEY, setHash: "0".repeat(64), promote: deployPromoteField(plan), actor: "nick" })).rejects.toEqual(refusal(/changed since you reviewed/));
    expect(w.promotions.prs).toEqual([]);
  });

  it("names what was opened when a later promotion fails", async () => {
    const w = smokedPreview([bundle(SENTINEL, SHA_S, "twizz-sentinel"), bundle(ADMIN, SHA_A, "twizz-admin")]);
    const openPr = w.promotions.openPr.bind(w.promotions);
    let n = 0;
    w.promotions.openPr = async (i) => {
      if (++n === 2) throw new Error("GitHub 502");
      return openPr(i);
    };
    // sorted by service: twizz-admin first, then twizz-sentinel
    await expect(deploy(w)).rejects.toThrow(/promotion of twizz-sentinel failed \(GitHub 502\)\. Already opened: twizz-admin #101\. Run it again to continue/);
    expect(w.promotions.merged).toEqual([]);
  });
});

describe("lifecycle_signoff", () => {
  /** staging runs the bundle and its smoke passed */
  const ready = () => {
    const w = smokedPreview();
    w.state.bundles[0].staging = { deployed: true, promotion: null };
    w.state.smoke.stg = passed("stg", [{ name: "twizz-sentinel", baseUrl: STG_S }]);
    return w;
  };
  const sign = async (w: World, actor = "nick") => {
    const plan = await planSignoff(w.deps, { bundleKey: KEY });
    return signoffLifecycle(w.deps, { bundleKey: KEY, setHash: plan.setHash, scope: plan.scope, evidenceHash: plan.evidenceHash, actor });
  };

  it("comments on every bundled pull request with the evidence, and merges nothing", async () => {
    const w = ready();
    w.state.bundles[0].included = [{ repo: SENTINEL, number: 7, url: "u" }, { repo: SENTINEL, number: 9, url: "u" }];
    const r = await sign(w, "igor");
    expect(r).toMatchObject({ bundleKey: KEY, key12: KEY.slice(0, 12), signedOffBy: "igor", scope: "stg", merged: false, skippedPrs: [] });
    expect(r.comments.map((c) => [c.repo, c.number, c.status])).toEqual([[BACKEND, 7, "posted"], [SENTINEL, 7, "posted"], [SENTINEL, 9, "posted"]]);
    expect(r.commits).toEqual([`${SENTINEL}@${SHA_S.slice(0, 12)}`, `${BACKEND}@${SHA_B.slice(0, 12)}`]);
    const body = w.repos.comments.find((c) => c.repo === SENTINEL && c.pr === 9)!.body;
    expect(body).toContain(`Signed off in Nebula by igor for bundle ${KEY.slice(0, 12)}; preview + smoke evidence:`);
    expect(body).toContain("- This repository: `plo/bundle/2026-11` at `a1a1a1a1a1a1`");
    expect(body).toContain(`- Preview smoke: PASS, 2 checks, run \`smoke-preview-1\`, finished 2026-11-25T11:05:00.000Z — ${origin(ENV_B)}, ${origin(ENV_S)}`);
    expect(body).toContain(`- Staging smoke: PASS, 1 check, run \`smoke-stg-1\`, finished 2026-11-25T11:05:00.000Z — ${STG_S}`);
    expect(body).toContain("Nebula did not merge anything");
    expect(body).toContain(signoffMarker(KEY));
    // the only things it reached on GitHub: branch heads and comments
    expect([...new Set(w.repos.calls)].sort()).toEqual(["comment", "hasComment", "headOf"]);
    expect(w.promotions.merged).toEqual([]);
    expect(w.promotions.prs).toEqual([]);
    expect(w.gitops.commits).toEqual([]);
  });

  it("rests on the preview smoke when nothing bundled is on the release train", async () => {
    const w = smokedPreview([bundle(BACKEND, SHA_B, "moly-backend")]);
    const plan = await planSignoff(w.deps, { bundleKey: KEY });
    expect(plan).toMatchObject({ scope: "preview", evidence: { stg: null, preview: { runId: "smoke-preview-1", checks: 1 } } });
    const r = await sign(w);
    expect(r.scope).toBe("preview");
    expect(w.repos.comments[0].body).toContain("Nothing in this bundle has a staging route in Nebula, so the sign-off rests on the preview smoke");
    expect(w.repos.comments[0].body).not.toContain("Staging smoke");
  });

  it("refuses unless the latest staging smoke for exactly this bundle passed on what staging runs", async () => {
    const w = ready();
    const pass = w.state.smoke.stg;
    for (const ev of [noSmoke, { ...pass, verdict: "running" as const, detail: "smoke checks running" }, { ...pass, verdict: "fail" as const, detail: "1 of 1 checks failed" }]) {
      w.state.smoke.stg = ev;
      await expect(sign(w)).rejects.toEqual(refusal(/the latest staging smoke for this bundle has not passed/));
    }
    // a preview-origin pass is not a staging pass
    w.state.smoke.stg = passed("stg", [{ name: "twizz-sentinel", baseUrl: origin(ENV_S) }]);
    await expect(sign(w)).rejects.toEqual(refusal(/checked twizz-sentinel at https:\/\/plo-2611-twizz-sentinel\.prv\.twizz\.com, which is not where this bundle runs/));
    w.state.smoke.stg = passed("stg", [{ name: "twizz-admin", baseUrl: STG_A }]);
    await expect(sign(w)).rejects.toEqual(refusal(/did not cover twizz-sentinel/));
    w.state.smoke.stg = { ...pass, results: [] };
    await expect(sign(w)).rejects.toEqual(refusal(/verified nothing for twizz-sentinel/));
    w.state.smoke.stg = pass;
    w.state.bundles[0].staging = { deployed: false, promotion: null };
    await expect(sign(w)).rejects.toEqual(refusal(/twizz-sentinel: staging is not running this bundle/));
    expect(w.repos.comments).toEqual([]);
  });

  it("with a staging route, a passed preview smoke alone is not enough", async () => {
    const w = smokedPreview();
    w.state.bundles[0].staging = { deployed: true, promotion: null };
    await expect(sign(w)).rejects.toEqual(refusal(/latest staging smoke for this bundle has not passed/));
    expect(w.repos.comments).toEqual([]);
  });

  it("preview-only bundles: refuses without the right preview smoke, or one older than the env", async () => {
    const w = smokedPreview([bundle(BACKEND, SHA_B, "moly-backend")]);
    const pass = w.state.smoke.preview;
    w.state.smoke.preview = noSmoke;
    await expect(sign(w)).rejects.toEqual(refusal(/the latest preview smoke for this bundle has not passed/));
    w.state.smoke.preview = passed("preview", [{ name: "moly-backend", baseUrl: "https://plo-2610-moly-backend.prv.twizz.com" }]);
    await expect(sign(w)).rejects.toEqual(refusal(/which is not where this bundle runs/));
    w.state.smoke.preview = pass;
    deployed(w, ENV_B, BACKEND, SHA_B, "moly-backend", { build: { status: "PASS", expectedTag: nebulaTag(ENV_B, SHA_B), startedAt: "2026-11-25T11:20:00.000Z", finishedAt: "2026-11-25T11:30:00.000Z" } });
    await expect(sign(w)).rejects.toEqual(refusal(/was \(re\)built at 2026-11-25T11:30:00\.000Z, after the preview smoke was requested/));
    expect(w.repos.comments).toEqual([]);
  });

  it("refuses a second sign-off, a state machine that says no, another bundle, and a bundle with nothing Nebula can vouch for", async () => {
    const w = ready();
    w.state.signoff = { by: "igor", at: "2026-11-25T11:30:00.000Z" };
    await expect(sign(w)).rejects.toEqual(refusal(/already signed off \(by igor at 2026-11-25T11:30:00\.000Z\)/));
    w.state.signoff = null;
    w.state.actions.signoff = no("the latest staging smoke for this bundle has not passed");
    await expect(sign(w)).rejects.toEqual(refusal(/has not passed/));
    w.state.actions.signoff = yes;
    await expect(planSignoff(w.deps, { bundleKey: OTHER_KEY })).rejects.toEqual(refusal(/the bundle changed/));
    const nothing = world([bundle("twizz-app/lolygram-discover", SHA_A, null)]);
    await expect(sign(nothing)).rejects.toEqual(refusal(/nothing to sign off here/));
    expect(w.repos.comments).toEqual([]);
  });

  it("refuses when any bundle branch moved or vanished — what was tested is no longer what the branch holds", async () => {
    const w = ready();
    w.repos.heads.set(`${BACKEND}#${BRANCH}`, "9".repeat(40));
    await expect(sign(w)).rejects.toEqual(refusal(/twizz-app\/Moly-backend: plo\/bundle\/2026-11 moved since the snapshot/));
    w.repos.heads.delete(`${BACKEND}#${BRANCH}`);
    await expect(sign(w)).rejects.toEqual(refusal(/no longer exists/));
    // also a bundled repository Nebula cannot preview is part of what is signed off
    const w2 = ready();
    w2.state.bundles = [...w2.state.bundles, bundle("twizz-app/lolygram-discover", SHA_A, null)];
    await expect(sign(w2)).rejects.toEqual(refusal(/twizz-app\/lolygram-discover: branch plo\/bundle\/2026-11 no longer exists/));
    w2.repos.heads.set(`twizz-app/lolygram-discover#${BRANCH}`, SHA_A);
    expect((await sign(w2)).comments.map((c) => c.repo)).toEqual(["twizz-app/lolygram-discover", BACKEND, SENTINEL]);
    const outside = ready();
    outside.state.bundles = [...outside.state.bundles, bundle("someone/else", SHA_A, null)];
    await expect(sign(outside)).rejects.toEqual(refusal(/someone\/else: the bundle names a repository, branch or commit Nebula cannot verify/));
    expect(w.repos.comments).toEqual([]);
    expect(outside.repos.comments).toEqual([]);
  });

  it("refuses a confirm when the evidence changed after the review (a new smoke run, a new PR in the bundle)", async () => {
    const w = ready();
    const plan = await planSignoff(w.deps, { bundleKey: KEY });
    const args = { bundleKey: KEY, setHash: plan.setHash, scope: plan.scope, evidenceHash: plan.evidenceHash, actor: "nick" };
    w.state.smoke.stg = passed("stg", [{ name: "twizz-sentinel", baseUrl: STG_S }], { request: { id: "req-stg-2", createdAt: "2026-11-25T11:40:00.000Z" }, runId: "smoke-stg-2" });
    await expect(signoffLifecycle(w.deps, args)).rejects.toEqual(refusal(/changed since you reviewed/));
    const w2 = ready();
    const p2 = await planSignoff(w2.deps, { bundleKey: KEY });
    w2.state.bundles[0].included = [...w2.state.bundles[0].included, { repo: SENTINEL, number: 11, url: "u" }];
    await expect(signoffLifecycle(w2.deps, { bundleKey: KEY, setHash: p2.setHash, scope: p2.scope, evidenceHash: p2.evidenceHash, actor: "nick" })).rejects.toEqual(refusal(/changed since you reviewed/));
    await expect(signoffLifecycle(w2.deps, { bundleKey: KEY, setHash: p2.setHash, scope: "preview", evidenceHash: p2.evidenceHash, actor: "nick" })).rejects.toEqual(refusal(/changed since you reviewed/));
    expect(w.repos.comments).toEqual([]);
    expect(w2.repos.comments).toEqual([]);
  });

  it("never comments outside the bundled repository, and does not comment twice", async () => {
    const w = ready();
    w.state.bundles[0].included = [{ repo: SENTINEL, number: 7, url: "u" }, { repo: "torvalds/linux", number: 1, url: "u" }, { repo: "TWIZZ-APP/twizz-sentinel", number: 7, url: "u" }, { repo: SENTINEL, number: 0, url: "u" }];
    const plan = await planSignoff(w.deps, { bundleKey: KEY });
    expect(plan.prs.map((p) => `${p.repo}#${p.number}`)).toEqual([`${BACKEND}#7`, `${SENTINEL}#7`]);
    expect(plan.skippedPrs).toEqual([{ repo: "torvalds/linux", number: 1, reason: "not a pull request of the bundled repository" }, { repo: SENTINEL, number: 0, reason: "not a pull request of the bundled repository" }]);
    const first = await sign(w);
    expect(first.comments.every((c) => c.status === "posted")).toBe(true);
    expect(w.repos.comments.map((c) => c.repo).sort()).toEqual([BACKEND, SENTINEL].sort());
    // two operators confirmed at once: the second leaves no duplicate comments
    const second = await sign(w);
    expect(second.comments.map((c) => c.status)).toEqual(["already", "already"]);
    expect(w.repos.comments).toHaveLength(2);
  });

  it("a comment that cannot be posted is reported and does not undo the sign-off", async () => {
    const w = ready();
    w.repos.failComment.add(`${BACKEND}#7`);
    const r = await sign(w);
    expect(r.comments).toEqual([
      { repo: BACKEND, number: 7, status: "failed", error: "Resource not accessible by integration (403)" },
      { repo: SENTINEL, number: 7, status: "posted", url: expect.stringContaining("/pull/7#issuecomment-") },
    ]);
    expect(r.merged).toBe(false);
  });

  it("the comment is built only from what Nebula derived", async () => {
    const w = ready();
    const plan = await planSignoff(w.deps, { bundleKey: KEY });
    const body = signoffCommentBody({ actor: "nick", plan, repo: BACKEND, nebulaUrl: "https://nebula.example" });
    expect(body.split("\n")[0]).toBe(`Signed off in Nebula by nick for bundle ${KEY.slice(0, 12)}; preview + smoke evidence:`);
    expect(body).toContain("- This repository: `plo/bundle/2026-11` at `b2b2b2b2b2b2`");
    expect(body).toContain(`- Bundle \`${KEY}\`: 2 repositories (${SENTINEL}@a1a1a1a, ${BACKEND}@b2b2b2b)`);
    expect(body).toContain("- Record: https://nebula.example/lifecycle");
    // a bare login, never an @mention
    expect(body).not.toContain("@nick");
  });
});
