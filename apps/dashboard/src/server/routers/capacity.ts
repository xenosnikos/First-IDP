import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { CAPACITY_TIERS, EstimateInput, TierSize, type CapacityTier } from "@twizz-idp/shared";
import { LIVE_TARGETS, describeLiveOp, estimateTier, exportPlan, hashSize, isLiveTier, listCapacityPrs, liveAsSize, nearestPreset, planCapacity, planLive } from "@twizz-idp/actions";
import { router, protectedProcedure } from "../trpc";
import { namedEnvDeps } from "../nebula/deps";
import { currentFor, nodePoolUsedCpu, observe, presetsAndProfiles, readLive, readProdAtlas, targetFor } from "../nebula/capacity";

// Capacity page (docs/NEBULA.md §N5). QUERIES ONLY: presets, the current
// state per tier, a plan (diff + cost + export) and the traffic calculator.
// Applying a plan is `actions.applyCapacityPreset` / `setAtlasTier` (gated).

const tierSchema = z.enum(CAPACITY_TIERS);
export const planInput = z.object({ tier: tierSchema, preset: z.string().max(24).optional(), custom: TierSize.optional() });

/** Resolve the size to plan: a named preset (read from gitops, never from the
 * client) or a custom size from the calculator. */
export async function resolveSize(tier: CapacityTier, input: { preset?: string; custom?: TierSize }): Promise<{ label: string; size: TierSize }> {
  if (input.custom) return { label: "custom", size: input.custom };
  if (!input.preset) throw new TRPCError({ code: "BAD_REQUEST", message: "pick a preset or a custom size" });
  const { presets, presetsError } = await presetsAndProfiles();
  if (presetsError) throw new TRPCError({ code: "PRECONDITION_FAILED", message: presetsError });
  const p = presets.find((x) => x.name === input.preset);
  if (!p) throw new TRPCError({ code: "NOT_FOUND", message: `no preset "${input.preset}"` });
  const size = p.tiers[tier];
  if (!size) throw new TRPCError({ code: "NOT_FOUND", message: `preset "${p.name}" has no ${tier} section` });
  return { label: p.name, size };
}

export const capacityRouter = router({
  /** Presets, profiles and open capacity PRs. */
  overview: protectedProcedure.query(async () => {
    const [pp, prs] = await Promise.all([
      presetsAndProfiles(),
      listCapacityPrs(namedEnvDeps()).then((v) => ({ v }), (e) => ({ error: String((e as Error).message ?? e) })),
    ]);
    return {
      presets: pp.presets,
      presetsError: pp.presetsError,
      profileTiers: pp.profiles ? (Object.keys(pp.profiles.tiers) as CapacityTier[]) : [],
      profilesError: pp.profilesError,
      prs: "v" in prs ? prs.v : [],
      prsError: "error" in prs ? prs.error : undefined,
    };
  }),

  /** One tier: what gitops declares + what is actually running. */
  tier: protectedProcedure.input(z.object({ tier: tierSchema })).query(async ({ input }) => {
    const tier = input.tier;
    const [{ t, current, atlasError }, observed, live, prodAtlas] = await Promise.all([
      currentFor(tier),
      observe(targetFor(tier)),
      isLiveTier(tier) ? readLive(tier) : Promise.resolve(null),
      tier === "production" ? readProdAtlas() : Promise.resolve(null),
    ]);
    const lt = isLiveTier(tier) ? LIVE_TARGETS[tier] : null;
    return {
      prodAtlas,
      // the Moly clusters, read straight from the API (always reflects what runs)
      live: lt
        ? live && "state" in live
          ? { ...live.state, pair: lt.pair, caps: lt.caps, baseline: liveAsSize(lt, live.state) }
          : { error: live && "error" in live ? live.error : "not read", pair: lt.pair, caps: lt.caps }
        : null,
      tier: t.tier,
      cluster: t.cluster,
      writable: t.writable,
      caps: t.caps,
      atlas: { cluster: t.atlas.cluster, writable: t.atlas.writable, current: current.atlas, error: atlasError },
      nodesManaged: !!t.nodes && !!current.nodes,
      declared: { services: current.services, nodes: current.nodes },
      targets: t.services.map((s) => ({ ...s, writable: t.writable && !!s.valuesFile })),
      observed,
    };
  }),

  /** The diff a preset or custom size would make, with cost and an export. */
  plan: protectedProcedure.input(planInput).query(async ({ input }) => {
    const { label, size } = await resolveSize(input.tier, input);
    const [{ t, current }, used] = await Promise.all([currentFor(input.tier), input.tier === "preview" ? nodePoolUsedCpu() : Promise.resolve(undefined)]);
    const plan = planCapacity(t, current, size, { nodePoolUsedCpu: used });
    const { files, ...rest } = plan;
    // live part (staging ns default/jobs, prod): a diff against a FRESH read
    let live: (ReturnType<typeof planLive> & { opsText: string[] }) | { error: string } | null = null;
    if (isLiveTier(input.tier) && size.live) {
      const r = await readLive(input.tier);
      if ("error" in r) live = { error: r.error };
      else {
        const p = planLive(LIVE_TARGETS[input.tier], r.state, size.live);
        live = { ...p, opsText: p.ops.map(describeLiveOp) };
      }
    }
    return { ...rest, label, size, sizeHash: hashSize(size), files: Object.keys(files), writable: t.writable, exportYaml: exportPlan(plan), live };
  }),

  /** Traffic calculator: rps → a custom size + the nearest named preset. */
  estimate: protectedProcedure.input(EstimateInput.extend({ tier: tierSchema })).query(async ({ input }) => {
    const { presets, profiles, profilesError } = await presetsAndProfiles();
    const profile = profiles?.tiers[input.tier];
    if (!profile) throw new TRPCError({ code: "PRECONDITION_FAILED", message: profilesError ?? `capacity/profiles.yaml has no ${input.tier} section` });
    const e = estimateTier(targetFor(input.tier), profile, input);
    return { ...e, nearest: nearestPreset(presets, input.tier, e.size) };
  }),
});
