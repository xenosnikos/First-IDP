// Lifecycle (docs/NEBULA.md §N9): the five gated operator writes of the
// /lifecycle tab. Each one is a `plan…` (read the world, decide, refuse) and an
// action that RE-PLANS inside the gate and only then writes — so every
// precondition is enforced server-side at the moment of the write, not by the
// page that offered the button:
//
//   lifecycle_request_run     → queue a `plan` / `cve` run for plo-dispatch
//   lifecycle_create_preview  → one named env per bundled registry service,
//                               through the existing createEnvFromRepo path
//   lifecycle_request_smoke   → queue a smoke run; targets are built HERE
//   lifecycle_deploy_stg      → promoteRelease per release-train service
//   lifecycle_signoff         → the human gate: a comment on each bundled PR
//
// Nothing here merges a pull request, touches a kube API, or takes a URL, an
// env name, an image tag or a repository from the caller: all of them are
// derived from the snapshot PLO published, the registry and the gitops repo.
// The reused actions keep their own checks, and the policy.yaml entry of the
// tool each one normally runs under is evaluated here as well.
import { createHash } from "node:crypto";
import { LIFECYCLE_BUNDLE_KEY_RE, type LifecycleSmokeParams, type LifecycleSmokeScope } from "@twizz-idp/shared";
import { SHA_RE, createEnvFromRepo, isValidBranch, isValidRepo, type EnvFromRepoDeps } from "./env-from-repo";
import { DEFAULT_MAX_NAMED_ENVS, countEnvs, envHost, envSecretName, findEnv, isValidName, nebulaTag, resolveService, teardownNamedEnv, type DbMode, type EnvKind, type NamedEnvManifest, type SecretStore } from "./named-envs";
import { evaluatePolicy, type Policy } from "./policy";
import { isPromotableTag, promoteRelease, readTargetState, type PromoteDeps } from "./promote";
import { releaseTarget } from "./registry";
import { parseTwizzYaml, type TwizzConfig } from "./twizz-yaml";

// ── constants ─────────────────────────────────────────────────────────────

/** Preview envs of a bundle live three days, then the reaper takes them. */
export const LIFECYCLE_PREVIEW_TTL_HOURS = 72;
/** Named envs created for a bundle: `plo-<yymm>-<service>`. */
export const LIFECYCLE_ENV_PREFIX = "plo-";
/** The only origins a smoke request may name: a preview-domain host over
 * https. PLO enforces its own allowlist on top (`smoke.allowedHosts`). */
export const LIFECYCLE_SMOKE_ORIGIN_RE = /^https:\/\/[a-z0-9-]+\.prv\.twizz\.com$/;
/** The gate field value for staging. Never the word itself next to "prod". */
export const LIFECYCLE_STG = "stg";
export const LIFECYCLE_NEBULA_URL = "https://nebula.prv.twizz.com";
export const LIFECYCLE_NO_STAGING_ROUTE = "no staging route in Nebula (deploys via the repo's own pipeline on merge)";
const CONFIG_FILE = "twizz.yaml";
const MAX_SIGNOFF_PRS = 200;

/** A precondition that does not hold. Thrown by every `plan…`; the router
 * audits it as a denial before the gate, the gate audits it when it happens
 * inside the action. Anything else thrown is a failure, not a refusal. */
export class LifecycleRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LifecycleRefusal";
  }
}
function refuse(message: string): never {
  throw new LifecycleRefusal(message);
}
const errText = (e: unknown) => String((e as Error)?.message ?? e);

// ── what the actions read (the dashboard maps its PreviewView onto this) ──

export type LifecycleAllow = { allowed: true } | { allowed: false; reason: string };

export type LifecyclePr = { repo: string; number: number; url: string };

/** One bundled repository, as the preview state machine sees it right now. */
export type LifecycleBundleState = {
  /** owner/name on GitHub */
  github: string;
  /** plo/bundle/<yyyy-mm> */
  branch: string;
  /** null when nothing could be bundled */
  headSha: string | null;
  included: readonly LifecyclePr[];
  /** Nebula registry service; null: no preview route */
  service: string | null;
  promotable: boolean;
  /** has a head sha AND a registry service */
  previewable: boolean;
  /** why it is not previewable, in plain words */
  note: string | null;
  /** the name its preview env gets */
  envName: string | null;
  /** the live named env built from exactly this head, if any */
  env: { name: string; up: boolean } | null;
  /** release-train services only */
  staging: { deployed: boolean; promotion: { number: number; url: string; imageTag: string } | null } | null;
};

/** The latest smoke request for (scope, bundleKey) and what came back for it. */
export type LifecycleSmokeEvidence = {
  verdict: "none" | "running" | "pass" | "fail";
  detail: string;
  request: { id: string; createdAt: string } | null;
  runId: string | null;
  finishedAt: string | null;
  results: ReadonlyArray<{ name: string; url: string; ok: boolean }>;
  /** the targets that request was queued with (built server-side, read back from the row) */
  targets: ReadonlyArray<{ name: string; baseUrl: string }>;
};

export type LifecycleState = {
  bundleKey: string | null;
  bundles: readonly LifecycleBundleState[];
  smoke: { preview: LifecycleSmokeEvidence; stg: LifecycleSmokeEvidence };
  signoff: { by: string; at: string } | null;
  /** the state machine's own verdicts — the actions enforce them first */
  actions: { createPreview: LifecycleAllow; smokePreview: LifecycleAllow; deployStg: LifecycleAllow; smokeStg: LifecycleAllow; signoff: LifecycleAllow };
};

// ── ports ─────────────────────────────────────────────────────────────────

