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
  readCurrentTier,
  type CapacityTarget,
  type CurrentTier,
  atlasMonthly,
  isProdAtlasCluster,
  prodAtlasOptions,
  GITOPS,
} from "@twizz-idp/actions";
import type { Octokit } from "@octokit/rest";
import { ATLAS_TIERS, type AtlasSize, type AtlasTier, type CapacityTier } from "@twizz-idp/shared";
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
export async function liveTemplateOpts(tier: LiveTier, input: { preset?: string; custom?: unknown; estimate?: { rps: number } }): Promise<LivePlanOpts> {
  if (input.custom || (!input.preset && !input.estimate)) return {};
  const presets = await loadPresets(namedEnvDeps().promotions);
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

// ── provenance of the capacity files (Codex review 2026-11-06) ─────────────
// twizz-gitops is a private personal repo: GitHub offers no branch protection or
// rulesets there, and `main` also takes Nebula's own direct commits (named envs).
// So Nebula enforces it: a PRODUCTION capacity write needs the latest commit to each
// capacity file it relies on to come from a PR merged by a capacity owner
// (NEBULA_CAPACITY_OWNERS, default the platform owner). Fail closed.
export const CAPACITY_OWNERS = () =>
  (process.env.NEBULA_CAPACITY_OWNERS || "twizzynicky")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

export type Provenance = { path: string; ok: boolean; sha?: string; pr?: number; mergedBy?: string; reason?: string };
const provenanceCache = new Map<string, { at: number; v: Provenance }>();

export async function capacityFileProvenance(path: string, gh: Octokit = octokit()): Promise<Provenance> {
  const hit = provenanceCache.get(path);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.v;
  let v: Provenance;
  try {
    const { owner, repo, branch } = GITOPS;
    const commits = await gh.repos.listCommits({ owner, repo, sha: branch, path, per_page: 1 });
    const sha = commits.data[0]?.sha;
    if (!sha) v = { path, ok: false, reason: `${path} has no commits on ${branch}` };
    else {
      const pulls = await gh.repos.listPullRequestsAssociatedWithCommit({ owner, repo, commit_sha: sha });
      const merged = pulls.data.find((p) => p.merged_at && p.base.ref === branch);
      if (!merged) v = { path, ok: false, sha, reason: `the last change to ${path} (${sha.slice(0, 7)}) was pushed directly, not merged through a PR` };
      else {
        const full = await gh.pulls.get({ owner, repo, pull_number: merged.number });
        const by = full.data.merged_by?.login?.toLowerCase();
        v = by && CAPACITY_OWNERS().includes(by) ? { path, ok: true, sha, pr: merged.number, mergedBy: by } : { path, ok: false, sha, pr: merged.number, mergedBy: by, reason: `${path} was last changed by PR #${merged.number}, merged by ${by ?? "unknown"} — not a capacity owner (${CAPACITY_OWNERS().join(", ")})` };
      }
    }
  } catch (e) {
    v = { path, ok: false, reason: `could not verify ${path} on GitHub: ${errMsg(e)}` };
  }
  provenanceCache.set(path, { at: Date.now(), v });
  return v;
}

/** Throws unless every file was last changed by an owner-merged PR. */
export async function requireReviewedCapacityFiles(paths: string[]): Promise<Provenance[]> {
  const all = await Promise.all(paths.map((p) => capacityFileProvenance(p)));
  const bad = all.filter((p) => !p.ok);
  if (bad.length) throw new Error(`refused: production capacity relies on files that are not owner-reviewed — ${bad.map((b) => b.reason).join("; ")}`);
  return all;
}
