import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { CapacityPreset, TierSize, type ServiceSize } from "@twizz-idp/shared";
import {
  CAPACITY_TARGETS,
  NODEPOOL_FILE,
  WARM_FILE,
  applyCapacity,
  capacityBranch,
  estimateTier,
  exportPlan,
  hashSize,
  listCapacityPrs,
  mergeCapacityPr,
  nearestPreset,
  parseCapacityBranch,
  parsePresets,
  planCapacity,
  readCurrentTier,
  readNodeSize,
  readServiceSize,
  renderNodeSize,
  renderServiceSize,
  setAtlasTier,
  warmReplicas,
  type AtlasClusters,
} from "../capacity";
import { evaluatePolicy, loadPolicyFile } from "../policy";
import { FakePromotions } from "./fakes";

const FFMPEG = `nameOverride: ffmpeg-service
replicaCount: 1 # one is plenty off-peak
image:
  repository: 848281935985.dkr.ecr.eu-west-1.amazonaws.com/molyffmpeg
  tag: dev
resources:
  requests: { cpu: 250m, memory: 512Mi }
  limits: { cpu: "1", memory: 2Gi }
autoscaling:
  enabled: false
`;

const NODEPOOL = `# mirrors Pulumi
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: spot
spec:
  limits:
    cpu: "48"
    memory: 96Gi
`;

const WARM = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: warm-capacity
spec:
  replicas: 0 # Nebula sets this
  template:
    spec:
      containers:
        - name: pause
          image: registry.k8s.io/pause:3.10
          resources:
            requests: { cpu: "1", memory: 2Gi }