/** GitHub, on the platform token. There is deliberately no merge here. */
export interface LifecycleRepos {
  /** head commit of a branch; null when the branch does not exist */
  headOf(repo: string, branch: string): Promise<string | null>;
  /** a file at a commit; null when absent */
  readFile(repo: string, sha: string, path: string): Promise<string | null>;
  /** does the pull request already carry a comment containing `marker` */
  hasComment(repo: string, pr: number, marker: string): Promise<boolean>;
  comment(repo: string, pr: number, body: string): Promise<{ url: string }>;
}

export type LifecycleQueued = { id: string; status: string; requestedBy: string; createdAt: string };
export type LifecycleEnqueue = { kind: "plan" | "cve"; params: Record<string, never> } | { kind: "smoke"; params: LifecycleSmokeParams };

/** The request queue plo-dispatch claims from (a database row, no kube write). */
export interface LifecycleQueue {
  /** the pending/claimed request of this kind, if any */
  findActive(kind: "plan" | "cve"): Promise<LifecycleQueued | null>;
  /** atomic: refuses (created: false) while an identical request is pending or claimed */
  enqueue(input: LifecycleEnqueue, requestedBy: string): Promise<{ created: true; id: string } | { created: false; existing: LifecycleQueued }>;
}

export type LifecycleDeps = EnvFromRepoDeps &
  PromoteDeps & {
    /** the preview state machine, read FRESH (never a cached read) */
    state: () => Promise<LifecycleState>;
    repos: LifecycleRepos;
    queue: LifecycleQueue;
    /** the same policy.yaml the gate enforces */
    policy: Policy;
    /** fallback API a bundled frontend is built against (NEBULA_STAGING_API_URL) */
    stagingApiUrl?: string | null;
    nebulaUrl?: string;
  };

// ── shared helpers ────────────────────────────────────────────────────────

/** sha256 over the sorted `owner/name@sha` lines (repository lower-cased).
 * The same digest as the reader's `bundleSetHash` for the same set. */
export function lifecycleSetHash(pairs: ReadonlyArray<{ repo: string; sha: string }>): string {
  const lines = pairs.map((p) => `${p.repo.toLowerCase()}@${p.sha}`).sort();
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}

const key12 = (bundleKey: string) => bundleKey.slice(0, 12);
const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

type Previewable = LifecycleBundleState & { headSha: string; service: string; envName: string };

function previewableOf(state: LifecycleState): Previewable[] {
  return state.bundles.filter((b): b is Previewable => b.previewable && !!b.headSha && !!b.service && !!b.envName);
}

/** The exact (repository, commit) set a preview is built from. */
export function previewSetHash(state: LifecycleState): string {
  return lifecycleSetHash(previewableOf(state).map((b) => ({ repo: b.github, sha: b.headSha })));
}

/** The state, or a refusal when the bundle the human is looking at is not the
 * bundle Nebula has now. */
async function stateFor(deps: Pick<LifecycleDeps, "state">, bundleKey: string): Promise<LifecycleState> {
  if (!LIFECYCLE_BUNDLE_KEY_RE.test(bundleKey)) refuse("bundleKey must be a sha256 hex digest");
  const state = await deps.state();
  if (!state.bundleKey) refuse("there is no bundle: no source run has reported one");
  if (state.bundleKey !== bundleKey) refuse(`the bundle changed: Nebula now has bundle ${key12(state.bundleKey!)}, not ${key12(bundleKey)} — reload and review it again`);
  return state;
}

function must(allow: LifecycleAllow): void {
  if (!allow.allowed) refuse(allow.reason);
}

/** The policy.yaml entry of the tool a reused action normally runs under,
 * evaluated for this call too — one lifecycle gate never widens what
 * `create_env_from_repo` or `promote_release` would allow by themselves. */
function alsoAllowedAs(policy: Policy, tool: string, fields: Record<string, string>, what: string): void {
  const d = evaluatePolicy(policy, tool, fields);
  if (!d.allowed) refuse(`${what}: policy (${tool}) refuses it — ${d.reason}`);
}

/** `https://<host>.twizz.com`, bare origin — or null. */
function twizzOrigin(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || !u.hostname.endsWith(".twizz.com") || (u.pathname !== "/" && u.pathname !== "") || u.search || u.hash || u.username || u.password) return null;
    return `https://${u.host}`;
  } catch {
    return null;
  }
}

const envOrigin = (name: string) => `https://${envHost(name)}`;

/** Every bundle branch must still be at the commit the snapshot recorded:
 * otherwise what was built, smoked or reviewed is not what the branch holds. */
async function assertHeads(repos: LifecycleRepos, bundles: ReadonlyArray<{ github: string; branch: string; headSha: string }>): Promise<void> {
  const heads = await Promise.all(bundles.map(async (b) => ({ b, head: await repos.headOf(b.github, b.branch) })));
  for (const { b, head } of heads) {
    if (!head) refuse(`${b.github}: branch ${b.branch} no longer exists — the bundle is gone; wait for the next source run`);
    if (head !== b.headSha) refuse(`${b.github}: ${b.branch} moved since the snapshot (${b.headSha.slice(0, 7)} -> ${head!.slice(0, 7)}); wait for the next source run to publish the new bundle`);
  }
}

// ── 1. lifecycle_request_run ──────────────────────────────────────────────

export const LIFECYCLE_RUN_KINDS = ["plan", "cve"] as const;
export type LifecycleRunKind = (typeof LIFECYCLE_RUN_KINDS)[number];

const alreadyQueued = (what: string, e: LifecycleQueued) => `${what} is already ${e.status} (requested by ${e.requestedBy} at ${e.createdAt}) — wait for it to finish`;

