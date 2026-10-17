// Capacity templates (docs/NEBULA.md §N5): size pods, nodes and the Atlas
// tier ahead of expected traffic, from named presets or a traffic estimate.
//
//   apply_capacity_preset → ONE PR on TwizzyNicky/twizz-gitops rewriting the
//                           tier's values files (+ NonProd NodePool/warm pods)
//   merge_capacity_pr     → sha-guarded squash merge; Argo CD rolls it out
//   set_atlas_tier        → Atlas Admin API, NonProd cluster only
//
// Prod is a config PANE: planned and exported, never written (no target is
// writable, and `production` trips policy.yaml's global `*prod*` deny anyway).
// EKS-Moly-staging nodes are observe-only (Argo is namespace-scoped there).
import { createHash } from "node:crypto";
import { parse, parseDocument, isMap, stringify } from "yaml";
import {
  ATLAS_TIERS,
  CapacityPresetsFile,
  CapacityProfilesFile,
  cpuToCores,
  memToGi,
  type AtlasSize,
  type AtlasTier,
  type CapacityPreset,
  type CapacityTier,
  type EstimateInput,
  type NodeSize,
  type ServiceSize,
  type TierProfile,
  type TierSize,
} from "@twizz-idp/shared";
import { GITOPS } from "./named-envs";
import type { PromotionPr, PromotionRepo } from "./promote";
import { releaseTarget } from "./registry";
import { ATLAS_LIMITS, ATLAS_PRICE, EC2_PRICE, HOURS_PER_MONTH } from "./capacity-prices";

export const PRESETS_FILE = "capacity/presets.yaml";
export const PROFILES_FILE = "capacity/profiles.yaml";
export const NODEPOOL_FILE = "clusters/nonprod/capacity/nodepool-spot.yaml";
export const WARM_FILE = "clusters/nonprod/capacity/warm-capacity.yaml";
export const CAPACITY_BRANCH_PREFIX = "capacity/";

// ── targets: what each tier's sizes land on ────────────────────────────

export type CapacityServiceTarget = {
  name: string;
  namespace: string;
  /** Deployment name, or the pod-name prefix CloudWatch reports. */
  workload: string;
  /** twizz-gitops values file — absent = observe/plan only. */
  valuesFile?: string;
};

export type CapacityTarget = {
  tier: CapacityTier;
  cluster: string;
  /** Nebula may open capacity PRs for this tier. */
  writable: boolean;
  services: CapacityServiceTarget[];
  /** Nebula-managed node pool files (NonProd only). */
  nodes?: { nodePoolFile: string; warmFile: string };
  /** Atlas cluster name (null = not linked); writes only where `writable`. */
  atlas: { cluster: string | null; writable: boolean };
  pricing: keyof typeof EC2_PRICE;
  /** The cluster can run CPU HPAs (metrics-server present). Without it an HPA
   * pins replicas to minReplicas and never scales — refused, not silently kept. */
  hpa: boolean;
  caps: { maxReplicas: number; maxNodeCpu: number; maxAtlas: AtlasTier };
};

const stagingValues = (svc: string) => releaseTarget(svc, "staging")?.valuesFile;

export const CAPACITY_TARGETS: Record<CapacityTier, CapacityTarget> = {
  preview: {
    tier: "preview",
    cluster: "EKS-Twizz-NonProd",
    writable: true,
    // The shared singletons every preview talks to (bootstrap/shared-services.yaml).
    // Per-preview base values (apps/<svc>/values.yaml) are NOT sized here.
    services: ["ffmpeg-service", "lolygram-discovery", "alertservice"].map((name) => ({ name, namespace: "shared", workload: name, valuesFile: `apps/shared/${name}.yaml` })),
    nodes: { nodePoolFile: NODEPOOL_FILE, warmFile: WARM_FILE },
    atlas: { cluster: "NonProd-Twizz", writable: true },
    pricing: "spot",
    // no metrics-server on EKS-Twizz-NonProd (verified 2026-10-14): fixed replicas only
    hpa: false,
    caps: { maxReplicas: 6, maxNodeCpu: 256, maxAtlas: "M40" },
  },
  staging: {
    tier: "staging",
    cluster: "EKS-Moly-staging",
    writable: true,
    services: [
      // The release-train apps in ns `sentinel` — the only staging namespace Nebula deploys to.
      { name: "twizz-sentinel", namespace: "sentinel", workload: "twizz-sentinel", valuesFile: stagingValues("twizz-sentinel") },
      { name: "twizz-admin", namespace: "sentinel", workload: "twizz-admin", valuesFile: stagingValues("twizz-admin") },
    ],
    // staging's MONGO_URI points at the NonProd Atlas cluster (shared with
    // previews): shown here, resized only from the NonProd tier
    atlas: { cluster: "NonProd-Twizz", writable: false },
    pricing: "onDemand",
    hpa: true,
    caps: { maxReplicas: 10, maxNodeCpu: 0, maxAtlas: "M60" },
  },
  production: {
    tier: "production",
    cluster: "EKS-Moly-Prod",
    writable: false,
    // workloads + node groups are sized LIVE (live-capacity.ts, LIVE_TARGETS.production)
    services: [],
    atlas: { cluster: null, writable: false },
    pricing: "onDemand",
    hpa: true,
    caps: { maxReplicas: 200, maxNodeCpu: 2048, maxAtlas: "M200" },
  },
};

