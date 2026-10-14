// Capacity templates (docs/NEBULA.md §N5). Presets and calculator profiles
// live in twizz-gitops `capacity/presets.yaml` + `capacity/profiles.yaml`
// (edited by PR); these schemas validate them wherever they are read.
import { z } from "zod";

/** Capacity tiers. Keys deliberately avoid the substring "prod" so gate
 * fields for the writable tiers never trip policy.yaml's `*prod*` deny —
 * and `production` always does (belt and braces: prod has no write tool). */
export const CAPACITY_TIERS = ["preview", "staging", "production"] as const;
export type CapacityTier = (typeof CAPACITY_TIERS)[number];
export const CAPACITY_TIER_LABEL: Record<CapacityTier, string> = { preview: "NonProd", staging: "Staging", production: "Prod" };

/** Atlas dedicated tiers Nebula knows how to size (AWS). */
export const ATLAS_TIERS = ["M10", "M20", "M30", "M40", "M50", "M60", "M80", "M140", "M200"] as const;
export type AtlasTier = (typeof ATLAS_TIERS)[number];

const CPU_RE = /^(\d+(\.\d+)?|\d+m)$/;
const MEM_RE = /^\d+(\.\d+)?(Mi|Gi)$/;
export const cpuQuantity = z.string().regex(CPU_RE, 'CPU quantity, e.g. "500m" or "2"');
export const memQuantity = z.string().regex(MEM_RE, 'memory quantity, e.g. "512Mi" or "2Gi"');

/** "500m" → 0.5, "2" → 2 (vCPU). */
export function cpuToCores(q: string): number {
  if (!CPU_RE.test(q)) throw new Error(`bad CPU quantity "${q}"`);
  return q.endsWith("m") ? Number(q.slice(0, -1)) / 1000 : Number(q);
}

/** "512Mi" → 0.5, "2Gi" → 2 (GiB). */
export function memToGi(q: string): number {
  if (!MEM_RE.test(q)) throw new Error(`bad memory quantity "${q}"`);
  return q.endsWith("Mi") ? Number(q.slice(0, -2)) / 1024 : Number(q.slice(0, -2));
}

export const AutoscalingSize = z.object({
  enabled: z.boolean(),
  minReplicas: z.number().int().min(1).max(200),
  maxReplicas: z.number().int().min(1).max(400),
  targetCPUUtilizationPercentage: z.number().int().min(20).max(95).default(70),
}).refine((a) => a.maxReplicas >= a.minReplicas, "maxReplicas < minReplicas");

export const ServiceSize = z.object({
  replicas: z.number().int().min(0).max(200),
  requests: z.object({ cpu: cpuQuantity, memory: memQuantity }),
  limits: z.object({ cpu: cpuQuantity, memory: memQuantity }),
  autoscaling: AutoscalingSize.optional(),
});
export type ServiceSize = z.infer<typeof ServiceSize>;

/** Karpenter NodePool ceiling + capacity kept warm by placeholder pods. */
export const NodeSize = z.object({
  maxCpu: z.number().int().min(4).max(2048),
  maxMemoryGi: z.number().int().min(8).max(8192),
  warmCpu: z.number().min(0).max(256).default(0),
  warmMemoryGi: z.number().min(0).max(1024).default(0),
});
export type NodeSize = z.infer<typeof NodeSize>;

export const AtlasSize = z.object({
  instanceSize: z.enum(ATLAS_TIERS),
  /** compute auto-scaling bounds; omitted = auto-scaling off */
  autoScaling: z.object({ min: z.enum(ATLAS_TIERS), max: z.enum(ATLAS_TIERS) }).optional(),
});
export type AtlasSize = z.infer<typeof AtlasSize>;

export const TierSize = z.object({
  services: z.record(z.string().regex(/^[a-z][a-z0-9-]{1,39}$/), ServiceSize).default({}),
  nodes: NodeSize.optional(),
  atlas: AtlasSize.optional(),
});
export type TierSize = z.infer<typeof TierSize>;

export const PRESET_NAME_RE = /^[a-z][a-z0-9-]{1,23}$/;

export const CapacityPreset = z.object({
  name: z.string().regex(PRESET_NAME_RE).refine((n) => !n.includes("prod") && !n.startsWith("custom"), "preset names may not contain 'prod' or start with 'custom'"),
  title: z.string().max(60),
  description: z.string().max(400).optional(),
  tiers: z.object({ preview: TierSize.optional(), staging: TierSize.optional(), production: TierSize.optional() }),
});
export type CapacityPreset = z.infer<typeof CapacityPreset>;

export const CapacityPresetsFile = z.object({ presets: z.array(CapacityPreset).max(20) }).refine(
  (f) => new Set(f.presets.map((p) => p.name)).size === f.presets.length,
  "duplicate preset names",
);

/** Calculator inputs per service: what one pod handles and costs. */
export const ServiceProfile = z.object({
  rpsPerPod: z.number().positive(),
  requests: z.object({ cpu: cpuQuantity, memory: memQuantity }),
  limits: z.object({ cpu: cpuQuantity, memory: memQuantity }),
  minReplicas: z.number().int().min(0).default(1),
  maxReplicas: z.number().int().min(1).default(10),
  /** Mongo connections one pod opens at peak (driver maxPoolSize). */
  dbConnsPerPod: z.number().int().min(0).default(0),
  /** emit an HPA (min = computed replicas, max = ×hpaBurst) */
  hpa: z.boolean().default(false),
  hpaBurst: z.number().min(1).max(5).default(2),
});
export type ServiceProfile = z.infer<typeof ServiceProfile>;

export const TierProfile = z.object({
  services: z.record(z.string(), ServiceProfile).default({}),
  /** Node ceiling = baseCpu + Σ(maxReplicas·cpu)·overhead (previews etc. live in baseCpu). */
  nodes: z.object({ baseCpu: z.number().min(0).default(0), baseMemoryGi: z.number().min(0).default(0), overhead: z.number().min(1).max(3).default(1.15), warmFraction: z.number().min(0).max(1).default(0.25) }).optional(),
  /** Atlas: hot data that must fit in RAM. */
  atlas: z.object({ workingSetGi: z.number().min(0).default(0), minTier: z.enum(ATLAS_TIERS).default("M10") }).optional(),
});
export type TierProfile = z.infer<typeof TierProfile>;

export const CapacityProfilesFile = z.object({
  tiers: z.object({ preview: TierProfile.optional(), staging: TierProfile.optional(), production: TierProfile.optional() }),
});
export type CapacityProfilesFile = z.infer<typeof CapacityProfilesFile>;

export const EstimateInput = z.object({
  /** expected steady requests/second at the edge */
  rps: z.number().min(0).max(1_000_000),
  /** peak ÷ steady (a campaign spike) */
  peakFactor: z.number().min(1).max(20).default(1.5),
  /** safety margin over peak */
  headroom: z.number().min(1).max(3).default(1.3),
});
export type EstimateInput = z.infer<typeof EstimateInput>;