export async function planRequestRun(deps: Pick<LifecycleDeps, "queue">, input: { kind: LifecycleRunKind }): Promise<{ kind: LifecycleRunKind }> {
  if (!(LIFECYCLE_RUN_KINDS as readonly string[]).includes(input.kind)) refuse(`only ${LIFECYCLE_RUN_KINDS.join(" and ")} runs can be requested`);
  const active = await deps.queue.findActive(input.kind);
  if (active) refuse(alreadyQueued(`a ${input.kind} run`, active));
  return { kind: input.kind };
}

/** Queue an on-demand `plan` or `cve` run. The insert itself is the check:
 * the queue refuses while an identical request is pending or claimed. */
export async function requestLifecycleRun(deps: Pick<LifecycleDeps, "queue">, input: { kind: LifecycleRunKind; actor: string }) {
  await planRequestRun(deps, input);
  const r = await deps.queue.enqueue({ kind: input.kind, params: {} }, input.actor);
  if (!r.created) refuse(alreadyQueued(`a ${input.kind} run`, r.existing));
  return { requestId: (r as { id: string }).id, kind: input.kind, status: "pending" as const, note: "plo-dispatch claims pending requests every 5 minutes" };
}

// ── 2. lifecycle_create_preview ───────────────────────────────────────────

export type PreviewPlanItem = {
  envName: string;
  /** owner/name */
  repo: string;
  branch: string;
  sha: string;
  service: string;
  kind: EnvKind;
  db: DbMode;
  config: TwizzConfig;
  /** frontends only: the API the image is built against */
  attachUrl?: string;
  /** declared in twizz.yaml; created blank (set them on /environments) */
  secretNames: string[];
  expectedTag: string;
  url: string;
};

export type PreviewPlan = {
  bundleKey: string;
  setHash: string;
  /** envs this call would create, in creation order (backends first) */
  create: PreviewPlanItem[];
  /** bundled services that already have a preview env for this bundle */
  existing: Array<{ envName: string; service: string }>;
  /** bundled repositories Nebula cannot preview, with the reason */
  skipped: Array<{ github: string; reason: string }>;
  cap: { live: number; max: number };
};

/** The gate field naming exactly which envs a create would make. */
export const previewEnvsField = (plan: Pick<PreviewPlan, "create">) => plan.create.map((c) => c.envName).sort().join(" ");

const KIND_ORDER: Record<EnvKind, number> = { backend: 0, worker: 1, frontend: 2 };

export async function planPreview(deps: Pick<LifecycleDeps, "state" | "repos" | "gitops" | "policy" | "maxNamedEnvs" | "stagingApiUrl">, input: { bundleKey: string }): Promise<PreviewPlan> {
  const state = await stateFor(deps, input.bundleKey);
  must(state.actions.createPreview);
  const all = previewableOf(state);
  const missing = all.filter((b) => !b.env);
  if (missing.length === 0) refuse("every bundled service already has a preview env for this bundle");

  // the branch heads, re-read from GitHub: a moved head means the snapshot is stale
  for (const b of all) {
    if (!isValidRepo(b.github)) refuse(`${b.github} is not a twizz-app repository — Nebula builds previews only from the org`);
    if (!isValidBranch(b.branch) || !SHA_RE.test(b.headSha)) refuse(`${b.github}: the bundle branch or head sha is malformed`);
  }
  await assertHeads(deps.repos, all);

  const fallbackApi = twizzOrigin(deps.stagingApiUrl);
  const create: PreviewPlanItem[] = [];
  for (const b of missing) {
    const name = b.envName;
    if (!isValidName(name) || !name.startsWith(LIFECYCLE_ENV_PREFIX)) refuse(`"${name}" is not a valid preview env name for ${b.service}`);
    const svc = resolveService(b.github);
    if (svc.service !== b.service) refuse(`${b.github} resolves to service ${svc.service}, not ${b.service} — the registry mapping changed; reload`);
    const taken = await findEnv(deps, name);
    if (taken) {
      const src = taken.manifest.source;
      refuse(`env "${name}" already exists${src ? ` from ${src.repo}@${src.sha.slice(0, 7)}` : ""} (an earlier bundle of the same month, or someone's own env) — tear it down on /environments, then create the preview again`);
    }
    const text = await deps.repos.readFile(b.github, b.headSha, CONFIG_FILE);
    if (text === null) refuse(`${b.github}@${b.headSha.slice(0, 7)} has no ${CONFIG_FILE} — Nebula cannot build it; add one to the repository (docs/NEBULA.md §N3.7)`);
    const parsed = parseTwizzYaml(text!);
    if (!parsed.ok) refuse(`${b.github}@${b.headSha.slice(0, 7)} ${CONFIG_FILE} is invalid: ${parsed.issues.slice(0, 3).join("; ")}`);
    const config = (parsed as { config: TwizzConfig }).config;
    const dockerfile = `${config.context === "." ? "" : config.context.replace(/\/$/, "") + "/"}${config.dockerfile}`;
    if ((await deps.repos.readFile(b.github, b.headSha, dockerfile)) === null) refuse(`${b.github}@${b.headSha.slice(0, 7)} has no ${dockerfile} — nothing to build`);

    let attachUrl: string | undefined;
    if (config.kind === "frontend") {
      const peer = config.attach ? all.find((x) => x.service === config.attach!.backendService) : undefined;
      attachUrl = peer ? envOrigin(peer.env?.name ?? peer.envName) : (fallbackApi ?? undefined);
      if (!attachUrl) refuse(`${b.github} is a frontend and has no API to build against: name a bundled backend in ${CONFIG_FILE} (attach.backendService) or configure NEBULA_STAGING_API_URL`);
    }
    const db: DbMode = config.needs.mongo || svc.legacyBoot ? "isolated" : "none";
    alsoAllowedAs(
      deps.policy,
      "create_env_from_repo",
      { name, repo: b.github, ref: b.branch, sha: b.headSha, newBranch: "", kind: config.kind, service: svc.service, db, ttlHours: String(LIFECYCLE_PREVIEW_TTL_HOURS), attach: attachUrl ?? "" },
      `env ${name}`,
    );
    create.push({ envName: name, repo: b.github, branch: b.branch, sha: b.headSha, service: svc.service, kind: config.kind, db, config, ...(attachUrl ? { attachUrl } : {}), secretNames: [...config.secrets].sort(), expectedTag: nebulaTag(name, b.headSha), url: envOrigin(name) });
  }
  const names = new Set(create.map((c) => c.envName));
  if (names.size !== create.length) refuse("two bundled repositories map to the same preview env name");

  // all or nothing against the cap: never start a batch that cannot finish
  const live = await countEnvs(deps);
  const max = deps.maxNamedEnvs ?? DEFAULT_MAX_NAMED_ENVS;
  if (live + create.length > max) refuse(`named-env cap: this preview needs ${create.length} env${create.length === 1 ? "" : "s"} but only ${Math.max(0, max - live)} of ${max} are free (${live} live) — tear some down first; nothing was created`);

  create.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.envName.localeCompare(b.envName));
  return {
    bundleKey: input.bundleKey,
    setHash: previewSetHash(state),
    create,
    existing: all.filter((b) => b.env).map((b) => ({ envName: b.env!.name, service: b.service })),
    skipped: state.bundles.filter((b) => !b.previewable && !!b.headSha).map((b) => ({ github: b.github, reason: b.note ?? "no preview route in Nebula" })),
    cap: { live, max },
  };
}