export function capacityTarget(tier: CapacityTier, atlasCluster?: string | null): CapacityTarget {
  const t = CAPACITY_TARGETS[tier];
  return atlasCluster && !t.atlas.writable ? { ...t, atlas: { cluster: atlasCluster, writable: false } } : t;
}

// ── preset + profile files ─────────────────────────────────────────────

export function parsePresets(yamlText: string): CapacityPreset[] {
  return CapacityPresetsFile.parse(parse(yamlText)).presets;
}

export function parseProfiles(yamlText: string): CapacityProfilesFile {
  return CapacityProfilesFile.parse(parse(yamlText));
}

export async function loadPresets(repo: Pick<PromotionRepo, "readFile">): Promise<CapacityPreset[]> {
  const f = await repo.readFile(PRESETS_FILE);
  if (!f) throw new Error(`${GITOPS.owner}/${GITOPS.repo}:${PRESETS_FILE} does not exist — capacity presets are not bootstrapped`);
  return parsePresets(f.content);
}

export async function loadProfiles(repo: Pick<PromotionRepo, "readFile">): Promise<CapacityProfilesFile> {
  const f = await repo.readFile(PROFILES_FILE);
  if (!f) throw new Error(`${GITOPS.owner}/${GITOPS.repo}:${PROFILES_FILE} does not exist — calculator profiles are not bootstrapped`);
  return parseProfiles(f.content);
}

// ── values-file surgery (comments preserved, like bumpImageTag) ────────

function str(v: unknown): string | undefined {
  return v === undefined || v === null ? undefined : String(v);
}

/** The sizing a chart values file declares; null when it has none. */
export function readServiceSize(valuesYaml: string): ServiceSize | null {
  const v = parse(valuesYaml) as Record<string, any> | null;
  if (!v || typeof v !== "object") return null;
  const req = v.resources?.requests ?? {};
  const lim = v.resources?.limits ?? {};
  if (!req.cpu || !req.memory || !lim.cpu || !lim.memory) return null;
  const a = v.autoscaling;
  return {
    replicas: typeof v.replicaCount === "number" ? v.replicaCount : 1,
    requests: { cpu: str(req.cpu)!, memory: str(req.memory)! },
    limits: { cpu: str(lim.cpu)!, memory: str(lim.memory)! },
    autoscaling: a?.enabled
      ? // missing keys fall back to the twizz-service chart defaults (charts/twizz-service/values.yaml)
        { enabled: true, minReplicas: a.minReplicas ?? 1, maxReplicas: a.maxReplicas ?? 4, targetCPUUtilizationPercentage: a.targetCPUUtilizationPercentage ?? 80 }
      : undefined,
  };
}

/** Rewrite replicaCount / resources / autoscaling, nothing else. Refuses a
 * file without an `image:` map (that would be the wrong file). */
export function renderServiceSize(valuesYaml: string, size: ServiceSize): string {
  const doc = parseDocument(valuesYaml);
  if (doc.errors.length) throw new Error(`values file is not valid YAML: ${doc.errors[0].message}`);
  if (!isMap(doc.get("image"))) throw new Error("values file has no `image:` map — refusing to resize the wrong file");
  doc.setIn(["replicaCount"], size.replicas);
  doc.setIn(["resources", "requests", "cpu"], size.requests.cpu);
  doc.setIn(["resources", "requests", "memory"], size.requests.memory);
  doc.setIn(["resources", "limits", "cpu"], size.limits.cpu);
  doc.setIn(["resources", "limits", "memory"], size.limits.memory);
  if (size.autoscaling?.enabled) {
    doc.setIn(["autoscaling", "enabled"], true);
    doc.setIn(["autoscaling", "minReplicas"], size.autoscaling.minReplicas);
    doc.setIn(["autoscaling", "maxReplicas"], size.autoscaling.maxReplicas);
    doc.setIn(["autoscaling", "targetCPUUtilizationPercentage"], size.autoscaling.targetCPUUtilizationPercentage);
  } else if (doc.has("autoscaling")) {
    doc.setIn(["autoscaling", "enabled"], false);
  }
  return doc.toString({ lineWidth: 0 });
}

/** Placeholder pods are fixed units; warm capacity = replicas × unit. */
export function warmUnit(warmYaml: string): { cpu: number; memGi: number } {
  const d = parse(warmYaml) as any;
  const r = d?.spec?.template?.spec?.containers?.[0]?.resources?.requests;
  if (d?.kind !== "Deployment" || !r?.cpu || !r?.memory) throw new Error("warm-capacity file is not a Deployment with container requests");
  return { cpu: cpuToCores(String(r.cpu)), memGi: memToGi(String(r.memory)) };
}

export function warmReplicas(warmCpu: number, warmMemoryGi: number, unit: { cpu: number; memGi: number }): number {
  return Math.max(Math.ceil(warmCpu / unit.cpu - 1e-9), Math.ceil(warmMemoryGi / unit.memGi - 1e-9), 0);
}

