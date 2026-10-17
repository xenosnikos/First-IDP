// Prod Atlas tier control (docs/NEBULA.md §N5.3). Platform-owner decision
// 2026-10-16: ops resize the prod MongoDB clusters from Nebula ahead of
// anticipated traffic. Bounded in code (this file) and by policy
// (`set_prod_atlas_tier`): an allowlist of clusters, one call = one cluster,
// at most +2 tiers up / -1 tier down per change, IDLE only, auto-scaling kept
// on/off as configured, and the nonce binds the tier the human saw (`from`).
import { ATLAS_TIERS, type AtlasSize, type AtlasTier } from "@twizz-idp/shared";
import { ATLAS_PRICE } from "./capacity-prices";
import { fmtAtlas, type AtlasClusters } from "./capacity";

export const PROD_ATLAS = {
  /** the prod Atlas account's project "Loly" (ATLAS_PROD_PROJECT_ID) */
  clusters: ["Moly-Prod", "Prod-Shift4"] as const,
  floor: "M10" as AtlasTier,
  cap: "M200" as AtlasTier,
  maxStepUp: 2,
  maxStepDown: 1,
} as const;
export type ProdAtlasCluster = (typeof PROD_ATLAS.clusters)[number];

export const isProdAtlasCluster = (c: string): c is ProdAtlasCluster => (PROD_ATLAS.clusters as readonly string[]).includes(c);

const rank = (t: AtlasTier) => ATLAS_TIERS.indexOf(t);
const HOURS_PER_MONTH = 730;
export const atlasMonthly = (t: AtlasTier) => Math.round(ATLAS_PRICE[t] * HOURS_PER_MONTH);

/** Tiers one change may move a cluster to (the current tier excluded). */
export function prodAtlasOptions(current: AtlasTier): AtlasTier[] {
  const lo = Math.max(rank(current) - PROD_ATLAS.maxStepDown, rank(PROD_ATLAS.floor));
  const hi = Math.min(rank(current) + PROD_ATLAS.maxStepUp, rank(PROD_ATLAS.cap));
  return ATLAS_TIERS.slice(lo, hi + 1).filter((t) => t !== current);
}

export type ProdAtlasPlan = {
  cluster: string;
  from: string;
  to: string;
  changes: string[];
  violations: string[];
  warnings: string[];
  cost: { before: number; after: number };
};

export function planProdAtlas(cluster: string, before: AtlasSize & { state: string }, after: AtlasSize): ProdAtlasPlan {
  const v: string[] = [];
  const w: string[] = [];
  const changes: string[] = [];
  if (!isProdAtlasCluster(cluster)) v.push(`${cluster} is not a prod cluster Nebula sizes (${PROD_ATLAS.clusters.join(", ")})`);
  if (before.state !== "IDLE") v.push(`${cluster} is ${before.state} — wait for IDLE before resizing`);

  const d = rank(after.instanceSize) - rank(before.instanceSize);
  if (rank(after.instanceSize) < rank(PROD_ATLAS.floor) || rank(after.instanceSize) > rank(PROD_ATLAS.cap)) v.push(`${after.instanceSize} is outside the prod range ${PROD_ATLAS.floor}–${PROD_ATLAS.cap}`);
  if (d > PROD_ATLAS.maxStepUp) v.push(`${before.instanceSize} → ${after.instanceSize} is ${d} tiers up; at most ${PROD_ATLAS.maxStepUp} per change`);
  if (-d > PROD_ATLAS.maxStepDown) v.push(`${before.instanceSize} → ${after.instanceSize} is ${-d} tiers down; at most ${PROD_ATLAS.maxStepDown} per change`);

  // auto-scaling stays as configured (on → on with new bounds; off → off)
  if (!!before.autoScaling !== !!after.autoScaling) v.push(`turning compute auto-scaling ${before.autoScaling ? "off" : "on"} is not done from Nebula (Atlas UI) — keep it ${before.autoScaling ? "on" : "off"}`);
  if (after.autoScaling) {
    const { min, max } = after.autoScaling;
    if (rank(min) > rank(after.instanceSize) || rank(max) < rank(after.instanceSize)) v.push(`${after.instanceSize} is outside its auto-scaling bounds ${min}–${max}`);
    if (rank(min) < rank(PROD_ATLAS.floor) || rank(max) > rank(PROD_ATLAS.cap)) v.push(`auto-scaling ${min}–${max} is outside the prod range ${PROD_ATLAS.floor}–${PROD_ATLAS.cap}`);
    if (before.autoScaling && rank(max) < rank(before.autoScaling.max) - PROD_ATLAS.maxStepDown) v.push(`auto-scaling ceiling ${before.autoScaling.max} → ${max} drops more than ${PROD_ATLAS.maxStepDown} tier`);
    if (before.autoScaling && rank(max) > rank(before.autoScaling.max) + PROD_ATLAS.maxStepUp) v.push(`auto-scaling ceiling ${before.autoScaling.max} → ${max} rises more than ${PROD_ATLAS.maxStepUp} tiers`);
  }

  if (before.instanceSize !== after.instanceSize) changes.push(`tier ${before.instanceSize} → ${after.instanceSize}`);
  const ab = before.autoScaling, aa = after.autoScaling;
  if (ab && aa && (ab.min !== aa.min || ab.max !== aa.max)) changes.push(`auto-scaling ${ab.min}–${ab.max} → ${aa.min}–${aa.max}`);
  if (!changes.length && !v.length) v.push(`${cluster} is already ${fmtAtlas(after)}`);

  if (d !== 0) w.push("Atlas rolls the change node by node: one primary election (a few seconds of write retries). Do it ahead of the traffic, not at peak.");
  if (d < 0) w.push(`less RAM (${before.instanceSize} → ${after.instanceSize}): the working set may stop fitting in cache — downsize off-peak`);
  if (d > 0 && aa && rank(aa.min) < rank(after.instanceSize)) w.push(`auto-scaling may scale back down to ${aa.min} after sustained low load — raise the floor (min) to ${after.instanceSize} to hold it through the campaign`);

  return {
    cluster,
    from: fmtAtlas(before),
    to: fmtAtlas(after),
    changes,
    violations: v,
    warnings: w,
    cost: { before: atlasMonthly(before.instanceSize), after: atlasMonthly(after.instanceSize) },
  };
}

/** Resize ONE prod Atlas cluster. `from` is the tier the human reviewed; a
 * cluster that moved since is refused, never resized blind. */
export async function setProdAtlasTier(deps: { atlas: AtlasClusters }, input: { cluster: string; size: AtlasSize; from: string; actor: string }) {
  if (!isProdAtlasCluster(input.cluster)) throw new Error(`${input.cluster} is not a prod cluster Nebula sizes`);
  const before = await deps.atlas.getTier(input.cluster);
  if (!before) throw new Error(`Atlas cluster ${input.cluster} not found`);
  if (fmtAtlas(before) !== input.from) throw new Error(`${input.cluster} is now ${fmtAtlas(before)} (you reviewed ${input.from}) — reload and plan again`);
  const plan = planProdAtlas(input.cluster, before, input.size);
  if (plan.violations.length) throw new Error(`refused:\n${plan.violations.join("\n")}`);
  const r = await deps.atlas.setTier(input.cluster, input.size, { instanceSize: before.instanceSize, autoScaling: before.autoScaling });
  return { cluster: input.cluster, from: plan.from, to: plan.to, state: r.state };
}
