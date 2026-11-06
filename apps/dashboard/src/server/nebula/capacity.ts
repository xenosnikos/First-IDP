// Capacity page wiring (docs/NEBULA.md §N5): presets/profiles from gitops,
// the Atlas tier, and what is actually running — kube for NonProd,
// CloudWatch Container Insights for staging/prod (no kube path there).
import { awsService, atlasTierService, prodAtlasTierService } from "@twizz-idp/core";
import {
  BASELINE_TEMPLATE,
  LIVE_TARGETS,
  type LivePlanOpts,
  type LiveState,
  type LiveTier,
  AtlasTierAdapter,
  capacityTarget,
  loadPresets,
  loadProfiles,
  parsePresets,
  parseProfiles,
  readCurrentTier,
  type CapacityTarget,
  type CurrentTier,
  atlasMonthly,
  isProdAtlasCluster,
  prodAtlasOptions,
  GITOPS,
} from "@twizz-idp/actions";
import type { Octokit } from "@octokit/rest";
import { ATLAS_TIERS, type AtlasSize, type AtlasTier, type CapacityPreset, type CapacityTier } from "@twizz-idp/shared";
import { namedEnvDeps, octokit } from "./deps";
import { readCapacityKube, readClusterSnapshot } from "./kube";
import { liveClusterPort } from "./live-cluster";

const errMsg = (e: unknown) => String((e as Error)?.message ?? e);

/** Staging/prod Atlas clusters are read (never written) only when linked by env. */
export function targetFor(tier: CapacityTier): CapacityTarget {
  const linked = tier === "staging" ? process.env.NEBULA_ATLAS_CLUSTER_STAGING : tier === "production" ? process.env.NEBULA_ATLAS_CLUSTER_PRODUCTION : undefined;
  return capacityTarget(tier, linked || null);
}

export function atlasPort() {
  return new AtlasTierAdapter(atlasTierService);
}

export async function readAtlas(t: CapacityTarget): Promise<{ size: (AtlasSize & { state: string }) | null; error?: string }> {
  if (!t.atlas.cluster) return { size: null, error: "no Atlas cluster linked to this tier" };
  if (!process.env.ATLAS_PUBLIC_KEY) return { size: null, error: "Atlas API keys not configured on the Nebula server" };
  try {
    return { size: await atlasPort().getTier(t.atlas.cluster) };
  } catch (e) {
    return { size: null, error: errMsg(e) };
  }
}

/** Gitops sizes + the Atlas tier: the "before" side of every plan. */
export async function currentFor(tier: CapacityTier): Promise<{ t: CapacityTarget; current: CurrentTier; atlasError?: string }> {
  const t = targetFor(tier);
  const atlas = await readAtlas(t);
  const current = await readCurrentTier(namedEnvDeps().promotions, t, atlas.size ? { instanceSize: atlas.size.instanceSize, autoScaling: atlas.size.autoScaling } : null);
  return { t, current, atlasError: atlas.error };
}

export async function presetsAndProfiles() {
  const repo = namedEnvDeps().promotions;
  const [presets, profiles] = await Promise.all([
    loadPresets(repo).then((v) => ({ v }), (e) => ({ error: errMsg(e) })),
    loadProfiles(repo).then((v) => ({ v }), (e) => ({ error: errMsg(e) })),
  ]);
  return {
    presets: "v" in presets ? presets.v : [],
    presetsError: "error" in presets ? presets.error : undefined,
    profiles: "v" in profiles ? profiles.v : null,
    profilesError: "error" in profiles ? profiles.error : undefined,
  };
}

export type ObservedService = { service: string; namespace: string; pods: number; running: number; cpuUtil?: number; memUtil?: number; hpa?: { min: number; max: number; current: number; desired: number } };

/** vCPU the managed NonProd pool runs right now (undefined = unknown). */
export async function nodePoolUsedCpu(): Promise<number | undefined> {
  const kube = await readCapacityKube();
  const used = kube.nodePools.find((p) => p.name === "spot")?.usedCpu;
  return used === undefined ? undefined : Number(used.endsWith("m") ? Number(used.slice(0, -1)) / 1000 : used);
}

/** What is running right now. Never throws: unknown is reported as unknown.
 * NonProd has no Container Insights: its pods/nodes come from the kube API. */