export function readNodeSize(nodePoolYaml: string, warmYaml: string): NodeSize {
  const np = parse(nodePoolYaml) as any;
  if (np?.kind !== "NodePool") throw new Error("node pool file is not a NodePool");
  const unit = warmUnit(warmYaml);
  const replicas = Number((parse(warmYaml) as any).spec?.replicas ?? 0);
  return {
    maxCpu: Math.round(cpuToCores(String(np.spec?.limits?.cpu ?? "0"))),
    maxMemoryGi: Math.round(memToGi(String(np.spec?.limits?.memory ?? "0Gi"))),
    warmCpu: replicas * unit.cpu,
    warmMemoryGi: replicas * unit.memGi,
  };
}

export function renderNodeSize(nodePoolYaml: string, warmYaml: string, size: NodeSize): { nodePool: string; warm: string } {
  const np = parseDocument(nodePoolYaml);
  if (np.get("kind") !== "NodePool") throw new Error("node pool file is not a NodePool");
  np.setIn(["spec", "limits", "cpu"], String(size.maxCpu));
  np.setIn(["spec", "limits", "memory"], `${size.maxMemoryGi}Gi`);
  const warm = parseDocument(warmYaml);
  warm.setIn(["spec", "replicas"], warmReplicas(size.warmCpu, size.warmMemoryGi, warmUnit(warmYaml)));
  // lineWidth 0: never re-flow lines the edit did not touch
  return { nodePool: np.toString({ lineWidth: 0 }), warm: warm.toString({ lineWidth: 0 }) };
}

// ── current state from gitops ──────────────────────────────────────────

export type CurrentTier = {
  services: Record<string, ServiceSize | null>;
  nodes: NodeSize | null;
  atlas: AtlasSize | null;
  /** raw gitops files, keyed by path (inputs to the renderers) */
  files: Record<string, string>;
};

export async function readCurrentTier(repo: Pick<PromotionRepo, "readFile">, t: CapacityTarget, atlas?: AtlasSize | null): Promise<CurrentTier> {
  const files: Record<string, string> = {};
  const services: Record<string, ServiceSize | null> = {};
  await Promise.all(
    t.services.map(async (s) => {
      if (!s.valuesFile) return void (services[s.name] = null);
      const f = await repo.readFile(s.valuesFile);
      if (f) files[s.valuesFile] = f.content;
      services[s.name] = f ? readServiceSize(f.content) : null;
    }),
  );
  let nodes: NodeSize | null = null;
  if (t.nodes) {
    const [np, warm] = await Promise.all([repo.readFile(t.nodes.nodePoolFile), repo.readFile(t.nodes.warmFile)]);
    if (np && warm) {
      files[t.nodes.nodePoolFile] = np.content;
      files[t.nodes.warmFile] = warm.content;
      nodes = readNodeSize(np.content, warm.content);
    }
  }
  return { services, nodes, atlas: atlas ?? null, files };
}

// ── the plan ───────────────────────────────────────────────────────────

export type ServicePlan = {
  service: string;
  namespace: string;
  workload: string;
  valuesFile?: string;
  /** false = plan/export only for this row */
  writable: boolean;
  before: ServiceSize | null;
  after: ServiceSize;
  changes: string[];
};

export type CapacityPlan = {
  tier: CapacityTier;
  cluster: string;
  services: ServicePlan[];
  nodes: { before: NodeSize | null; after: NodeSize; writable: boolean; changes: string[] } | null;
  atlas: { cluster: string | null; before: AtlasSize | null; after: AtlasSize; writable: boolean; changes: string[] } | null;
  /** ≈ USD/month; `before` is null when the current state is (partly) unknown */
  cost: { before: number | null; after: number };
  /** hard caps exceeded — apply is refused */
  violations: string[];
  warnings: string[];
  /** gitops files this plan rewrites (writable rows only, changed only) */
  files: Record<string, string>;
};

const fmtSize = (s: ServiceSize | null) => (s ? `${s.requests.cpu}/${s.requests.memory} (limit ${s.limits.cpu}/${s.limits.memory})` : "unknown");
const fmtHpa = (s: ServiceSize | null) => (s?.autoscaling?.enabled ? `HPA ${s.autoscaling.minReplicas}–${s.autoscaling.maxReplicas} @${s.autoscaling.targetCPUUtilizationPercentage}%` : "HPA off");
const fmtAtlas = (a: AtlasSize | null) => (a ? `${a.instanceSize}${a.autoScaling ? ` (auto ${a.autoScaling.min}–${a.autoScaling.max})` : ""}` : "unknown");

function serviceChanges(before: ServiceSize | null, after: ServiceSize): string[] {
  const out: string[] = [];
  if (before?.replicas !== after.replicas) out.push(`replicas ${before?.replicas ?? "?"} → ${after.replicas}`);
  if (fmtSize(before) !== fmtSize(after)) out.push(`resources ${fmtSize(before)} → ${fmtSize(after)}`);
  if (fmtHpa(before) !== fmtHpa(after)) out.push(`${fmtHpa(before)} → ${fmtHpa(after)}`);
  return out;
}

function nodeChanges(before: NodeSize | null, after: NodeSize): string[] {
  const out: string[] = [];
  if (before?.maxCpu !== after.maxCpu || before?.maxMemoryGi !== after.maxMemoryGi) out.push(`NodePool ceiling ${before ? `${before.maxCpu} vCPU/${before.maxMemoryGi}Gi` : "?"} → ${after.maxCpu} vCPU/${after.maxMemoryGi}Gi`);
  if (before?.warmCpu !== after.warmCpu || before?.warmMemoryGi !== after.warmMemoryGi) out.push(`warm capacity ${before ? `${before.warmCpu} vCPU/${before.warmMemoryGi}Gi` : "?"} → ${after.warmCpu} vCPU/${after.warmMemoryGi}Gi`);
  return out;
}