/** A SecretStore that remembers which secrets THIS call created, so a failed
 * batch can be undone without ever touching an env it did not make. */
function recordingSecrets(inner: SecretStore): { store: SecretStore; created: string[] } {
  const created: string[] = [];
  const store: SecretStore = {
    getJson: (n) => inner.getJson(n),
    putJson: (n, v) => inner.putJson(n, v),
    deleteNow: (n) => inner.deleteNow(n),
    async createJson(n, v, tags) {
      await inner.createJson(n, v, tags);
      created.push(n);
    },
  };
  return { store, created };
}

/** Create the preview: one named env per bundled registry service that has
 * none yet, each through `createEnvFromRepo` (its own validation, the cap,
 * the secret, one gitops commit, the build dispatch). All or nothing: the
 * batch is refused up front when it cannot fit under the cap, and if a later
 * env still fails (a race, a dispatch error) the envs this call made are torn
 * down again. A second confirm for the same bundle is refused by the plan. */
export async function createLifecyclePreview(deps: LifecycleDeps, input: { bundleKey: string; setHash: string; envs: string; actor: string }) {
  const plan = await planPreview(deps, input);
  if (plan.setHash !== input.setHash || previewEnvsField(plan) !== input.envs) refuse("the bundle or its preview envs changed since you reviewed this — reload and review it again");

  const rec = recordingSecrets(deps.secrets);
  const envDeps: EnvFromRepoDeps = { ...deps, secrets: rec.store };
  const made: Array<{ name: string; url: string; service: string; kind: EnvKind; expectedTag: string; unsetSecrets: string[] }> = [];
  for (const item of plan.create) {
    try {
      const r = await createEnvFromRepo(envDeps, {
        name: item.envName,
        repo: item.repo,
        ref: item.branch,
        sha: item.sha,
        kind: item.kind,
        db: item.db,
        ttlHours: LIFECYCLE_PREVIEW_TTL_HOURS,
        config: item.config,
        envVars: {},
        attachUrl: item.attachUrl,
        actor: input.actor,
      });
      made.push({ name: r.name, url: r.url, service: r.service, kind: item.kind, expectedTag: r.expectedTag, unsetSecrets: item.secretNames });
    } catch (e) {
      // undo exactly what this call created (identified by the secrets it made)
      const undo: string[] = [];
      for (const c of plan.create) {
        const secret = envSecretName(c.service, c.envName);
        if (!rec.created.includes(secret)) continue;
        try {
          if (await findEnv(deps, c.envName)) await teardownNamedEnv(deps, { name: c.envName, actor: input.actor });
          else await deps.secrets.deleteNow(secret);
          undo.push(`${c.envName} removed`);
        } catch (u) {
          undo.push(`${c.envName} could NOT be removed (${errText(u)}) — tear it down on /environments`);
        }
      }
      throw new Error(`preview not created: ${item.envName} failed (${errText(e)}). ${undo.length ? `Rolled back: ${undo.join("; ")}.` : "Nothing had been created."}`);
    }
  }
  return {
    bundleKey: plan.bundleKey,
    key12: key12(plan.bundleKey),
    ttlHours: LIFECYCLE_PREVIEW_TTL_HOURS,
    created: made,
    existing: plan.existing,
    skipped: plan.skipped,
    note: "the build-watcher promotes each env when its image lands; run the preview smoke once every env is up",
  };
}

// ── 3. lifecycle_request_smoke ────────────────────────────────────────────

export type SmokePlan = { bundleKey: string; setHash: string; scope: LifecycleSmokeScope; targets: Array<{ name: string; baseUrl: string }> };

/** The gate field naming exactly what a smoke run would call. */
export const smokeTargetsField = (targets: ReadonlyArray<{ name: string; baseUrl: string }>) => targets.map((t) => `${t.name}=${t.baseUrl}`).sort().join(" ");