export async function observe(t: CapacityTarget) {
  if (t.tier === "preview") return observeKube(t);
  const [pods, nodes] = await Promise.all([
    awsService.getLivePods(t.cluster).then((v) => ({ v }), (e) => ({ error: errMsg(e) })),
    awsService.getNodeMetrics(t.cluster).then((v) => ({ v }), (e) => ({ error: errMsg(e) })),
  ]);
  const podList = "v" in pods ? pods.v : [];
  const avg = (xs: Array<number | undefined>) => {
    const ns = xs.filter((x): x is number => typeof x === "number");
    return ns.length ? Math.round((ns.reduce((a, b) => a + b, 0) / ns.length) * 10) / 10 : undefined;
  };
  const services: ObservedService[] = t.services.map((s) => {
    const mine = podList.filter((p) => p.namespace === s.namespace && p.podName.startsWith(`${s.workload}-`));
    return {
      service: s.name,
      namespace: s.namespace,
      pods: mine.length,
      running: mine.filter((p) => p.status === "Running").length,
      cpuUtil: avg(mine.map((p) => p.cpuUtil)),
      memUtil: avg(mine.map((p) => p.memUtil)),
    };
  });
  const nodeList = "v" in nodes ? nodes.v : [];
  return {
    podsError: "error" in pods ? pods.error : undefined,
    services,
    nodes: {
      count: nodeList.length,
      cpuUtil: avg(nodeList.map((n) => n.cpu)),
      memUtil: avg(nodeList.map((n) => n.mem)),
      error: "error" in nodes ? nodes.error : undefined,
      // staging/prod: no kube path (CloudWatch only)
      vcpu: undefined as number | undefined,
      pools: [] as Awaited<ReturnType<typeof readCapacityKube>>["nodePools"],
      kubeError: undefined as string | undefined,
    },
  };
}

async function observeKube(t: CapacityTarget) {
  const [snap, kube] = await Promise.all([readClusterSnapshot(), readCapacityKube()]);
  const services: ObservedService[] = t.services.map((s) => {
    const d = snap.deployments.find((x) => x.namespace === s.namespace && x.name === s.workload);
    const hpa = kube.hpas.find((h) => h.namespace === s.namespace && h.name === s.workload);
    return {
      service: s.name,
      namespace: s.namespace,
      pods: d?.desired ?? 0,
      running: d?.ready ?? 0,
      hpa: hpa ? { min: hpa.min, max: hpa.max, current: hpa.current, desired: hpa.desired } : undefined,
    };
  });
  return {
    podsError: snap.reachable ? undefined : `kube: ${snap.reason}`,
    services,
    nodes: {
      count: kube.nodes.length,
      cpuUtil: undefined as number | undefined,
      memUtil: undefined as number | undefined,
      error: kube.reachable ? undefined : kube.reason,
      vcpu: kube.reachable ? kube.nodes.reduce((a, n) => a + n.cpu, 0) : undefined,
      pools: kube.nodePools,
      kubeError: kube.reason,
    },
  };
}

/** Live state of a Moly cluster (staging ns default/jobs, prod). Never throws. */
/** How a live plan is checked (§N5.2). A NAMED template is planned as a
 * template, floored by the tier's `baseline` template (read from gitops, never
 * from the client); a hand edit (`custom`, or no preset) gets the normal rules.
 * The plan query and the apply mutation both call this, so their hashes agree. */
export async function liveTemplateOpts(tier: LiveTier, input: { preset?: string; custom?: unknown; estimate?: { rps: number } }, pinnedPresets?: CapacityPreset[]): Promise<LivePlanOpts> {
  if (input.custom || (!input.preset && !input.estimate)) return {};
  const presets = pinnedPresets ?? (await loadPresets(namedEnvDeps().promotions));
  const floor = presets.find((p) => p.name === BASELINE_TEMPLATE)?.tiers[tier]?.live;
  if (input.estimate) {
    // a traffic estimate: floored by baseline (REQUIRED — fail closed without it), but it keeps
    // the ×0.5 / one-node step-down guards; only reviewed named templates may drop in one apply
    if (!floor) throw new Error(`no "${BASELINE_TEMPLATE}" template with a ${tier} live section: traffic estimates need it as their floor`);
    return { template: { name: `estimate-${Math.round(input.estimate.rps)}`, floor, liftStepDown: false } };
  }
  return { template: { name: input.preset!, ...(floor ? { floor } : {}) } };
}