`;

const big: ServiceSize = {
  replicas: 2,
  requests: { cpu: "500m", memory: "1Gi" },
  limits: { cpu: "1", memory: "2Gi" },
  autoscaling: { enabled: true, minReplicas: 2, maxReplicas: 4, targetCPUUtilizationPercentage: 70 },
};

function repo() {
  const p = new FakePromotions();
  for (const n of ["ffmpeg-service", "lolygram-discovery", "alertservice"]) p.main.set(`apps/shared/${n}.yaml`, FFMPEG.replace(/ffmpeg-service/g, n));
  p.main.set(NODEPOOL_FILE, NODEPOOL);
  p.main.set(WARM_FILE, WARM);
  return p;
}

describe("values surgery", () => {
  it("reads and rewrites sizing, keeping comments and other keys", () => {
    expect(readServiceSize(FFMPEG)).toEqual({ replicas: 1, requests: { cpu: "250m", memory: "512Mi" }, limits: { cpu: "1", memory: "2Gi" }, autoscaling: undefined });
    const out = renderServiceSize(FFMPEG, big);
    expect(out).toContain("# one is plenty off-peak");
    expect(out).toContain("tag: dev");
    expect(readServiceSize(out)).toEqual(big);
    expect(parse(out).limits).toBeUndefined();
  });

  it("turns an HPA off without deleting the block", () => {
    const on = renderServiceSize(FFMPEG, big);
    const off = renderServiceSize(on, { ...big, autoscaling: undefined });
    expect(parse(off).autoscaling.enabled).toBe(false);
  });

  it("refuses a file that is not chart values", () => {
    expect(() => renderServiceSize("foo: 1\n", big)).toThrow(/image/);
  });

  it("node pool + warm pods", () => {
    expect(readNodeSize(NODEPOOL, WARM)).toEqual({ maxCpu: 48, maxMemoryGi: 96, warmCpu: 0, warmMemoryGi: 0 });
    const r = renderNodeSize(NODEPOOL, WARM, { maxCpu: 96, maxMemoryGi: 192, warmCpu: 3, warmMemoryGi: 8 });
    expect(r.nodePool).toContain("# mirrors Pulumi");
    expect(parse(r.nodePool).spec.limits).toEqual({ cpu: "96", memory: "192Gi" });
    // 3 vCPU → 3 units, 8Gi → 4 units: the larger wins
    expect(parse(r.warm).spec.replicas).toBe(4);
    expect(warmReplicas(0, 0, { cpu: 1, memGi: 2 })).toBe(0);
  });
});

describe("planCapacity", () => {
  it("plans only changed rows, renders files, computes cost", async () => {
    const t = CAPACITY_TARGETS.preview;
    const current = await readCurrentTier(repo(), t, { instanceSize: "M10" });
    const plan = planCapacity(t, current, TierSize.parse({ services: { "ffmpeg-service": big }, nodes: { maxCpu: 96, maxMemoryGi: 192, warmCpu: 2, warmMemoryGi: 4 }, atlas: { instanceSize: "M20" } }));
    expect(plan.violations).toEqual([]);
    expect(Object.keys(plan.files).sort()).toEqual(["apps/shared/ffmpeg-service.yaml", NODEPOOL_FILE, WARM_FILE].sort());
    expect(plan.services.find((s) => s.service === "ffmpeg-service")!.changes).toHaveLength(3);
    expect(plan.services.find((s) => s.service === "alertservice")!.changes).toEqual([]);
    expect(plan.atlas!.changes).toEqual(["Atlas M10 → M20"]);
    expect(plan.cost.after).toBeGreaterThan(plan.cost.before!);
  });

  it("never scales to zero or starves a service", async () => {
    const t = CAPACITY_TARGETS.preview;
    const current = await readCurrentTier(repo(), t);
    const plan = planCapacity(t, current, TierSize.parse({ services: { "ffmpeg-service": { ...big, replicas: 0, autoscaling: undefined }, alertservice: { ...big, requests: { cpu: "10m", memory: "32Mi" }, limits: { cpu: "1", memory: "64Mi" } } } }));
    const v = plan.violations.join("\n");
    expect(v).toMatch(/ffmpeg-service: 0 replicas/);
    expect(v).toMatch(/below the 50m floor/);
    expect(v).toMatch(/below the 64Mi floor/);
    expect(v).toMatch(/memory limit 64Mi is below the 128Mi floor/);
    expect(plan.warnings.join("\n")).toMatch(/OOMKill/);
  });

  it("refuses a node ceiling below what the pool runs now; warm capacity settles in whole units", async () => {
    const t = CAPACITY_TARGETS.preview;
    const current = await readCurrentTier(repo(), t);
    const low = planCapacity(t, current, TierSize.parse({ nodes: { maxCpu: 8, maxMemoryGi: 16 } }), { nodePoolUsedCpu: 12 });
    expect(low.violations.join()).toMatch(/below the 12 vCPU/);
    const plan = planCapacity(t, current, TierSize.parse({ nodes: { maxCpu: 48, maxMemoryGi: 96, warmCpu: 1.5, warmMemoryGi: 3 } }));
    expect(plan.nodes!.after.warmCpu).toBe(2);
    const settled = { ...current, nodes: plan.nodes!.after, files: { ...current.files, ...plan.files } };
    const again = planCapacity(t, settled, TierSize.parse({ nodes: { maxCpu: 48, maxMemoryGi: 96, warmCpu: 1.5, warmMemoryGi: 3 } }));
    expect(again.nodes!.changes).toEqual([]);
    expect(again.files).toEqual({});
  });

  it("warns when an HPA takes over replicas", async () => {
    const t = CAPACITY_TARGETS.preview;
    const plan = planCapacity(t, await readCurrentTier(repo(), t), TierSize.parse({ services: { "ffmpeg-service": big } }));
    expect(plan.warnings.join()).toMatch(/HPA/);
  });

  it("flags caps", async () => {
    const t = CAPACITY_TARGETS.preview;
    const current = await readCurrentTier(repo(), t);
    const plan = planCapacity(t, current, TierSize.parse({ services: { "ffmpeg-service": { ...big, autoscaling: { ...big.autoscaling!, maxReplicas: 50 } } }, nodes: { maxCpu: 1000, maxMemoryGi: 2000 }, atlas: { instanceSize: "M80" } }));
    expect(plan.violations.join("\n")).toMatch(/50 replicas exceeds/);
    expect(plan.violations.join("\n")).toMatch(/1000 vCPU exceeds/);
    expect(plan.violations.join("\n")).toMatch(/M80 exceeds/);
  });

  it("prod rows are plan-only and exportable, never files", async () => {
    const t = CAPACITY_TARGETS.production;
    const current = await readCurrentTier(repo(), t);
    const plan = planCapacity(t, current, TierSize.parse({ services: { "moly-backend": big }, nodes: { maxCpu: 64, maxMemoryGi: 128 } }));
    expect(plan.files).toEqual({});
    expect(plan.services.every((s) => !s.writable)).toBe(true);
    expect(plan.nodes!.writable).toBe(false);
    expect(parse(exportPlan(plan)).services["moly-backend"].replicaCount).toBe(2);
  });
});

describe("estimateTier", () => {
  it("sizes from rps and clamps to caps", () => {
    const t = CAPACITY_TARGETS.preview;
    const profile = {
      services: { "ffmpeg-service": { rpsPerPod: 5, requests: { cpu: "500m", memory: "1Gi" }, limits: { cpu: "1", memory: "2Gi" }, minReplicas: 1, maxReplicas: 6, dbConnsPerPod: 0, hpa: true, hpaBurst: 2 } },
      nodes: { baseCpu: 24, baseMemoryGi: 48, overhead: 1.15, warmFraction: 0.5 },
      atlas: { workingSetGi: 1, minTier: "M10" as const },
    };
    const e = estimateTier(t, profile, { rps: 10, peakFactor: 1, headroom: 1 });
    expect(e.size.services["ffmpeg-service"].replicas).toBe(2);
    expect(e.size.services["ffmpeg-service"].autoscaling).toMatchObject({ minReplicas: 2, maxReplicas: 4 });
    expect(e.size.nodes!.maxCpu % 4).toBe(0);
    expect(e.size.atlas!.instanceSize).toBe("M10");
    const huge = estimateTier(t, profile, { rps: 10_000, peakFactor: 2, headroom: 1.3 });
    expect(huge.size.services["ffmpeg-service"].replicas).toBe(6);
  });

  it("finds the nearest preset", () => {
    const presets = [
      CapacityPreset.parse({ name: "quiet", title: "Quiet", tiers: { preview: { services: { "ffmpeg-service": { ...big, replicas: 1, autoscaling: undefined } } } } }),
      CapacityPreset.parse({ name: "peak", title: "Peak", tiers: { preview: { services: { "ffmpeg-service": { ...big, replicas: 6, autoscaling: undefined } } } } }),
    ];
    expect(nearestPreset(presets, "preview", { services: { "ffmpeg-service": { ...big, replicas: 5, autoscaling: undefined } } })).toBe("peak");
  });

  it("rejects preset names with prod in them", () => {
    expect(() => parsePresets("presets:\n  - name: preprod\n    title: x\n    tiers: {}\n")).toThrow();
  });
});

describe("capacity PRs", () => {
  it("opens one PR, is idempotent, merges sha-pinned", async () => {
    const p = repo();
    const size = TierSize.parse({ services: { "ffmpeg-service": big }, nodes: { maxCpu: 96, maxMemoryGi: 192, warmCpu: 2, warmMemoryGi: 4 } });
    const a = await applyCapacity({ promotions: p }, { tier: "preview", label: "campaign", size, actor: "nick" });
    expect(a.existing).toBe(false);
    expect(a.branch).toBe(capacityBranch("preview", "campaign", hashSize(size)));
    expect(p.prs[0].files[NODEPOOL_FILE]).toContain('cpu: "96"');
    expect(p.prs[0].body).toContain("apply **campaign** to **preview**");
    const b = await applyCapacity({ promotions: p }, { tier: "preview", label: "campaign", size, actor: "nick" });
    expect(b.existing).toBe(true);
    expect(p.prs).toHaveLength(1);

    expect((await listCapacityPrs({ promotions: p })).map((x) => x.label)).toEqual(["campaign"]);
    const headSha = p.prs[0].headSha;
    await expect(mergeCapacityPr({ promotions: p }, { prNumber: a.prNumber, tier: "preview", label: "peak", headSha, actor: "nick" })).rejects.toThrow(/not peak/);
    await expect(mergeCapacityPr({ promotions: p }, { prNumber: a.prNumber, tier: "preview", label: "campaign", headSha: "deadbeef", actor: "nick" })).rejects.toThrow(/moved/);
    p.baseChanges.set(a.branch, ["apps/shared/ffmpeg-service.yaml"]);
    await expect(mergeCapacityPr({ promotions: p }, { prNumber: a.prNumber, tier: "preview", label: "campaign", headSha, actor: "nick" })).rejects.toThrow(/re-apply/);
    p.baseChanges.set(a.branch, ["named-envs/foo.yaml"]); // unrelated main churn is fine
    const m = await mergeCapacityPr({ promotions: p }, { prNumber: a.prNumber, tier: "preview", label: "campaign", headSha, actor: "nick" });
    expect(m.mergedSha).toBe(`merge-${a.prNumber}`);
    expect(readServiceSize(p.main.get("apps/shared/ffmpeg-service.yaml")!)).toEqual(big);
  });

  it("refuses a second open PR per tier, and merges of PRs that touch other files", async () => {
    const p = repo();
    const one = TierSize.parse({ services: { "ffmpeg-service": big } });
    const two = TierSize.parse({ services: { "alertservice": big } });
    await applyCapacity({ promotions: p }, { tier: "preview", label: "campaign", size: one, actor: "nick" });
    await expect(applyCapacity({ promotions: p }, { tier: "preview", label: "peak", size: two, actor: "nick" })).rejects.toThrow(/already open/);
    // a different tier is independent
    p.main.set("apps/twizz-sentinel/values-staging.yaml", FFMPEG.replace(/ffmpeg-service/g, "twizz-sentinel"));
    await applyCapacity({ promotions: p }, { tier: "staging", label: "peak", size: TierSize.parse({ services: { "twizz-sentinel": big } }), actor: "nick" });
    // someone pushes an extra file onto the capacity branch
    p.prs[0].files["bootstrap/evil.yaml"] = "x: 1";
    await expect(mergeCapacityPr({ promotions: p }, { prNumber: p.prs[0].number, tier: "preview", label: "campaign", headSha: p.prs[0].headSha, actor: "nick" })).rejects.toThrow(/outside/);
  });

  it("refuses prod, no-op and over-cap", async () => {
    const p = repo();
    await expect(applyCapacity({ promotions: p }, { tier: "production", label: "peak", size: TierSize.parse({}), actor: "nick" })).rejects.toThrow(/plan-only/);
    await expect(applyCapacity({ promotions: p }, { tier: "preview", label: "normal", size: TierSize.parse({ services: { "ffmpeg-service": readServiceSize(FFMPEG)! } }), actor: "nick" })).rejects.toThrow(/nothing to change/);
    await expect(applyCapacity({ promotions: p }, { tier: "preview", label: "peak", size: TierSize.parse({ services: { "ffmpeg-service": { ...big, replicas: 40, autoscaling: undefined } } }), actor: "nick" })).rejects.toThrow(/caps/);
    expect(p.prs).toHaveLength(0);
  });

  it("parses only well-formed capacity branches", () => {
    expect(parseCapacityBranch("capacity/preview/campaign-0123abcd")).toEqual({ tier: "preview", label: "campaign", hash8: "0123abcd" });
    expect(parseCapacityBranch("capacity/production/peak-0123abcd")).toBeNull();
    expect(parseCapacityBranch("promote/x/staging/main-1")).toBeNull();
  });
});

describe("setAtlasTier", () => {
  class FakeAtlas implements AtlasClusters {
    calls: Array<{ cluster: string; size: unknown }> = [];
    constructor(public state = "IDLE") {}
    async getTier(cluster: string) {
      return cluster === "NonProd-Twizz" ? { instanceSize: "M10" as const, state: this.state } : null;
    }
    async setTier(cluster: string, size: unknown) {
      this.calls.push({ cluster, size });
      return { state: "UPDATING" };
    }
  }

  it("resizes the NonProd cluster only, within caps, when idle", async () => {
    const atlas = new FakeAtlas();
    const r = await setAtlasTier({ atlas }, { tier: "preview", size: { instanceSize: "M20" }, actor: "nick" });
    expect(r).toMatchObject({ cluster: "NonProd-Twizz", from: "M10", to: "M20" });
    await expect(setAtlasTier({ atlas }, { tier: "preview", size: { instanceSize: "M60" }, actor: "nick" })).rejects.toThrow(/cap/);
    await expect(setAtlasTier({ atlas }, { tier: "staging", size: { instanceSize: "M20" }, actor: "nick" })).rejects.toThrow(/plan-only/);
    await expect(setAtlasTier({ atlas }, { tier: "production", size: { instanceSize: "M20" }, actor: "nick" })).rejects.toThrow(/plan-only/);
    await expect(setAtlasTier({ atlas: new FakeAtlas("UPDATING") }, { tier: "preview", size: { instanceSize: "M20" }, actor: "nick" })).rejects.toThrow(/IDLE/);
    expect(atlas.calls).toHaveLength(1);
  });
});

describe("policy.yaml", () => {
  const policy = loadPolicyFile(new URL("../../../../apps/mcp/policy.yaml", import.meta.url).pathname);
  it("allows the writable tiers and denies production twice over", () => {
    expect(evaluatePolicy(policy, "apply_capacity_preset", { tier: "preview", preset: "campaign", sizeHash: "ab" }).allowed).toBe(true);
    expect(evaluatePolicy(policy, "apply_capacity_preset", { tier: "staging", preset: "custom-1a2b3c4d", sizeHash: "ab" }).allowed).toBe(true);
    expect(evaluatePolicy(policy, "apply_capacity_preset", { tier: "production", preset: "peak", sizeHash: "ab" })).toMatchObject({ allowed: false, reason: expect.stringMatching(/global deny/) });
    expect(evaluatePolicy(policy, "set_atlas_tier", { tier: "preview", instanceSize: "M20", autoScaling: "off" }).allowed).toBe(true);
    expect(evaluatePolicy(policy, "set_atlas_tier", { tier: "staging", instanceSize: "M20", autoScaling: "off" }).allowed).toBe(false);
    expect(evaluatePolicy(policy, "set_atlas_tier", { tier: "preview", instanceSize: "M60", autoScaling: "off" }).allowed).toBe(false);
    expect(evaluatePolicy(policy, "merge_capacity_pr", { tier: "preview", preset: "campaign", pr: "12", headSha: "a".repeat(40) }).allowed).toBe(true);
    expect(evaluatePolicy(policy, "merge_capacity_pr", { tier: "preview", preset: "campaign", pr: "12" }).allowed).toBe(false);
  });
});