function atlasEq(a: AtlasSize | null, b: AtlasSize): boolean {
  return fmtAtlas(a) === fmtAtlas(b);
}

const atlasRank = (t: AtlasTier) => ATLAS_TIERS.indexOf(t);

/** Steady-state pods a size runs (HPA floor when autoscaling). */
const steadyReplicas = (s: ServiceSize) => (s.autoscaling?.enabled ? s.autoscaling.minReplicas : s.replicas);
const peakReplicas = (s: ServiceSize) => (s.autoscaling?.enabled ? s.autoscaling.maxReplicas : s.replicas);

export function monthlyCost(t: Pick<CapacityTarget, "pricing">, services: Array<ServiceSize | null>, nodes: NodeSize | null, atlas: AtlasSize | null): number {
  const p = EC2_PRICE[t.pricing];
  let hourly = 0;
  for (const s of services) {
    if (!s) continue;
    hourly += steadyReplicas(s) * (cpuToCores(s.requests.cpu) * p.vcpu + memToGi(s.requests.memory) * p.gib);
  }
  if (nodes) hourly += nodes.warmCpu * p.vcpu + nodes.warmMemoryGi * p.gib;
  if (atlas) hourly += ATLAS_PRICE[atlas.instanceSize];
  return Math.round(hourly * HOURS_PER_MONTH);
}

/** Availability floors (any tier). */
export const MIN_CPU = 0.05;
export const MIN_MEM_MI = 64;
export const MIN_LIMIT_MEM_MI = 128;

export function capViolations(t: CapacityTarget, size: TierSize): string[] {
  const v: string[] = [];
  for (const [name, s] of Object.entries(size.services)) {
    // availability floors: a capacity template can never scale a service to
    // zero or starve it (that is a teardown, not a resize)
    if (steadyReplicas(s) < 1) v.push(`${name}: ${steadyReplicas(s)} replicas — capacity never scales a service to zero`);
    if (cpuToCores(s.requests.cpu) < MIN_CPU) v.push(`${name}: CPU request ${s.requests.cpu} is below the ${MIN_CPU * 1000}m floor`);
    if (memToGi(s.requests.memory) * 1024 < MIN_MEM_MI) v.push(`${name}: memory request ${s.requests.memory} is below the ${MIN_MEM_MI}Mi floor`);
    if (memToGi(s.limits.memory) * 1024 < MIN_LIMIT_MEM_MI) v.push(`${name}: memory limit ${s.limits.memory} is below the ${MIN_LIMIT_MEM_MI}Mi floor`);
    if (s.autoscaling?.enabled && !t.hpa) v.push(`${name}: ${t.cluster} has no metrics-server — an HPA would never scale; use fixed replicas`);
    if (peakReplicas(s) > t.caps.maxReplicas) v.push(`${name}: ${peakReplicas(s)} replicas exceeds the ${t.tier} cap of ${t.caps.maxReplicas}`);
    if (cpuToCores(s.requests.cpu) > cpuToCores(s.limits.cpu)) v.push(`${name}: CPU request ${s.requests.cpu} > limit ${s.limits.cpu}`);
    if (memToGi(s.requests.memory) > memToGi(s.limits.memory)) v.push(`${name}: memory request ${s.requests.memory} > limit ${s.limits.memory}`);
  }
  if (size.nodes && t.nodes && size.nodes.maxCpu > t.caps.maxNodeCpu) v.push(`NodePool ceiling ${size.nodes.maxCpu} vCPU exceeds the ${t.tier} cap of ${t.caps.maxNodeCpu}`);
  if (size.nodes && size.nodes.warmCpu > size.nodes.maxCpu) v.push(`warm capacity ${size.nodes.warmCpu} vCPU exceeds the NodePool ceiling ${size.nodes.maxCpu}`);
  if (size.atlas) {
    const top = [size.atlas.instanceSize, size.atlas.autoScaling?.max].filter((x): x is AtlasTier => !!x);
    for (const x of top) if (atlasRank(x) > atlasRank(t.caps.maxAtlas)) v.push(`Atlas ${x} exceeds the ${t.tier} cap of ${t.caps.maxAtlas}`);
    const a = size.atlas.autoScaling;
    if (a && (atlasRank(a.min) > atlasRank(size.atlas.instanceSize) || atlasRank(a.max) < atlasRank(size.atlas.instanceSize))) {
      v.push(`Atlas ${size.atlas.instanceSize} is outside its auto-scaling bounds ${a.min}–${a.max}`);
    }
  }
  return v;
}