export async function readLive(tier: LiveTier): Promise<{ state: LiveState } | { error: string }> {
  try {
    return { state: await liveClusterPort(LIVE_TARGETS[tier]).read() };
  } catch (e) {
    return { error: errMsg(e) };
  }
}

/** The prod Atlas account (ATLAS_PROD_*) as an AtlasClusters port; null = key not configured. */
export function prodAtlasPort(): AtlasTierAdapter | null {
  const svc = prodAtlasTierService();
  return svc ? new AtlasTierAdapter(svc) : null;
}

type ProdAtlasRow = { name: string; state: string; instanceSize: string; autoScaling?: { min: string; max: string }; resizable: boolean; options: AtlasTier[]; monthly?: number };

/** Prod Atlas clusters (Moly-Prod, Prod-Shift4) from the prod Atlas account,
 * with the tiers one gated change may move each to (§N5.3). */
export async function readProdAtlas(): Promise<{ clusters: ProdAtlasRow[] } | { error: string }> {
  const svc = prodAtlasTierService();
  if (!svc) return { error: "prod Atlas key not configured (ATLAS_PROD_PUBLIC_KEY / _PRIVATE_KEY / _PROJECT_ID in SM preview/nebula)" };
  try {
    const rows = await svc.listClusterTiers();
    return {
      clusters: rows.map((c) => {
        const tier = (ATLAS_TIERS as readonly string[]).includes(c.instanceSize) ? (c.instanceSize as AtlasTier) : null;
        const known = (x: string) => (ATLAS_TIERS as readonly string[]).includes(x);
        const resizable = !!tier && isProdAtlasCluster(c.name) && (!c.autoScaling || (known(c.autoScaling.min) && known(c.autoScaling.max)));
        return { ...c, resizable, options: resizable && tier ? prodAtlasOptions(tier) : [], monthly: tier ? atlasMonthly(tier) : undefined };
      }),
    };
  } catch (e) {
    return { error: errMsg(e) };
  }
}

// ── provenance of the capacity files (Codex reviews 2026-11-06) ─────────────
// twizz-gitops is a private personal repo: GitHub offers no branch protection or
// rulesets there, and `main` also takes Nebula's own direct commits (named envs).
// So Nebula enforces it, against ONE pinned commit:
//   1. H = the head of main now;
//   2. per file, C = the last commit touching it as of H;
//   3. C must be PROVEN to come from a PR merged into THIS repo's main by a capacity
//      owner: C is that PR's merge commit (squash/rebase), or one of the PR's own commits;
//   4. the file is read AT H — the bytes sized from are the bytes that were proven.
// Cached by (H, path). Fails closed on any doubt.
export const CAPACITY_OWNERS = () =>
  (process.env.NEBULA_CAPACITY_OWNERS || "twizzynicky")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

export type Provenance = { path: string; ok: boolean; commit?: string; pr?: number; mergedBy?: string; reason?: string };
const provenanceCache = new Map<string, Provenance>();

/** Blob sha of `path` at `ref`, or null if the file isn't there. */
async function blobAt(gh: Octokit, path: string, ref: string): Promise<string | null> {
  const { owner, repo } = GITOPS;
  try {
    const { data } = await gh.repos.getContent({ owner, repo, path, ref });
    return Array.isArray(data) || data.type !== "file" ? null : data.sha;
  } catch (e) {
    if ((e as { status?: number }).status === 404) return null;
    throw e;
  }
}

/** Proof that the bytes of `path` at H were INTRODUCED by a PR an owner merged into this repo's
 * main (Codex reviews): for a candidate PR (associated with C, the last commit touching the path
 * as of H), with merge commit M:
 *   - M is on main's history up to H (M is H or an ancestor of H),
 *   - the file's blob at M equals its blob at H (nothing changed it after the merge), and
 *   - the blob at M's first parent differs (THIS merge brought the change, not an earlier one).
 * Commit-list membership alone is not accepted (a stacked PR can contain an older commit). */
