// Capacity page wiring (docs/NEBULA.md §N5): presets/profiles from gitops,
// the Atlas tier, and what is actually running — kube for NonProd,
// CloudWatch Container Insights for staging/prod (no kube path there).
import { awsService, atlasTierService, prodAtlasTierService } from "@twizz-idp/core";
import {
  LIVE_TARGETS,
  type LiveState,
  type LiveTier,
  AtlasTierAdapter,
  capacityTarget,
  loadPresets,
  loadProfiles,
  readCurrentTier,
  type CapacityTarget,
  type CurrentTier,
} from "@twizz-idp/actions";
import type { AtlasSize, CapacityTier } from "@twizz-idp/shared";
import { namedEnvDeps } from "./deps";
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
export async function readLive(tier: LiveTier): Promise<{ state: LiveState } | { error: string }> {
  try {
    return { state: await liveClusterPort(LIVE_TARGETS[tier]).read() };
  } catch (e) {
    return { error: errMsg(e) };
  }
}

/** Prod Atlas clusters (moly-prod, prod-shift4, …) from the prod Atlas account. Read-only. */
export async function readProdAtlas(): Promise<{ clusters: Array<{ name: string; state: string; instanceSize: string; autoScaling?: { min: string; max: string } }> } | { error: string }> {
  const svc = prodAtlasTierService();
  if (!svc) return { error: "prod Atlas key not configured (ATLAS_PROD_PUBLIC_KEY / _PRIVATE_KEY / _PROJECT_ID in SM preview/nebula)" };
  try {
    return { clusters: await svc.listClusterTiers() };
  } catch (e) {
    return { error: errMsg(e) };
  }
}