/** Pure: what `desired` would change on tier `t`, and the files that do it. */
export function planCapacity(t: CapacityTarget, current: CurrentTier, desiredIn: TierSize, opts: { nodePoolUsedCpu?: number } = {}): CapacityPlan {
  const warnings: string[] = [];
  const violations: string[] = [];
  // Warm capacity is applied in whole placeholder units: plan (and compare)
  // what will actually run, or a 1.5 vCPU ask would re-plan forever.
  let desired = desiredIn;
  if (desiredIn.nodes && t.nodes && current.files[t.nodes.warmFile]) {
    const unit = warmUnit(current.files[t.nodes.warmFile]);
    const n = warmReplicas(desiredIn.nodes.warmCpu, desiredIn.nodes.warmMemoryGi, unit);
    desired = { ...desiredIn, nodes: { ...desiredIn.nodes, warmCpu: n * unit.cpu, warmMemoryGi: n * unit.memGi } };
  }
  const files: Record<string, string> = {};
  const known = new Set(t.services.map((s) => s.name));
  for (const name of Object.keys(desired.services)) if (!known.has(name)) warnings.push(`"${name}" is not a ${t.tier} capacity target — ignored`);

  const services: ServicePlan[] = [];
  for (const s of t.services) {
    const before = current.services[s.name] ?? null;
    const after = desired.services[s.name] ?? before;
    const writable = t.writable && !!s.valuesFile;
    // neither known nor planned: nothing to show for this row
    if (!after) continue;
    const changes = desired.services[s.name] ? serviceChanges(before, after) : [];
    if (changes.length && before && !before.autoscaling?.enabled && after.autoscaling?.enabled) {
      warnings.push(`${s.name}: turning the HPA on hands replicas to it — the Deployment may briefly run 1 pod until the HPA scales it to ${after.autoscaling.minReplicas}`);
    }
    if (changes.length && before && memToGi(after.limits.memory) < memToGi(before.limits.memory)) {
      warnings.push(`${s.name}: memory limit shrinks ${before.limits.memory} → ${after.limits.memory} — check current usage first (OOMKill risk)`);
    }
    if (writable && changes.length) {
      const src = current.files[s.valuesFile!];
      if (!src) warnings.push(`${s.valuesFile} is missing in gitops — ${s.name} cannot be resized by PR`);
      else {
        const out = renderServiceSize(src, after);
        if (out !== src) files[s.valuesFile!] = out;
      }
    }
    services.push({ service: s.name, namespace: s.namespace, workload: s.workload, valuesFile: s.valuesFile, writable, before, after, changes });
  }

  let nodes: CapacityPlan["nodes"] = null;
  if (desired.nodes) {
    const writable = t.writable && !!t.nodes && !!current.nodes;
    const changes = nodeChanges(current.nodes, desired.nodes);
    nodes = { before: current.nodes, after: desired.nodes, writable, changes };
    if (t.nodes && !current.nodes) warnings.push(`${t.nodes.nodePoolFile} / ${t.nodes.warmFile} are missing in gitops — node sizing is plan-only until they are bootstrapped`);
    if (writable && opts.nodePoolUsedCpu !== undefined && desired.nodes.maxCpu < opts.nodePoolUsedCpu) {
      violations.push(`NodePool ceiling ${desired.nodes.maxCpu} vCPU is below the ${opts.nodePoolUsedCpu} vCPU the pool runs right now`);
    }
    if (writable && changes.length) {
      const np = current.files[t.nodes!.nodePoolFile];
      const warm = current.files[t.nodes!.warmFile];
      const r = renderNodeSize(np, warm, desired.nodes);
      if (r.nodePool !== np) files[t.nodes!.nodePoolFile] = r.nodePool;
      if (r.warm !== warm) files[t.nodes!.warmFile] = r.warm;
    }
  }

  let atlas: CapacityPlan["atlas"] = null;
  if (desired.atlas) {
    atlas = {
      cluster: t.atlas.cluster,
      before: current.atlas,
      after: desired.atlas,
      writable: t.atlas.writable && !!t.atlas.cluster,
      changes: atlasEq(current.atlas, desired.atlas) ? [] : [`Atlas ${fmtAtlas(current.atlas)} → ${fmtAtlas(desired.atlas)}`],
    };
  }

  // rows we can never know (no gitops file / no linked Atlas) don't make the whole "before" unknown
  const unknownBefore =
    services.some((s) => !s.before && !!s.valuesFile) ||
    (!!nodes && !nodes.before && !!t.nodes) ||
    (!!atlas && !atlas.before && !!atlas.cluster) ||
    // nothing readable at all (prod): no baseline to compare against
    (services.length > 0 && services.every((s) => !s.before));
  return {
    tier: t.tier,
    cluster: t.cluster,
    services,
    nodes,
    atlas,
    cost: {
      // rows that can never be read (no values file / no node files / no linked Atlas) count as unchanged
      before: unknownBefore
        ? null
        : monthlyCost(
            t,
            services.map((s) => s.before ?? (s.valuesFile ? null : s.after)),
            current.nodes ?? (nodes && !t.nodes ? nodes.after : null),
            current.atlas ?? (atlas && !atlas.cluster ? atlas.after : null),
          ),
      after: monthlyCost(t, services.map((s) => s.after), nodes?.after ?? current.nodes, atlas?.after ?? current.atlas),
    },
    violations: [...capViolations(t, desired), ...violations],
    warnings,
    files,
  };
}

/** Prod/staging-only rows: a YAML hand-off for whoever applies it through
 * that tier's own release process. */