async function provePrOrigin(gh: Octokit, path: string, c: string, head: string): Promise<{ ok: true; pr: number; mergedBy: string } | { ok: false; reason: string }> {
  const { owner, repo, branch } = GITOPS;
  const fullName = `${owner}/${repo}`.toLowerCase();
  const pulls = await gh.repos.listPullRequestsAssociatedWithCommit({ owner, repo, commit_sha: c });
  const candidates = pulls.data.filter((p) => p.merged_at && p.base.ref === branch && p.base.repo?.full_name?.toLowerCase() === fullName);
  if (!candidates.length) return { ok: false, reason: `commit ${c.slice(0, 7)} was pushed directly, not merged through a PR into ${fullName}:${branch}` };
  const owners = CAPACITY_OWNERS();
  const atHead = await blobAt(gh, path, head);
  for (const p of candidates) {
    const full = (await gh.pulls.get({ owner, repo, pull_number: p.number })).data;
    const by = full.merged_by?.login?.toLowerCase();
    const m = full.merge_commit_sha;
    if (!by || !owners.includes(by) || !m) continue;
    const cmp = await gh.repos.compareCommitsWithBasehead({ owner, repo, basehead: `${m}...${head}` });
    if (cmp.data.status !== "ahead" && cmp.data.status !== "identical") continue; // M not on H's history
    const [atM, parents] = await Promise.all([blobAt(gh, path, m), gh.git.getCommit({ owner, repo, commit_sha: m }).then((r) => r.data.parents)]);
    if (!atM || atM !== atHead) continue; // changed after this merge
    const before = parents[0] ? await blobAt(gh, path, parents[0].sha) : null;
    if (before === atM) continue; // this merge didn't change the file
    return { ok: true, pr: p.number, mergedBy: by };
  }
  return { ok: false, reason: `${path} at ${head.slice(0, 7)} was not introduced by a PR a capacity owner (${owners.join(", ")}) merged into ${branch}` };
}

export async function capacityFileProvenance(path: string, head: string, gh: Octokit = octokit()): Promise<Provenance> {
  const key = `${head}:${path}`;
  const hit = provenanceCache.get(key);
  if (hit) return hit;
  let v: Provenance;
  try {
    const { owner, repo } = GITOPS;
    const commits = await gh.repos.listCommits({ owner, repo, sha: head, path, per_page: 1 });
    const commit = commits.data[0]?.sha;
    if (!commit) v = { path, ok: false, reason: `${path} has no history as of ${head.slice(0, 7)}` };
    else {
      const proof = await provePrOrigin(gh, path, commit, head);
      v = proof.ok ? { path, ok: true, commit, pr: proof.pr, mergedBy: proof.mergedBy } : { path, ok: false, commit, reason: `${path}: ${proof.reason}` };
    }
  } catch (e) {
    v = { path, ok: false, reason: `could not verify ${path} on GitHub: ${errMsg(e)}` };
  }
  if (v.ok) {
    if (provenanceCache.size > 200) provenanceCache.clear();
    provenanceCache.set(key, v); // only proofs are cached; doubts are re-checked
  }
  return v;
}

export type PinnedCapacity = { head: string; files: Record<string, { content: string; blob: string; provenance: Provenance }> };

/** Pin main, prove every file at that commit, and return their bytes AT that commit.
 * Throws (fail closed) unless every file is proven. */
export async function pinReviewedCapacity(paths: string[], gh: Octokit = octokit()): Promise<PinnedCapacity> {
  const { owner, repo, branch } = GITOPS;
  const head = (await gh.git.getRef({ owner, repo, ref: `heads/${branch}` })).data.object.sha;
  const files: PinnedCapacity["files"] = {};
  const bad: string[] = [];
  for (const path of paths) {
    const provenance = await capacityFileProvenance(path, head, gh);
    if (!provenance.ok) {
      bad.push(provenance.reason ?? path);
      continue;
    }
    const { data } = await gh.repos.getContent({ owner, repo, path, ref: head });
    if (Array.isArray(data) || data.type !== "file") {
      bad.push(`${path} is not a file at ${head.slice(0, 7)}`);
      continue;
    }
    files[path] = { content: Buffer.from(data.content, "base64").toString("utf8"), blob: data.sha, provenance };
  }
  if (bad.length) throw new Error(`refused: production capacity relies on files that are not owner-reviewed — ${bad.join("; ")}`);
  return { head, files };
}

/** Presets + profiles parsed from a pin (what a production apply sizes from). */
export function capacitySourcesFrom(pin: PinnedCapacity) {
  const pre = pin.files["capacity/presets.yaml"];
  const pro = pin.files["capacity/profiles.yaml"];
  return { presets: pre ? parsePresets(pre.content) : [], profiles: pro ? parseProfiles(pro.content) : null };
}
export type CapacitySources = ReturnType<typeof capacitySourcesFrom>;