/** Targets come from two places only: the named envs of this bundle (preview)
 * or the fixed staging hosts of the release-train registry entries (stg).
 * A target's `name` is the registry service — PLO looks its checks up by it. */
export async function planSmoke(deps: Pick<LifecycleDeps, "state">, input: { scope: LifecycleSmokeScope; bundleKey: string }): Promise<SmokePlan> {
  if (input.scope !== "preview" && input.scope !== LIFECYCLE_STG) refuse("scope must be preview or stg");
  const state = await stateFor(deps, input.bundleKey);
  must(input.scope === "preview" ? state.actions.smokePreview : state.actions.smokeStg);
  const all = previewableOf(state);
  const targets: SmokePlan["targets"] = [];
  if (input.scope === "preview") {
    for (const b of all) {
      if (!b.env || !b.env.up) refuse(`${b.service}: its preview env is not up`);
      const name = b.env!.name;
      if (!isValidName(name) || !name.startsWith(LIFECYCLE_ENV_PREFIX)) refuse(`${b.service}: "${name}" is not a bundle preview env`);
      targets.push({ name: b.service, baseUrl: envOrigin(name) });
    }
  } else {
    for (const b of all.filter((x) => x.promotable)) {
      const t = releaseTarget(b.service, "staging");
      if (!t) refuse(`${b.service} has no staging target on the release train`);
      if (!b.staging?.deployed) refuse(`${b.service}: staging is not running this bundle`);
      targets.push({ name: b.service, baseUrl: `https://${t!.host}` });
    }
  }
  if (targets.length === 0) refuse(input.scope === "preview" ? "no bundled repository maps to a Nebula service" : "no bundled service has a staging route in Nebula");
  for (const t of targets) if (!LIFECYCLE_SMOKE_ORIGIN_RE.test(t.baseUrl)) refuse(`${t.name}: ${t.baseUrl} is not a preview-domain origin`);
  if (new Set(targets.map((t) => t.name)).size !== targets.length) refuse("two bundled repositories map to the same service");
  targets.sort((a, b) => a.name.localeCompare(b.name));
  return { bundleKey: input.bundleKey, setHash: previewSetHash(state), scope: input.scope, targets };
}

export async function requestLifecycleSmoke(deps: Pick<LifecycleDeps, "state" | "queue">, input: { scope: LifecycleSmokeScope; bundleKey: string; setHash: string; targets: string; actor: string }) {
  const plan = await planSmoke(deps, input);
  if (plan.setHash !== input.setHash || smokeTargetsField(plan.targets) !== input.targets) refuse("the bundle or its smoke targets changed since you reviewed this — reload and review it again");
  const r = await deps.queue.enqueue({ kind: "smoke", params: { scope: plan.scope, bundleKey: plan.bundleKey, targets: plan.targets } }, input.actor);
  if (!r.created) refuse(alreadyQueued(`a ${plan.scope} smoke for this bundle`, r.existing));
  return { requestId: (r as { id: string }).id, scope: plan.scope, bundleKey: plan.bundleKey, targets: plan.targets, status: "pending" as const, note: "plo-dispatch claims pending requests every 5 minutes" };
}

// ── smoke evidence ────────────────────────────────────────────────────────

/** "The smoke passed" for a write means more than a green verdict: the run
 * must have been queued against exactly these services at exactly these
 * origins, and every one of them must have at least one passing check (a
 * service with no checks configured was verified by nobody). Returns the
 * reason it does not hold, or null. */
export function smokeGap(ev: LifecycleSmokeEvidence, scope: LifecycleSmokeScope, expected: ReadonlyArray<{ service: string; origins: readonly string[] }>): string | null {
  const label = scope === "preview" ? "preview" : "staging";
  if (ev.verdict !== "pass" || !ev.request) return `the latest ${label} smoke for this bundle has not passed (${ev.detail})`;
  if (ev.results.some((r) => !r.ok)) return `the latest ${label} smoke for this bundle has failing checks`;
  for (const e of expected) {
    const target = ev.targets.find((t) => t.name === e.service);
    if (!target) return `the passing ${label} smoke did not cover ${e.service} — run the ${label} smoke again`;
    if (!e.origins.includes(target.baseUrl)) return `the passing ${label} smoke checked ${e.service} at ${target.baseUrl}, which is not where this bundle runs — run the ${label} smoke again`;
    const passed = ev.results.filter((r) => r.ok && r.name.startsWith(`${e.service}/`) && r.url.startsWith(`${target.baseUrl}/`));
    if (passed.length === 0) return `the ${label} smoke verified nothing for ${e.service} (no smoke checks are configured for it in the PLO inventory)`;
  }
  return null;
}

/** When a preview env became what it is now: the end of its build (the
 * moment the watcher made it deployable), else the start of it. */
function envBuiltAt(m: NamedEnvManifest): number | null {
  const t = Date.parse(m.build?.finishedAt ?? m.build?.startedAt ?? "");
  return Number.isFinite(t) ? t : null;
}

type PreviewEvidence = { manifests: Map<string, NamedEnvManifest> };

/** The preview smoke counts for this bundle only when it covers every bundled
 * service where its env runs AND was requested after each of those envs was
 * (re)built — a pass from before a rebuild or a recreate proves nothing about
 * what runs now. `mustExist` names the services whose env is needed anyway. */
