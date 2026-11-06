import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { AtlasSize, CAPACITY_TIERS, EstimateInput, EstimateLiveInput, TierSize, type CapacityTier, type LiveTierSize } from "@twizz-idp/shared";
import { BASELINE_TEMPLATE, LIVE_TARGETS, PROD_ATLAS, assessLive, caseSizing, describeLiveOp, estimateLive, planProdAtlas, estimateTier, exportPlan, hashSize, isLiveTier, listCapacityPrs, liveAsSize, nearestPreset, planCapacity, planLive, type LiveTier } from "@twizz-idp/actions";
import { capacityCases, trafficPeaks, trafficWindow } from "../nebula/traffic";
import { router, protectedProcedure } from "../trpc";
import { namedEnvDeps } from "../nebula/deps";
import { currentFor, liveTemplateOpts, nodePoolUsedCpu, observe, presetsAndProfiles, prodAtlasPort, readLive, readProdAtlas, targetFor } from "../nebula/capacity";

// Capacity page (docs/NEBULA.md §N5). QUERIES ONLY: presets, the current
// state per tier, a plan (diff + cost + export) and the traffic calculator.
// Applying a plan is `actions.applyCapacityPreset` / `setAtlasTier` (gated).

const tierSchema = z.enum(CAPACITY_TIERS);
export const planInput = z.object({ tier: tierSchema, preset: z.string().max(24).optional(), custom: TierSize.optional() });

/** What a traffic profile may resize (Codex review: a profile edit must not widen what an
 * estimate touches). Workloads and node groups outside these lists are refused. */
export const LIVE_PROFILE_ALLOWLIST: Record<LiveTier, { workloads: readonly string[]; nodegroups: readonly string[] }> = {
  production: { workloads: ["moly-backend-deployment", "lolygram-discovery-deployment"], nodegroups: ["eks-prod-node-group-m5-2x-extra"] },
  staging: { workloads: ["moly-backend-deployment"], nodegroups: [] },
};

export function checkProfileTargets(tier: LiveTier, profile: { workloads: Record<string, unknown>; nodegroups: Record<string, unknown> }) {
  const allow = LIVE_PROFILE_ALLOWLIST[tier];
  const bad = [
    ...Object.keys(profile.workloads).filter((w) => !allow.workloads.includes(w)).map((w) => `workload ${w}`),
    ...Object.keys(profile.nodegroups).filter((g) => !allow.nodegroups.includes(g)).map((g) => `node group ${g}`),
  ];
  if (bad.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `capacity/profiles.yaml ${tier}.live names ${bad.join(", ")}, outside Nebula's allowlist for traffic estimates` });
}

/** A traffic estimate → a live size, server-side from the gitops profile (`<tier>.live`)
 * and floored by the tier's `baseline` template (docs/NEBULA.md §N5.4). The client
 * sends only numbers; it never supplies the size. */
export async function resolveEstimate(tier: LiveTier, est: EstimateLiveInput) {
  const { presets, profiles, presetsError, profilesError } = await presetsAndProfiles();
  if (presetsError) throw new TRPCError({ code: "PRECONDITION_FAILED", message: presetsError });
  const profile = profiles?.tiers[tier]?.live;
  if (!profile) throw new TRPCError({ code: "PRECONDITION_FAILED", message: profilesError ?? `capacity/profiles.yaml has no ${tier}.live profile: traffic estimates are not calibrated for ${tier}` });
  const floor = presets.find((p) => p.name === BASELINE_TEMPLATE)?.tiers[tier]?.live;
  // fail closed: an estimate is only safe with the baseline template as its floor
  if (!floor) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `no "${BASELINE_TEMPLATE}" template with a ${tier} live section in capacity/presets.yaml: traffic estimates need it as their floor` });
  checkProfileTargets(tier, profile);
  const estimate = estimateLive(LIVE_TARGETS[tier], profile, est, floor);
  return { label: `estimate-${Math.round(est.rps)}`, size: { services: {}, live: estimate.size } as TierSize, estimate, profile, floor, presets };
}

/** Resolve the size to plan: a named preset (read from gitops, never from the
 * client), a traffic estimate (computed server-side), or a custom size. */
