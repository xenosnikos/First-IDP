import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { AtlasSize, CAPACITY_TIERS, EstimateInput, EstimateLiveInput, TierSize, type CapacityTier, type LiveTierSize } from "@twizz-idp/shared";
import { BASELINE_TEMPLATE, LIVE_TARGETS, PROD_ATLAS, assessLive, caseSizing, recommendTemplate, verifyLive, describeLiveOp, estimateLive, planProdAtlas, estimateTier, exportPlan, hashSize, isLiveTier, listCapacityPrs, liveAsSize, nearestPreset, planCapacity, planLive, type LiveTier } from "@twizz-idp/actions";
import { capacityCases, trafficPeaks, trafficWindow } from "../nebula/traffic";
import { monitorSnapshot } from "../nebula/monitor";
import { watchVerdict } from "../nebula/watch-model";
import { isOperator } from "@/lib/nebula/operators";
import type { ImageInfo } from "@twizz-idp/actions";

const imageCache = new Map<string, { at: number; v: ImageInfo[] }>();
let oldestImageRead = Infinity;
async function cachedImages(repo: string, load: () => Promise<ImageInfo[]>): Promise<ImageInfo[]> {
  const hit = imageCache.get(repo);
  if (hit && Date.now() - hit.at < 5 * 60_000) {
    oldestImageRead = Math.min(oldestImageRead, hit.at);
    return hit.v;
  }
  const v = await load();
  imageCache.set(repo, { at: Date.now(), v });
  return v;
}
import { router, protectedProcedure } from "../trpc";
import { namedEnvDeps } from "../nebula/deps";
import { type CapacitySources, currentFor, liveTemplateOpts, nodePoolUsedCpu, observe, presetsAndProfiles, prodAtlasPort, readLive, readProdAtlas, targetFor } from "../nebula/capacity";

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
export async function resolveEstimate(tier: LiveTier, est: EstimateLiveInput, pinned?: CapacitySources) {
  const { presets, profiles, presetsError, profilesError } = pinned ? { ...pinned, presetsError: undefined, profilesError: undefined } : await presetsAndProfiles();
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
export async function resolveSize(tier: CapacityTier, input: { preset?: string; custom?: TierSize; estimate?: EstimateLiveInput }, pinned?: CapacitySources): Promise<{ label: string; size: TierSize }> {
  if (input.estimate) {
    if (!isLiveTier(tier)) throw new TRPCError({ code: "BAD_REQUEST", message: "traffic estimates size the live tiers (staging, production) only" });
    const r = await resolveEstimate(tier, input.estimate, pinned);
    return { label: r.label, size: r.size };
  }
  if (input.custom) return { label: "custom", size: input.custom };
  if (!input.preset) throw new TRPCError({ code: "BAD_REQUEST", message: "pick a preset or a custom size" });
  const { presets, presetsError } = pinned ? { presets: pinned.presets, presetsError: undefined } : await presetsAndProfiles();
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

  /** Rollout validation (§N5.4): is the live cluster at the target of a template or an
   * estimate — spec, ready pods, joined nodes — and how does it hold at the load right now? */
  verify: protectedProcedure
    .input(z.object({ tier: z.enum(["staging", "production"]), preset: z.string().max(24).optional(), estimate: EstimateLiveInput.optional() }).refine((v) => (v.preset === undefined) !== (v.estimate === undefined), "give exactly one of preset or estimate"))
    .query(async ({ input }) => {
      const { label, size } = await resolveSize(input.tier, input);
      if (!size.live) throw new TRPCError({ code: "BAD_REQUEST", message: `"${label}" has no live sizing for ${input.tier}` });
      const live = await readLive(input.tier);
      if ("error" in live) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `${LIVE_TARGETS[input.tier].cluster} not readable: ${live.error}` });
      const check = verifyLive(live.state, size.live);
      const now = Date.now();
      const { profiles } = await presetsAndProfiles();
      const profile = profiles?.tiers[input.tier]?.live;
      const w = await trafficWindow(input.tier, new Date(now - 10 * 60_000).toISOString(), new Date(now).toISOString(), profile).catch(() => null);
      const peak = w ? Math.max(0, ...w.minutes.map((m) => m.rps)) : null;
      return {
        tier: input.tier,
        target: label,
        readAt: live.state.readAt,
        check,
        loadNow: { peakRps10m: peak, p95MsLast: w?.minutes.filter((m) => m.p95Ms !== null).at(-1)?.p95Ms ?? null, assessment: profile && peak !== null ? assessLive(profile, liveAsSize(LIVE_TARGETS[input.tier], live.state), peak) : null },
      };
    }),

  /** Event watch (§N5.4): the last N minutes, the monitor's signals, and OK / WATCH / ACT
   * with the next step if capacity is short. Read-only: acting is apply_live_capacity. */
  watch: protectedProcedure.input(z.object({ tier: z.enum(["staging", "production"]), minutes: z.number().int().min(5).max(60).default(15) })).query(async ({ input }) => {
    const now = Date.now();
    const [{ presets, profiles }, live, snap] = await Promise.all([presetsAndProfiles(), readLive(input.tier), monitorSnapshot(input.tier, "15m").catch((e) => ({ error: String((e as Error).message ?? e) }))]);
    const profile = profiles?.tiers[input.tier]?.live;
    const w = await trafficWindow(input.tier, new Date(now - input.minutes * 60_000).toISOString(), new Date(now).toISOString(), profile);
    const withRps = w.minutes.filter((m) => m.rps > 0);
    const peak = Math.max(0, ...withRps.map((m) => m.rps));
    const p95s = w.minutes.map((m) => m.p95Ms).filter((v): v is number => v !== null);
    const p95Last = p95s.at(-1) ?? null;
    const p95Max = p95s.length ? Math.max(...p95s) : null;
    const nodesLast = [...w.minutes].reverse().find((m) => m.nodes)?.nodes ?? null;
    const recentPods = w.minutes.slice(-5).flatMap((m) => Object.values(m.workloads).map((x) => x.mcpuAvg));
    const running = "state" in live ? liveAsSize(LIVE_TARGETS[input.tier], live.state) : null;
    const atPeak = profile && running ? assessLive(profile, running, peak) : null;
    const atMargin = profile && running ? assessLive(profile, running, peak * 1.3) : null;
    const requests = w.minutes.reduce((a, m) => a + m.rps * 60, 0);
    const err5xx = w.minutes.reduce((a, m) => a + m.err5xx, 0);
    const v = watchVerdict({
      peakRps: peak,
      requests,
      err5xx,
      p95MsLast: p95Last,
      nodes: nodesLast,
      maxPodMcpu: recentPods.length ? Math.max(...recentPods) : null,
      atPeak,
      atPeakPlus30: atMargin,
      signals: "error" in snap ? null : snap.signals,
      edgeData: withRps.length > 0,
      podData: w.podMetrics,
    });
    const templates = presets.filter((p) => p.tiers[input.tier]?.live).map((p) => ({ name: p.name, size: p.tiers[input.tier]!.live! }));
    // recommend scaling ONLY on capacity evidence, and never below what runs (no downsizing mid-incident)
    const next = v.capacityShort && profile && running ? recommendTemplate(profile, templates, Math.max(peak * 1.3, 1), running) : null;
    const status = v.status;
    const reasons = v.reasons;
    return {
      tier: input.tier,
      window: { from: w.from, to: w.to, minutes: input.minutes },
      status,
      reasons,
      edge: { peakRps: peak, lastRps: withRps.at(-1)?.rps ?? null, p95MsLast: p95Last, p95MsMax: p95Max, err5xx: w.minutes.reduce((a, m) => a + m.err5xx, 0) },
      nodes: nodesLast,
      running,
      atPeak,
      atPeakPlus30: atMargin,
      capacityEvidence: v.capacityEvidence,
      dataGaps: v.dataGaps,
      recommend: next
        ? { template: next.name, assessment: next.assessment, then: `capacity_plan {tier: "${input.tier}", preset: "${next.name}"} → apply_live_capacity` }
        : v.capacityShort
          ? { template: null, then: `no named template at least as large as what runs holds ${Math.round(peak * 1.3)} req/s: capacity_estimate {tier: "${input.tier}", rps: ${Math.round(peak * 1.3)}}` }
          : status !== "OK"
            ? { template: null, then: "not a capacity problem by the evidence: diagnose (recent_changes, fetch_logs errorsOnly, monitor DB) before scaling" }
            : null,
      signals: "error" in snap ? { error: snap.error } : { window: "15m", at: snap.at, items: snap.signals },
      minutes: w.minutes,
      podMetrics: w.podMetrics,
    };
  }),

  /** What changed (§N5.4): Nebula's audited writes (capacity, promotions, envs, …) and the
   * image pushes of the prod services in a window — the first question of any outage. */
  recentChanges: protectedProcedure
    .input(z.object({ from: z.string().datetime(), to: z.string().datetime().optional() }))
    .query(async ({ ctx, input }) => {
      // other people's audited activity: operators only (Codex review)
      const login = (ctx.session as { login?: string } | null)?.login;
      if (!isOperator(login)) {
        await ctx.prisma.auditLog.create({ data: { actor: login ?? "unknown", action: "nebula.recent_changes", allowed: false, detail: { reason: "not a Nebula operator" } } }).catch(() => {});
        throw new TRPCError({ code: "FORBIDDEN", message: "recent changes (who did what) are for Nebula operators" });
      }
      const from = new Date(input.from);
      const to = input.to ? new Date(input.to) : new Date();
      if (!(to > from)) throw new TRPCError({ code: "BAD_REQUEST", message: "`to` must be after `from`" });
      if (to.getTime() - from.getTime() > 7 * 24 * 3600_000) throw new TRPCError({ code: "BAD_REQUEST", message: "at most 7 days" });
      const rows = await ctx.prisma.auditLog.findMany({
        where: { createdAt: { gte: from, lte: to }, allowed: true, OR: [{ action: { startsWith: "nebula." } }, { action: { startsWith: "mcp.intent." } }], NOT: { action: { startsWith: "nebula.observer." } } },
        orderBy: { createdAt: "asc" },
        take: 201,
        select: { createdAt: true, actor: true, action: true, resource: true, detail: true },
      });
      const truncated = rows.length > 200;
      if (truncated) rows.length = 200;
      const PROD_REPOS = ["molybackend", "lolygramdiscovery", "alertservice", "invoicegen", "sendgridwebhook", "emailservice", "paymentserv", "twizz-sentinel", "twizz-admin"];
      const images = namedEnvDeps().images;
      const repoErrors: Array<{ repo: string; error: string }> = [];
      oldestImageRead = Infinity;
      const pushes = (
        await Promise.all(
          PROD_REPOS.map(async (repo) => {
            try {
              return (await cachedImages(repo, () => images.listImages(repo)))
                .filter((i) => i.pushedAt && i.pushedAt >= from && i.pushedAt <= to)
                .map((i) => ({ at: i.pushedAt!.toISOString(), repo, tags: i.tags.slice(0, 3) }));
            } catch (e) {
              repoErrors.push({ repo, error: String((e as Error).message ?? e).slice(0, 160) });
              return [];
            }
          }),
        )
      ).flat().sort((a, b) => a.at.localeCompare(b.at));
      return {
        from: from.toISOString(),
        to: to.toISOString(),
        nebulaWrites: rows.map((r) => ({ at: r.createdAt.toISOString(), actor: r.actor, action: r.action, resource: r.resource, summary: String((r.detail as { summary?: string } | null)?.summary ?? "").split("\n")[0].slice(0, 200) })),
        imagePushes: pushes,
        truncated: truncated ? "only the first 200 Nebula writes in this window are shown: narrow it" : undefined,
        repoErrors: repoErrors.length ? repoErrors : undefined,
        imagesAsOf: Number.isFinite(oldestImageRead) ? new Date(oldestImageRead).toISOString() : new Date().toISOString(),
        note: "prod Moly services deploy outside Nebula (CodeBuild → ECR → rollout): an image push shortly before an incident is a likely deploy",
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