export function exportPlan(plan: CapacityPlan): string {
  const services: Record<string, unknown> = {};
  for (const s of plan.services) {
    services[s.service] = {
      replicaCount: s.after.replicas,
      resources: { requests: s.after.requests, limits: s.after.limits },
      autoscaling: s.after.autoscaling ?? { enabled: false },
    };
  }
  return stringify({
    tier: plan.tier,
    cluster: plan.cluster,
    generatedBy: "Nebula capacity planner (docs/NEBULA.md §N5)",
    services,
    ...(plan.nodes ? { nodes: { nodePoolLimits: { cpu: String(plan.nodes.after.maxCpu), memory: `${plan.nodes.after.maxMemoryGi}Gi` }, warmCapacity: { cpu: plan.nodes.after.warmCpu, memoryGi: plan.nodes.after.warmMemoryGi } } } : {}),
    ...(plan.atlas ? { atlas: { cluster: plan.atlas.cluster, ...plan.atlas.after } } : {}),
    estimatedMonthlyUsd: plan.cost.after,
  });
}

// ── the traffic calculator ─────────────────────────────────────────────

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const roundUp = (n: number, step: number) => Math.ceil(n / step - 1e-9) * step;

export type Estimate = { size: TierSize; rationale: string[] };

/** Size a tier from an expected request rate and per-service profiles. */
export function estimateTier(t: CapacityTarget, profile: TierProfile, input: EstimateInput): Estimate {
  const rationale: string[] = [];
  const design = input.rps * input.peakFactor * input.headroom;
  rationale.push(`design load = ${input.rps} rps × ${input.peakFactor} peak × ${input.headroom} headroom = ${Math.round(design)} rps`);
  const services: Record<string, ServiceSize> = {};
  let peakCpu = 0;
  let peakMem = 0;
  let steadyCpu = 0;
  let conns = 0;
  for (const [name, p] of Object.entries(profile.services)) {
    const max = Math.min(p.maxReplicas, t.caps.maxReplicas);
    const replicas = clamp(Math.ceil(design / p.rpsPerPod - 1e-9), p.minReplicas, max);
    const size: ServiceSize = { replicas, requests: p.requests, limits: p.limits };
    if (p.hpa && !t.hpa) rationale.push(`${name}: no metrics-server on ${t.cluster} — fixed replicas instead of an HPA`);
    if (p.hpa && t.hpa) {
      const floor = Math.max(1, replicas);
      size.autoscaling = { enabled: true, minReplicas: floor, maxReplicas: clamp(Math.ceil(floor * p.hpaBurst), floor, max), targetCPUUtilizationPercentage: 70 };
    }
    services[name] = size;
    const cpu = cpuToCores(p.requests.cpu);
    const mem = memToGi(p.requests.memory);
    peakCpu += peakReplicas(size) * cpu;
    peakMem += peakReplicas(size) * mem;
    steadyCpu += steadyReplicas(size) * cpu;
    conns += peakReplicas(size) * p.dbConnsPerPod;
    rationale.push(`${name}: ${Math.round(design)} ÷ ${p.rpsPerPod} rps/pod → ${replicas} pod(s)${size.autoscaling ? `, HPA ${size.autoscaling.minReplicas}–${size.autoscaling.maxReplicas}` : ""}`);
  }
  const size: TierSize = { services };

  if (profile.nodes) {
    const n = profile.nodes;
    const maxCpu = clamp(roundUp((n.baseCpu + peakCpu) * n.overhead, 4), 4, t.caps.maxNodeCpu || 2048);
    const maxMemoryGi = Math.max(8, roundUp((n.baseMemoryGi + peakMem) * n.overhead, 8));
    // whole 1 vCPU / 2Gi placeholder units (the warm-capacity Deployment's unit)
    const warmCpu = n.warmFraction > 0 ? Math.ceil(steadyCpu * n.warmFraction - 1e-9) : 0;
    size.nodes = { maxCpu, maxMemoryGi, warmCpu, warmMemoryGi: warmCpu * 2 };
    rationale.push(`nodes: (${n.baseCpu} base + ${peakCpu.toFixed(1)} peak pod vCPU) × ${n.overhead} → ceiling ${maxCpu} vCPU; keep ${warmCpu} vCPU warm`);
  }

  if (profile.atlas) {
    const a = profile.atlas;
    const pick = ATLAS_TIERS.find((x) => atlasRank(x) >= atlasRank(a.minTier) && ATLAS_LIMITS[x].maxConns >= conns * 1.25 && ATLAS_LIMITS[x].ramGi >= a.workingSetGi * 1.2) ?? t.caps.maxAtlas;
    const tier = atlasRank(pick) > atlasRank(t.caps.maxAtlas) ? t.caps.maxAtlas : pick;
    const top = ATLAS_TIERS[Math.min(atlasRank(tier) + 2, atlasRank(t.caps.maxAtlas))];
    size.atlas = { instanceSize: tier, autoScaling: { min: tier, max: atlasRank(top) >= atlasRank(tier) ? top : tier } };
    rationale.push(`Atlas: ${conns} peak connections, ${a.workingSetGi}Gi working set → ${tier} (auto-scale up to ${size.atlas.autoScaling!.max})`);
  }
  return { size, rationale };
}