async function assertPreviewSmoke(deps: Pick<LifecycleDeps, "gitops">, state: LifecycleState, mustExist: ReadonlySet<string>): Promise<PreviewEvidence> {
  const all = previewableOf(state);
  const ev = state.smoke.preview;
  const gap = smokeGap(ev, "preview", all.map((b) => ({ service: b.service, origins: [...new Set([envOrigin(b.envName), ...(b.env ? [envOrigin(b.env.name)] : [])])] })));
  if (gap) refuse(gap);
  const requestedAt = Date.parse(ev.request!.createdAt);
  if (!Number.isFinite(requestedAt)) refuse("the preview smoke request has no creation time");
  const manifests = new Map<string, NamedEnvManifest>();
  for (const b of all) {
    const needed = mustExist.has(b.service);
    if (!b.env) {
      if (needed) refuse(`${b.service}: its preview env is gone — create the preview and run the preview smoke again`);
      continue; // expired after it was smoked: the recorded pass stands
    }
    const found = await findEnv(deps, b.env.name);
    if (!found) {
      if (needed) refuse(`${b.service}: preview env ${b.env.name} no longer exists`);
      continue;
    }
    const m = found.manifest;
    if (!m.source || !sameRepo(m.source.repo, b.github) || m.source.sha !== b.headSha) refuse(`${b.env.name} is not built from ${b.github}@${b.headSha.slice(0, 7)} any more — create the preview again`);
    if (found.pending || !m.imageTag) refuse(`${b.env.name} is being (re)built — wait for it to come up, then run the preview smoke again`);
    const builtAt = envBuiltAt(m);
    if (builtAt === null) refuse(`${b.env.name} has no build record, so the smoke cannot be tied to it — create the preview again`);
    if (!(requestedAt > builtAt!)) refuse(`${b.env.name} was (re)built at ${new Date(builtAt!).toISOString()}, after the preview smoke was requested (${ev.request!.createdAt}) — run the preview smoke again`);
    manifests.set(b.service, m);
  }
  return { manifests };
}

// ── 4. lifecycle_deploy_stg ───────────────────────────────────────────────

export type DeployPlan = {
  bundleKey: string;
  setHash: string;
  promote: Array<{ service: string; envName: string; imageTag: string; from: string | null; host: string; valuesFile: string; argoApp: string }>;
  /** release-train services that need nothing: already promoted or already on the image */
  already: Array<{ service: string; reason: string; prNumber?: number; prUrl?: string }>;
  /** bundled repositories with no staging route in Nebula */
  noRoute: Array<{ github: string; service: string | null; note: string }>;
  smoke: { runId: string | null; finishedAt: string | null; checks: number };
};

/** The gate field naming exactly which image goes to which staging service. */
export const deployPromoteField = (plan: Pick<DeployPlan, "promote">) => plan.promote.map((p) => `${p.service}:${p.imageTag}`).sort().join(" ");

export async function planDeployStg(deps: Pick<LifecycleDeps, "state" | "gitops" | "images" | "promotions" | "policy">, input: { bundleKey: string }): Promise<DeployPlan> {
  const state = await stateFor(deps, input.bundleKey);
  must(state.actions.deployStg);
  const all = previewableOf(state);
  const train = all.filter((b) => b.promotable);
  if (train.length === 0) refuse(`no bundled service is on the release train: ${LIFECYCLE_NO_STAGING_ROUTE}`);
  const pending = train.filter((b) => !b.staging?.deployed && !b.staging?.promotion);
  const { manifests } = await assertPreviewSmoke(deps, state, new Set(pending.map((b) => b.service)));

  const promote: DeployPlan["promote"] = [];
  const already: DeployPlan["already"] = [];
  for (const b of train) {
    if (b.staging?.deployed) {
      already.push({ service: b.service, reason: "staging already runs this bundle" });
      continue;
    }
    if (b.staging?.promotion) {
      already.push({ service: b.service, reason: `promotion PR #${b.staging.promotion.number} is open — merge it on /releases`, prNumber: b.staging.promotion.number, prUrl: b.staging.promotion.url });
      continue;
    }
    const t = releaseTarget(b.service, "staging");
    if (!t) refuse(`${b.service} has no staging target on the release train`);
    const m = manifests.get(b.service)!;
    const tag = m.imageTag!;
    // the image staging gets is the one the preview env runs: built by the central builder from exactly this head
    if (tag !== nebulaTag(m.name, b.headSha) || !m.name.startsWith(LIFECYCLE_ENV_PREFIX) || !isPromotableTag(tag)) refuse(`${m.name} runs ${tag}, which is not the bundle image of ${b.github}@${b.headSha.slice(0, 7)}`);
    alsoAllowedAs(deps.policy, "promote_release", { service: b.service, target: "staging", imageTag: tag }, `promoting ${b.service}`);
    if (!(await deps.images.describeTag(t!.service.ecrRepo, tag))) refuse(`ECR ${t!.service.ecrRepo}:${tag} does not exist — only images that are already built can be promoted`);
    const now = await readTargetState(deps, b.service, "staging");
    if (!now.present) refuse(`${t!.valuesFile} does not exist in gitops — the staging target of ${b.service} is not bootstrapped`);
    if (now.imageTag === tag) {
      already.push({ service: b.service, reason: "gitops is already on this image; Argo CD has not confirmed the rollout yet" });
      continue;
    }
    promote.push({ service: b.service, envName: m.name, imageTag: tag, from: now.imageTag, host: t!.host, valuesFile: t!.valuesFile, argoApp: t!.argoApp });
  }
  if (promote.length === 0) refuse("every promotable service is already promoted or deployed for this bundle");
  promote.sort((a, b) => a.service.localeCompare(b.service));
  const ev = state.smoke.preview;
  return {
    bundleKey: input.bundleKey,
    setHash: previewSetHash(state),
    promote,
    already,
    noRoute: state.bundles.filter((b) => !!b.headSha && !(b.previewable && b.promotable)).map((b) => ({ github: b.github, service: b.service, note: LIFECYCLE_NO_STAGING_ROUTE })),
    smoke: { runId: ev.runId, finishedAt: ev.finishedAt, checks: ev.results.length },
  };
}

