import { describe, expect, it } from "vitest";
import { LIVE_TARGETS } from "../live-capacity";
import { assessLive, caseSizing, estimateLive, findBursts, parseCases, recommendTemplate, rpsPerPod, verifyLive } from "../traffic";
import type { LiveProfile, LiveTierSize } from "@twizz-idp/shared";

// The production profile as calibrated from case 2026-11-05-midnight-burst.
const PROFILE: LiveProfile = {
  workloads: { "moly-backend-deployment": { share: 1, mcpuPerRps: 15.5, baseMcpu: 30, targetMcpu: 600, nodegroup: "eks-prod-node-group-m5-2x-extra" } },
  nodegroups: { "eks-prod-node-group-m5-2x-extra": { allocatableCpu: 7.6, reservedCpu: 4, headroom: 1.15, burst: 1.4 } },
  calibratedFrom: ["2026-11-05-midnight-burst"],
};
const BASELINE: LiveTierSize = {
  workloads: { "moly-backend-deployment": { replicas: 40 }, "lolygram-discovery-deployment": { replicas: 20 } },
  nodegroups: { "eks-prod-node-group-m5-2x-extra": { min: 5, desired: 5, max: 8 } },
};
const P = LIVE_TARGETS.production;

describe("estimateLive (req/s → pods + nodes on the live cluster)", () => {
  it("sizes last night's 2,500 req/s peak at ~60% per pod and the node group under 85%", () => {
    const e = estimateLive(P, PROFILE, { rps: 2500, peakFactor: 1, headroom: 1.2 }, BASELINE);
    expect(e.designRps).toBe(3000);
    expect(rpsPerPod(PROFILE.workloads["moly-backend-deployment"])).toBeCloseTo(36.8, 1);
    expect(e.size.workloads["moly-backend-deployment"].replicas).toBe(82);
    expect(e.size.nodegroups["eks-prod-node-group-m5-2x-extra"]).toEqual({ min: 9, desired: 9, max: 13 });
    expect(e.workloads[0].mcpuPerPodAtDesign).toBeLessThan(620);
    expect(e.warnings).toEqual([]);
  });

  it("never goes below the baseline template (a quiet night still gets baseline)", () => {
    const e = estimateLive(P, PROFILE, { rps: 150, peakFactor: 1, headroom: 1.2 }, BASELINE);
    expect(e.size.workloads["moly-backend-deployment"].replicas).toBe(40);
    expect(e.size.nodegroups["eks-prod-node-group-m5-2x-extra"].desired).toBe(5);
    expect(e.workloads[0].flooredBy).toBe(40);
  });

  it("caps at the live caps and says so (never silently)", () => {
    const e = estimateLive(P, PROFILE, { rps: 8000, peakFactor: 1, headroom: 1.2 }, BASELINE);
    expect(e.size.workloads["moly-backend-deployment"].replicas).toBe(P.caps.maxReplicas);
    expect(e.workloads[0].cappedAt).toBe(P.caps.maxReplicas);
    expect(e.warnings.join(" ")).toMatch(/cap/);
  });

  it("leaves workloads the profile doesn't model out of the sizing (they stay as they run)", () => {
    const e = estimateLive(P, PROFILE, { rps: 2500, peakFactor: 1, headroom: 1.2 }, BASELINE);
    expect(Object.keys(e.size.workloads)).toEqual(["moly-backend-deployment"]);
  });
});

describe("assessLive replays a case: the profile must predict what actually happened", () => {
  const CASE_YAML = `cases:
  - id: 2026-11-05-midnight-burst
    tier: production
    title: Midnight burst
    window: { from: "2026-11-05T22:15:00Z", to: "2026-11-05T22:30:00Z" }
    edge: { baselineRps: 131, peakRps: 2327, rampMinutes: 2, durationMinutes: 12 }
    ran:
      workloads: { moly-backend-deployment: { replicas: 40, peakMcpuPerPod: 819 } }
      nodegroups: { eks-prod-node-group-m5-2x-extra: { desired: 5, peakCpuPct: 91 } }
    outcome: { p95MsBefore: 280, p95MsMax: 9508, err5xx: 6, verdict: "saturated" }
    recommend: { rps: 2500, headroom: 1.2, template: campaign }
`;
  const [c] = parseCases(CASE_YAML);

  it("what ran last night at 2,327 req/s is SATURATED — as observed (pods ~1 core, nodes 91–99%)", () => {
    const a = assessLive(PROFILE, caseSizing(c), c.edge.peakRps);
    expect(a.verdict).toBe("SATURATED");
    expect(a.workloads[0].mcpuPerPod).toBeGreaterThan(850); // measured: 819 avg, 998 max
    expect(a.nodegroups[0].cpuPct).toBeGreaterThan(90); // measured: 91 avg, 99 max
  });

  it("the campaign template (80 pods, 10 nodes) would have held that peak", () => {
    const campaign: LiveTierSize = { workloads: { "moly-backend-deployment": { replicas: 80 } }, nodegroups: { "eks-prod-node-group-m5-2x-extra": { min: 8, desired: 10, max: 14 } } };
    expect(assessLive(PROFILE, campaign, c.edge.peakRps).verdict).toBe("OK");
  });
});