/** The named preset closest to a size (by steady vCPU), for "this looks like Campaign". */
export function nearestPreset(presets: CapacityPreset[], tier: CapacityTier, size: TierSize): string | null {
  const vcpu = (s: TierSize) => Object.values(s.services).reduce((a, x) => a + steadyReplicas(x) * cpuToCores(x.requests.cpu), 0);
  const target = vcpu(size);
  let best: { name: string; d: number } | null = null;
  for (const p of presets) {
    const ts = p.tiers[tier];
    if (!ts) continue;
    const d = Math.abs(vcpu(ts) - target);
    if (!best || d < best.d) best = { name: p.name, d };
  }
  return best?.name ?? null;
}

// ── branches, PRs, merge ───────────────────────────────────────────────

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/** sha256 of a tier size, order-independent — binds the nonce and names the branch. */
export function hashSize(size: TierSize): string {
  return createHash("sha256").update(canonical(size)).digest("hex");
}

const LABEL_RE = /^[a-z][a-z0-9-]{1,23}$/;

/** `capacity/<tier>/<label>-<hash8>`: same size ⇒ same branch ⇒ idempotent. */
export function capacityBranch(tier: CapacityTier, label: string, sizeHash: string): string {
  return `${CAPACITY_BRANCH_PREFIX}${tier}/${label}-${sizeHash.slice(0, 8)}`;
}

export function parseCapacityBranch(branch: string): { tier: CapacityTier; label: string; hash8: string } | null {
  const m = branch.match(/^capacity\/(preview|staging)\/([a-z][a-z0-9-]{1,23})-([0-9a-f]{8})$/);
  return m ? { tier: m[1] as CapacityTier, label: m[2], hash8: m[3] } : null;
}

export function capacityPrBody(plan: CapacityPlan, o: { label: string; actor: string }): string {
  const rows = plan.services.filter((s) => s.changes.length && s.writable).map((s) => `- **${s.service}** (\`${s.valuesFile}\`): ${s.changes.join("; ")}`);
  const nodeRows = plan.nodes?.writable && plan.nodes.changes.length ? plan.nodes.changes.map((c) => `- **nodes**: ${c}`) : [];
  return [
    `Nebula capacity: apply **${o.label}** to **${plan.tier}** (${plan.cluster}).`,
    "",
    ...rows,
    ...nodeRows,
    "",
    `- Estimated cost: ≈ $${plan.cost.before ?? "?"} → $${plan.cost.after} / month (list prices, rough)`,
    ...(plan.atlas?.changes.length ? [`- Atlas (${plan.atlas.cluster ?? "not linked"}): ${plan.atlas.changes.join("; ")} — applied separately (\`set_atlas_tier\`), not by this PR`] : []),
    ...plan.warnings.map((w) => `- ⚠ ${w}`),
    `- Requested by: ${o.actor}`,
    "",
    "Merging is the second human gate (Nebula `merge_capacity_pr`, or merge here). Argo CD syncs within ~3 minutes. To scale back, apply the previous preset.",
    "",
    "Nebula · docs/NEBULA.md §N5",
  ].join("\n");
}

export type ApplyCapacityInput = { tier: CapacityTier; label: string; size: TierSize; actor: string; atlas?: AtlasSize | null; nodePoolUsedCpu?: number };

/** Every gitops path a tier's capacity PRs may touch (merge refuses anything else). */
export function capacityPaths(t: CapacityTarget): string[] {
  return [...t.services.map((s) => s.valuesFile).filter((x): x is string => !!x), ...(t.nodes ? [t.nodes.nodePoolFile, t.nodes.warmFile] : [])];
}

export type ApplyCapacityResult = { tier: CapacityTier; label: string; branch: string; prNumber: number; prUrl: string; existing: boolean; files: string[]; cost: CapacityPlan["cost"] };

/** Open the capacity PR for a writable tier. Idempotent per (tier, label, size). */
export async function applyCapacity(deps: { promotions: PromotionRepo }, input: ApplyCapacityInput): Promise<ApplyCapacityResult> {
  const t = capacityTarget(input.tier);
  if (!t.writable) throw new Error(`${input.tier} is plan-only: Nebula never writes to it`);
  if (!LABEL_RE.test(input.label) || input.label.includes("prod")) throw new Error(`bad preset label "${input.label}"`);
  const current = await readCurrentTier(deps.promotions, t, input.atlas);
  const plan = planCapacity(t, current, input.size, { nodePoolUsedCpu: input.nodePoolUsedCpu });
  if (plan.violations.length) throw new Error(`refused — over the ${input.tier} caps:\n${plan.violations.join("\n")}`);
  const paths = Object.keys(plan.files);
  if (!paths.length) throw new Error(`${input.tier} already matches "${input.label}" — nothing to change in gitops${plan.atlas?.changes.length ? " (the Atlas tier is applied separately)" : ""}`);

  const branch = capacityBranch(input.tier, input.label, hashSize(input.size));
  // One open capacity PR per tier: two PRs each diffed against the same main
  // would merge into a size no preset describes.
  const openForTier = (await deps.promotions.listOpenPrs(`${CAPACITY_BRANCH_PREFIX}${input.tier}/`)).filter((p) => parseCapacityBranch(p.branch)?.tier === input.tier);
  const open = openForTier.find((p) => p.branch === branch);
  const other = openForTier.find((p) => p.branch !== branch);
  if (other) throw new Error(`capacity PR #${other.number} (${other.branch}) is already open for ${input.tier} — merge or close it first`);
  const base = { tier: input.tier, label: input.label, branch, files: paths, cost: plan.cost };
  if (open) return { ...base, prNumber: open.number, prUrl: open.url, existing: true };
  const pr = await deps.promotions.openPr({
    branch,
    files: plan.files,
    title: `capacity(${input.tier}): ${input.label}`,
    body: capacityPrBody(plan, { label: input.label, actor: input.actor }),
  });
  return { ...base, prNumber: pr.number, prUrl: pr.url, existing: false };
}