/** Open the staging promotion PR(s) through `promoteRelease` — its own checks
 * (release-train target, immutable tag, image in ECR, idempotent open PR)
 * apply unchanged. Nothing deploys here: merging each PR stays the existing
 * `merge_promotion` gate on /releases. A partial failure names what was
 * opened; running it again continues, because promoteRelease is idempotent. */
export async function deployLifecycleStg(deps: LifecycleDeps, input: { bundleKey: string; setHash: string; promote: string; actor: string }) {
  const plan = await planDeployStg(deps, input);
  if (plan.setHash !== input.setHash || deployPromoteField(plan) !== input.promote) refuse("the bundle or what would be promoted changed since you reviewed this — reload and review it again");
  const promotions: Array<{ service: string; imageTag: string; prNumber: number; prUrl: string; existing: boolean; host: string }> = [];
  for (const p of plan.promote) {
    try {
      const r = await promoteRelease(deps, { service: p.service, target: "staging", imageTag: p.imageTag, actor: input.actor });
      promotions.push({ service: r.service, imageTag: r.to, prNumber: r.prNumber, prUrl: r.prUrl, existing: r.existing, host: r.host });
    } catch (e) {
      const opened = promotions.map((x) => `${x.service} #${x.prNumber}`).join(", ");
      throw new Error(`promotion of ${p.service} failed (${errText(e)}). ${opened ? `Already opened: ${opened}.` : "No promotion PR was opened."} Run it again to continue; nothing deploys until a promotion PR is merged.`);
    }
  }
  return {
    bundleKey: plan.bundleKey,
    key12: key12(plan.bundleKey),
    promotions,
    already: plan.already,
    noRoute: plan.noRoute,
    note: "nothing is deployed yet: merge each promotion PR on /releases (merge_promotion); then run the staging smoke",
  };
}

// ── 5. lifecycle_signoff ──────────────────────────────────────────────────

export type SignoffPlan = {
  bundleKey: string;
  setHash: string;
  /** which smoke the sign-off rests on: stg, or preview when nothing bundled has a staging route */
  scope: LifecycleSmokeScope;
  /** binds the exact evidence, commit set and PR list the human confirms */
  evidenceHash: string;
  /** pull requests that get the sign-off comment */
  prs: LifecyclePr[];
  /** included PRs Nebula will not comment on, with the reason */
  skippedPrs: Array<{ repo: string; number: number; reason: string }>;
  commits: Array<{ github: string; branch: string; headSha: string }>;
  evidence: {
    preview: { runId: string | null; finishedAt: string | null; checks: number; origins: string[] } | null;
    stg: { runId: string | null; finishedAt: string | null; checks: number; origins: string[] } | null;
  };
};

export const signoffMarker = (bundleKey: string) => `<!-- nebula-lifecycle-signoff:${bundleKey} -->`;

export async function planSignoff(deps: Pick<LifecycleDeps, "state" | "repos" | "gitops">, input: { bundleKey: string }): Promise<SignoffPlan> {
  const state = await stateFor(deps, input.bundleKey);
  if (state.signoff) refuse(`this bundle is already signed off (by ${state.signoff.by} at ${state.signoff.at})`);
  must(state.actions.signoff);
  const all = previewableOf(state);
  if (all.length === 0) refuse("no bundled repository maps to a Nebula service, so there is nothing to sign off here");
  const train = all.filter((b) => b.promotable);
  const scope: LifecycleSmokeScope = train.length > 0 ? LIFECYCLE_STG : "preview";

  if (scope === LIFECYCLE_STG) {
    for (const b of train) if (!b.staging?.deployed) refuse(`${b.service}: staging is not running this bundle`);
    const gap = smokeGap(
      state.smoke.stg,
      LIFECYCLE_STG,
      train.map((b) => {
        const t = releaseTarget(b.service, "staging");
        if (!t) refuse(`${b.service} has no staging target on the release train`);
        return { service: b.service, origins: [`https://${t!.host}`] };
      }),
    );
    if (gap) refuse(gap);
  } else {
    await assertPreviewSmoke(deps, state, new Set());
  }

  // what is signed off is a set of commits: every bundle branch must still be there
  const commits = state.bundles.filter((b): b is LifecycleBundleState & { headSha: string } => !!b.headSha).map((b) => ({ github: b.github, branch: b.branch, headSha: b.headSha }));
  for (const c of commits) if (!isValidRepo(c.github) || !isValidBranch(c.branch) || !SHA_RE.test(c.headSha)) refuse(`${c.github}: the bundle names a repository, branch or commit Nebula cannot verify`);
  await assertHeads(deps.repos, commits);

  const prs: LifecyclePr[] = [];
  const skippedPrs: SignoffPlan["skippedPrs"] = [];
  const seen = new Set<string>();
  for (const b of state.bundles) {
    if (!b.headSha) continue;
    for (const pr of b.included) {
      const id = `${pr.repo.toLowerCase()}#${pr.number}`;
      if (seen.has(id)) continue;
      seen.add(id);
      if (!Number.isInteger(pr.number) || pr.number <= 0 || !sameRepo(pr.repo, b.github)) skippedPrs.push({ repo: pr.repo, number: pr.number, reason: "not a pull request of the bundled repository" });
      else if (prs.length >= MAX_SIGNOFF_PRS) skippedPrs.push({ repo: pr.repo, number: pr.number, reason: `more than ${MAX_SIGNOFF_PRS} pull requests in one bundle` });
      else prs.push({ repo: b.github, number: pr.number, url: `https://github.com/${b.github}/pull/${pr.number}` });
    }
  }
  // code-unit order on the lower-cased slug: the list feeds evidenceHash, so it must not depend on a locale
  const slug = (p: LifecyclePr) => p.repo.toLowerCase();
  prs.sort((a, b) => (slug(a) < slug(b) ? -1 : slug(a) > slug(b) ? 1 : a.number - b.number));

  const smokeOf = (ev: LifecycleSmokeEvidence) => (ev.verdict === "pass" ? { runId: ev.runId, finishedAt: ev.finishedAt, checks: ev.results.length, origins: ev.targets.map((t) => t.baseUrl).sort() } : null);
  const evidence = { preview: smokeOf(state.smoke.preview), stg: scope === LIFECYCLE_STG ? smokeOf(state.smoke.stg) : null };
  const evidenceHash = createHash("sha256")
    .update(
      JSON.stringify({
        scope,
        preview: state.smoke.preview.verdict === "pass" ? [state.smoke.preview.request?.id ?? null, state.smoke.preview.runId] : null,
        stg: scope === LIFECYCLE_STG ? [state.smoke.stg.request?.id ?? null, state.smoke.stg.runId] : null,
        commits: commits.map((c) => `${c.github.toLowerCase()}@${c.headSha}`).sort(),
        prs: prs.map((p) => `${p.repo.toLowerCase()}#${p.number}`),
      }),
      "utf8",
    )
    .digest("hex");
  return { bundleKey: input.bundleKey, setHash: previewSetHash(state), scope, evidenceHash, prs, skippedPrs, commits, evidence };
}