describe("findBursts", () => {
  it("finds the 00:17 ramp in last night's per-minute series", () => {
    const t0 = Date.parse("2026-11-05T22:00:00Z");
    const rps = [167, 158, 136, 143, 141, 125, 134, 127, 133, 127, 127, 131, 119, 120, 118, 132, 132, 201, 1422, 2327, 2061, 1583, 1123, 823, 643, 504, 446, 398, 398, 385, 355, 306, 288, 249];
    const series = rps.map((v, k) => [t0 + k * 60_000, v] as [number, number]);
    const [b] = findBursts(series);
    expect(b).toMatchObject({ peakRps: 2327, baselineRps: 131, rampMinutes: 2 });
    expect(new Date(b.start).toISOString()).toBe("2026-11-05T22:18:00.000Z");
    expect(b.ratio).toBeGreaterThan(15);
  });

  it("ignores ordinary drift", () => {
    const t0 = 0;
    const series = Array.from({ length: 60 }, (_, k) => [t0 + k * 60_000, 150 + (k % 7) * 20] as [number, number]);
    expect(findBursts(series)).toEqual([]);
  });
});

describe("verifyLive (rollout validation)", () => {
  const want: LiveTierSize = { workloads: { "moly-backend-deployment": { replicas: 80 } }, nodegroups: { "eks-prod-node-group-m5-2x-extra": { min: 8, desired: 10, max: 14 } } };
  const ng = { name: "eks-prod-node-group-m5-2x-extra", min: 8, desired: 10, max: 14 };
  const nodes = (n: number) => Array.from({ length: n }, () => ({ nodegroup: ng.name }));
  it("READY when spec matches and everything is ready", () => {
    expect(verifyLive({ workloads: [{ name: "moly-backend-deployment", replicas: 80, ready: 80 }], nodegroups: [ng], nodes: nodes(10) }, want).verdict).toBe("READY");
  });
  it("PROGRESSING while pods or nodes are still coming", () => {
    const r = verifyLive({ workloads: [{ name: "moly-backend-deployment", replicas: 80, ready: 61 }], nodegroups: [ng], nodes: nodes(7) }, want);
    expect(r.verdict).toBe("PROGRESSING");
    expect(r.workloads[0].note).toMatch(/19 pod/);
    expect(r.nodegroups[0].note).toMatch(/3 node/);
  });
  it("MISMATCH when the spec isn't what was planned", () => {
    expect(verifyLive({ workloads: [{ name: "moly-backend-deployment", replicas: 40, ready: 40 }], nodegroups: [ng], nodes: nodes(10) }, want).verdict).toBe("MISMATCH");
  });
});

describe("recommendTemplate", () => {
  const tpl = (name: string, pods: number, nodes: number) => ({ name, size: { workloads: { "moly-backend-deployment": { replicas: pods } }, nodegroups: { "eks-prod-node-group-m5-2x-extra": { min: nodes, desired: nodes, max: nodes } } } as LiveTierSize });
  const T3 = [tpl("max", 120, 15), tpl("baseline", 40, 5), tpl("campaign", 80, 10)];
  it("picks the smallest template that is OK at the load", () => {
    expect(recommendTemplate(PROFILE, T3, 600)?.name).toBe("baseline");
    expect(recommendTemplate(PROFILE, T3, 2327)?.name).toBe("campaign");
    expect(recommendTemplate(PROFILE, T3, 3600)?.name).toBe("max");
  });
  it("returns null when no template holds (then it's an estimate, or more than the caps)", () => {
    expect(recommendTemplate(PROFILE, T3, 9000)).toBeNull();
  });
});