export async function resolveSize(tier: CapacityTier, input: { preset?: string; custom?: TierSize; estimate?: EstimateLiveInput }): Promise<{ label: string; size: TierSize }> {
  if (input.estimate) {
    if (!isLiveTier(tier)) throw new TRPCError({ code: "BAD_REQUEST", message: "traffic estimates size the live tiers (staging, production) only" });
    const r = await resolveEstimate(tier, input.estimate);
    return { label: r.label, size: r.size };
  }
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
      const [r, opts] = await Promise.all([readLive(input.tier), liveTemplateOpts(input.tier, input)]);
      if ("error" in r) live = { error: r.error };
      else {
        const p = planLive(LIVE_TARGETS[input.tier], r.state, size.live, opts);
        live = { ...p, opsText: p.ops.map(describeLiveOp) };
      }
    }
    return { ...rest, label, size, sizeHash: hashSize(size), files: Object.keys(files), writable: t.writable, exportYaml: exportPlan(plan), live };
  }),

  /** What resizing ONE prod Atlas cluster would do, against a fresh read (§N5.3). */
  prodAtlasPlan: protectedProcedure.input(z.object({ cluster: z.enum(PROD_ATLAS.clusters), size: AtlasSize })).query(async ({ input }) => {
    const port = prodAtlasPort();
    if (!port) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "prod Atlas key not configured" });
    const before = await port.getTier(input.cluster);
    if (!before) throw new TRPCError({ code: "NOT_FOUND", message: `Atlas cluster ${input.cluster} not found` });
    return planProdAtlas(input.cluster, before, input.size);
  }),

  /** Traffic-driven LIVE sizing (§N5.4): expected peak req/s → pods + nodes from the
   * calibrated profile, the plan against a FRESH read (planHash for the gated apply),
   * and how what runs now, the estimate and every named template would fare at that load. */
  estimateLive: protectedProcedure.input(EstimateLiveInput.extend({ tier: z.enum(["staging", "production"]) })).query(async ({ input }) => {
    const { tier, ...est } = input;
    const r = await resolveEstimate(tier, est);
    const t = LIVE_TARGETS[tier];
    const live = await readLive(tier);
    const designRps = r.estimate.designRps;
    let plan: (ReturnType<typeof planLive> & { opsText: string[] }) | { error: string };
    let runningNow: LiveTierSize | null = null;
    if ("error" in live) plan = { error: live.error };
    else {
      const p = planLive(t, live.state, r.estimate.size, { template: { name: r.label, floor: r.floor, liftStepDown: false } });
      plan = { ...p, opsText: p.ops.map(describeLiveOp) };
      runningNow = liveAsSize(t, live.state);
    }
    const templates = r.presets
      .filter((p) => p.tiers[tier]?.live)
      .map((p) => ({ template: p.name, title: p.title, atPeak: assessLive(r.profile, p.tiers[tier]!.live!, input.rps), atDesign: assessLive(r.profile, p.tiers[tier]!.live!, designRps) }));
    return {
      tier,
      label: r.label,
      input: est,
      estimate: r.estimate,
      calibratedFrom: r.profile.calibratedFrom,
      plan,
      runningNowAtPeak: runningNow ? assessLive(r.profile, runningNow, input.rps) : null,
      estimateAtPeak: assessLive(r.profile, r.estimate.size, input.rps),
      templates,
    };
  }),

  /** Sudden ramps in the last ≤14 days of edge traffic (per-minute ALB metrics). */
  trafficPeaks: protectedProcedure.input(z.object({ tier: z.enum(["staging", "production"]), days: z.number().int().min(1).max(14).default(7) })).query(({ input }) => trafficPeaks(input.tier, input.days)),

  /** One event minute by minute (≤3 h): req/s, p95, 5xx, pods + CPU per modelled workload, node CPU. */
  trafficWindow: protectedProcedure
    .input(z.object({ tier: z.enum(["staging", "production"]), from: z.string().datetime(), to: z.string().datetime() }))
    .query(async ({ input }) => {
      const { profiles } = await presetsAndProfiles();
      return trafficWindow(input.tier, input.from, input.to, profiles?.tiers[input.tier]?.live);
    }),

  /** The case library (twizz-gitops capacity/cases.yaml), each replayed against today's
   * profile: what ran vs its peak, and what the recommendation would do. */
  cases: protectedProcedure.input(z.object({ tier: z.enum(["staging", "production"]).optional() }).optional()).query(async ({ input }) => {
    const [cases, { presets, profiles }] = await Promise.all([capacityCases(), presetsAndProfiles()]);
    return {
      cases: cases
        .filter((c) => !input?.tier || c.tier === input.tier)
        .map((c) => {
          const profile = profiles?.tiers[c.tier]?.live;
          if (!profile) return { ...c, replay: null };
          const rec = c.recommend.template ? presets.find((p) => p.name === c.recommend.template)?.tiers[c.tier]?.live : undefined;
          return {
            ...c,
            replay: {
              whatRan: assessLive(profile, caseSizing(c), c.edge.peakRps),
              recommendedTemplate: rec ? assessLive(profile, rec, c.edge.peakRps) : null,
            },
          };
        }),
    };
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