/** The comment left on each bundled pull request. Built from run ids, counts,
 * commit ids and origins Nebula derived itself — never from free text PLO or
 * a repository supplied. */
export function signoffCommentBody(o: { actor: string; plan: SignoffPlan; repo: string; nebulaUrl?: string }): string {
  const { plan } = o;
  const mine = plan.commits.find((c) => sameRepo(c.github, o.repo));
  const line = (label: string, e: SignoffPlan["evidence"]["preview"]) =>
    e ? [`- ${label} smoke: PASS, ${e.checks} check${e.checks === 1 ? "" : "s"}${e.runId ? `, run \`${e.runId}\`` : ""}${e.finishedAt ? `, finished ${e.finishedAt}` : ""}${e.origins.length ? ` — ${e.origins.join(", ")}` : ""}`] : [];
  return [
    `Signed off in Nebula by ${o.actor} for bundle ${key12(plan.bundleKey)}; preview + smoke evidence:`,
    "",
    ...(mine ? [`- This repository: \`${mine.branch}\` at \`${mine.headSha.slice(0, 12)}\``] : []),
    `- Bundle \`${plan.bundleKey}\`: ${plan.commits.length} repositor${plan.commits.length === 1 ? "y" : "ies"} (${plan.commits.map((c) => `${c.github}@${c.headSha.slice(0, 7)}`).join(", ")})`,
    ...line("Preview", plan.evidence.preview),
    ...line("Staging", plan.evidence.stg),
    ...(plan.scope === "preview" ? [`- Nothing in this bundle has a staging route in Nebula, so the sign-off rests on the preview smoke`] : []),
    `- Record: ${o.nebulaUrl ?? LIFECYCLE_NEBULA_URL}/lifecycle (the audit log holds the sign-off)`,
    "",
    "This is a record only. Nebula did not merge anything: merging this pull request stays a human action in GitHub.",
    "",
    signoffMarker(plan.bundleKey),
  ].join("\n");
}

/** The human gate. The sign-off itself is the AuditLog row the gate writes
 * when this returns; what happens here is the evidence check (again, inside
 * the gate) and one comment per bundled pull request, on the platform token.
 * It never merges: the port has no merge. A comment that cannot be posted is
 * reported in the result and does not undo the sign-off. */
export async function signoffLifecycle(deps: LifecycleDeps, input: { bundleKey: string; setHash: string; scope: string; evidenceHash: string; actor: string }) {
  const plan = await planSignoff(deps, input);
  if (plan.setHash !== input.setHash || plan.scope !== input.scope || plan.evidenceHash !== input.evidenceHash) refuse("the bundle or its smoke evidence changed since you reviewed this — reload and review it again");
  const marker = signoffMarker(plan.bundleKey);
  const comments: Array<{ repo: string; number: number; status: "posted" | "already" | "failed"; url?: string; error?: string }> = [];
  for (const pr of plan.prs) {
    try {
      if (await deps.repos.hasComment(pr.repo, pr.number, marker)) {
        comments.push({ repo: pr.repo, number: pr.number, status: "already" });
        continue;
      }
      const c = await deps.repos.comment(pr.repo, pr.number, signoffCommentBody({ actor: input.actor, plan, repo: pr.repo, nebulaUrl: deps.nebulaUrl }));
      comments.push({ repo: pr.repo, number: pr.number, status: "posted", url: c.url });
    } catch (e) {
      comments.push({ repo: pr.repo, number: pr.number, status: "failed", error: errText(e).slice(0, 200) });
    }
  }
  return {
    bundleKey: plan.bundleKey,
    key12: key12(plan.bundleKey),
    signedOffBy: input.actor,
    scope: plan.scope,
    evidenceHash: plan.evidenceHash,
    evidence: plan.evidence,
    commits: plan.commits.map((c) => `${c.github}@${c.headSha.slice(0, 12)}`),
    comments,
    skippedPrs: plan.skippedPrs,
    merged: false as const,
    note: "recorded in the audit log; no pull request was merged — merging stays a human action in GitHub",
  };
}