export type CapacityPrView = PromotionPr & { tier: CapacityTier; label: string };

export async function listCapacityPrs(deps: { promotions: Pick<PromotionRepo, "listOpenPrs"> }): Promise<CapacityPrView[]> {
  const prs = await deps.promotions.listOpenPrs(CAPACITY_BRANCH_PREFIX);
  const out: CapacityPrView[] = [];
  for (const pr of prs) {
    const p = parseCapacityBranch(pr.branch);
    if (p) out.push({ ...pr, tier: p.tier, label: p.label });
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Merge a capacity PR. Refused unless: (tier, label) match its branch; its
 * head is still the sha the human confirmed; it touches only the tier's
 * capacity files; and main has not changed any of those files since it forked
 * (a stale PR would silently revert them). The merge is pinned to that sha. */
export async function mergeCapacityPr(
  deps: { promotions: Pick<PromotionRepo, "getPr" | "mergePr" | "listPrFiles" | "changedOnBaseSince"> },
  input: { prNumber: number; tier: CapacityTier; label: string; headSha: string; actor: string },
) {
  const pr = await deps.promotions.getPr(input.prNumber);
  if (!pr) throw new Error(`PR #${input.prNumber} does not exist in ${GITOPS.owner}/${GITOPS.repo}`);
  if (pr.state !== "open") throw new Error(`PR #${input.prNumber} is ${pr.state}`);
  const parsed = parseCapacityBranch(pr.branch);
  if (!parsed) throw new Error(`PR #${input.prNumber} (${pr.branch}) is not a capacity PR`);
  if (parsed.tier !== input.tier || parsed.label !== input.label) throw new Error(`PR #${input.prNumber} applies ${parsed.label} to ${parsed.tier}, not ${input.label} to ${input.tier}`);
  if (pr.headSha !== input.headSha) throw new Error(`PR #${input.prNumber} moved: head is ${pr.headSha.slice(0, 7)}, you confirmed ${input.headSha.slice(0, 7)} — review it again`);
  const t = capacityTarget(parsed.tier);
  if (!t.writable) throw new Error(`${parsed.tier} is plan-only`);
  const allowed = new Set(capacityPaths(t));
  const files = await deps.promotions.listPrFiles(pr.number);
  const outside = files.filter((f) => !allowed.has(f));
  if (!files.length) throw new Error(`PR #${input.prNumber} changes no files`);
  if (outside.length) throw new Error(`PR #${input.prNumber} touches files outside the ${parsed.tier} capacity set: ${outside.join(", ")} — refusing`);
  const moved = (await deps.promotions.changedOnBaseSince(pr.branch)).filter((f) => allowed.has(f));
  if (moved.length) throw new Error(`main changed ${moved.join(", ")} since PR #${input.prNumber} was opened — close it and re-apply the preset`);
  const merged = await deps.promotions.mergePr(pr.number, { title: `${pr.title} (#${pr.number})`, sha: pr.headSha });
  return { prNumber: pr.number, mergedSha: merged.sha, tier: parsed.tier, label: parsed.label };
}

// ── Atlas tier ─────────────────────────────────────────────────────────

export interface AtlasClusters {
  getTier(cluster: string): Promise<(AtlasSize & { state: string }) | null>;
  /** `expect`: the tier the caller checked; refused if the cluster moved since */
  setTier(cluster: string, size: AtlasSize, expect?: AtlasSize): Promise<{ state: string }>;
}

/** Change the Atlas tier of a WRITABLE tier's linked cluster (NonProd only).
 * The cluster name is derived from the tier, never an input. */
export async function setAtlasTier(deps: { atlas: AtlasClusters }, input: { tier: CapacityTier; size: AtlasSize; actor: string }) {
  const t = capacityTarget(input.tier);
  if (!t.atlas.writable || !t.atlas.cluster) throw new Error(`the ${input.tier} Atlas cluster is plan-only: Nebula never writes to it`);
  const v = capViolations(t, { services: {}, atlas: input.size });
  if (v.length) throw new Error(`refused:\n${v.join("\n")}`);
  const before = await deps.atlas.getTier(t.atlas.cluster);
  if (!before) throw new Error(`Atlas cluster ${t.atlas.cluster} not found`);
  if (before.state !== "IDLE") throw new Error(`Atlas cluster ${t.atlas.cluster} is ${before.state} — wait for IDLE before resizing`);
  if (atlasEq(before, input.size)) throw new Error(`${t.atlas.cluster} is already ${fmtAtlas(input.size)}`);
  const r = await deps.atlas.setTier(t.atlas.cluster, input.size, { instanceSize: before.instanceSize, autoScaling: before.autoScaling });
  return { cluster: t.atlas.cluster, from: fmtAtlas(before), to: fmtAtlas(input.size), state: r.state };
}

export { fmtAtlas };
