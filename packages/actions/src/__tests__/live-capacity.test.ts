import { describe, expect, it } from "vitest";
import { LiveTierSize } from "@twizz-idp/shared";
import { LIVE_TARGETS, applyLive, liveAsSize, planLive, type LiveClusterPort, type LiveState } from "../live-capacity";

// EKS-Moly-Prod as read on 2026-10-14 (kubectl, read-only).
const PROD = (): LiveState => ({
  tier: "production",
  cluster: "EKS-Moly-Prod",
  readAt: "2026-10-14T13:30:00Z",
  metricsServer: true,
  workloads: [
    { namespace: "default", name: "alert-service-deployment", replicas: 2, ready: 2, container: "alert-service", resources: {} },
    { namespace: "default", name: "invoice-gen-deployment", replicas: 2, ready: 2, container: "invoice-gen", resources: { requests: { cpu: "50m", memory: "900Mi" }, limits: { cpu: "500m", memory: "900Mi" } } },
    { namespace: "default", name: "lolygram-discovery-deployment", replicas: 24, ready: 24, container: "lolygram-discovery", resources: {} },
    { namespace: "default", name: "moly-backend-deployment", replicas: 24, ready: 24, container: "moly-backend", resources: {} },
    { namespace: "default", name: "sendgrid-webhook-deployment", replicas: 2, ready: 2, container: "sendgrid-webhook", resources: {} },
    { namespace: "jobs", name: "email-service-deployment", replicas: 1, ready: 1, container: "email-service", resources: {} },
    { namespace: "jobs", name: "payment-serv-deployment", replicas: 1, ready: 1, container: "payment-serv", resources: {} },
  ],
  nodegroups: [
    { name: "eks-prod-node-group-m5-2x-extra", status: "ACTIVE", instanceTypes: ["m5.2xlarge"], min: 3, desired: 3, max: 5 },
    { name: "eks-prod-node-group-m5-2xlarge", status: "ACTIVE", instanceTypes: ["m5.2xlarge"], min: 2, desired: 2, max: 4 },
  ],
  nodes: Array.from({ length: 5 }, (_, i) => ({ name: `n${i}`, cpuCores: 8, memGi: 31 })),
});

const T = LIVE_TARGETS.production;
const pair = (n: number, hpa?: [number, number]) => {
  const w = { replicas: n, ...(hpa ? { autoscaling: { enabled: true, minReplicas: hpa[0], maxReplicas: hpa[1], targetCPUUtilizationPercentage: 70 } } : {}) };
  return { "moly-backend-deployment": w, "lolygram-discovery-deployment": w };
};

class FakePort implements LiveClusterPort {
  calls: string[] = [];
  constructor(public state: LiveState, private failOn?: string) {}
  async read() {
    return structuredClone(this.state);
  }
  async scale(ns: string, name: string, r: number) {
    if (this.failOn === name) throw new Error("boom");
    this.calls.push(`scale ${ns}/${name} ${r}`);
    this.state.workloads.find((w) => w.name === name)!.replicas = r;
  }
  async upsertHpa(ns: string, name: string, a: { min: number; max: number }, exists: boolean) {
    this.calls.push(`hpa ${exists ? "patch" : "create"} ${ns}/${name} ${a.min}-${a.max}`);
  }
  async updateNodegroup(name: string, s: { desired: number }) {
    this.calls.push(`nodegroup ${name} ${s.desired}`);
  }
}

describe("planLive on the real prod shape", () => {
  it("the live state as a preset is a no-op", () => {
    const p = planLive(T, PROD(), liveAsSize(T, PROD()));
    expect(p.ops).toEqual([]);
    expect(p.violations).toEqual([]);
  });

  it("scales the pair together; others stay baseline; nodes grow first", () => {
    const p = planLive(T, PROD(), LiveTierSize.parse({ workloads: pair(36), nodegroups: { "eks-prod-node-group-m5-2x-extra": { min: 3, desired: 5, max: 8 } } }));
    expect(p.violations).toEqual([]);
    expect(p.ops.map((o) => o.kind)).toEqual(["nodegroup", "scale", "scale"]);
    expect(p.rows.filter((r) => r.after === "baseline (untouched)").map((r) => r.workload)).toContain("alert-service-deployment");
    expect(p.nodegroupRows.find((r) => r.name === "eks-prod-node-group-m5-2xlarge")!.after).toBe("baseline (untouched)");
  });

  it("an uneven pair (e.g. the 30/20 campaign) is allowed with a warning", () => {
    const asym = planLive(T, PROD(), LiveTierSize.parse({ workloads: { "moly-backend-deployment": { replicas: 30 }, "lolygram-discovery-deployment": { replicas: 20 } } }));
    expect(asym.violations).toEqual([]);
    expect(asym.warnings.join()).toMatch(/not scaled symmetrically/);
    expect(asym.ops).toHaveLength(2);
    const half = planLive(T, PROD(), LiveTierSize.parse({ workloads: { "moly-backend-deployment": { replicas: 30 } } }));
    expect(half.violations).toEqual([]);
    expect(half.warnings.join()).toMatch(/only one of them/);
  });

  it("step limits, caps, unknown names", () => {
    const v = planLive(T, PROD(), LiveTierSize.parse({ workloads: { ...pair(80), "alert-service-deployment": { replicas: 1 }, "nope-deployment": { replicas: 2 } }, nodegroups: { "eks-prod-node-group-m5-2xlarge": { min: 1, desired: 1, max: 30 } } })).violations.join("\n");
    expect(v).toMatch(/more than ×3/); // 24 → 80
    expect(v).toMatch(/nope-deployment: no such Deployment/);
    expect(v).toMatch(/max 30 exceeds/);
    // halving is the floor: 2 → 1 is allowed, 24 → 11 is not
    expect(planLive(T, PROD(), LiveTierSize.parse({ workloads: pair(11) })).violations.join()).toMatch(/below ×0.5/);
  });

  it("an HPA: refused on pods without CPU requests (prod's pair today) — it would be inert and undeletable", () => {
    expect(planLive(T, PROD(), LiveTierSize.parse({ workloads: pair(24, [30, 60]) })).violations.join()).toMatch(/no CPU requests/);
  });

  it("an HPA where requests exist: floor raised now; warns when min < running; refused without metrics-server", () => {
    const s = PROD();
    for (const w of s.workloads.filter((x) => (T.pair as readonly string[]).includes(x.name))) w.resources = { requests: { cpu: "250m", memory: "256Mi" } };
    const up = planLive(T, s, LiveTierSize.parse({ workloads: pair(24, [30, 60]) }));
    expect(up.violations).toEqual([]);
    expect(up.ops.filter((o) => o.kind === "hpa")).toHaveLength(2);
    expect(up.ops.filter((o) => o.kind === "scale").map((o) => (o as { to: number }).to)).toEqual([30, 30]);
    const down = planLive(T, s, LiveTierSize.parse({ workloads: pair(24, [12, 48]) }));
    expect(down.warnings.join()).toMatch(/scales it DOWN to 12/);
    expect(planLive(T, { ...s, metricsServer: false }, LiveTierSize.parse({ workloads: pair(24, [24, 48]) })).violations.join()).toMatch(/metrics/);
  });

  it("never deletes an existing HPA", () => {
    const s = PROD();
    for (const w of s.workloads.filter((x) => x.name.startsWith("moly") || x.name.startsWith("lolygram"))) w.hpa = { min: 24, max: 48, targetCPU: 70 };
    expect(planLive(T, s, LiveTierSize.parse({ workloads: pair(24) })).violations.join()).toMatch(/never deletes/);
  });

  it("resources are not sizable on live tiers (RBAC has no `patch deployments`)", () => {
    const p = planLive(T, PROD(), LiveTierSize.parse({ workloads: { "invoice-gen-deployment": { replicas: 2, resources: { limits: { memory: "512Mi" } } } } }));
    expect(p.violations.join()).toMatch(/resource sizing is not available/);
    // restating the current values is not a change
    expect(planLive(T, PROD(), LiveTierSize.parse({ workloads: { "invoice-gen-deployment": { replicas: 2, resources: { limits: { memory: "900Mi" } } } } })).violations).toEqual([]);
  });

  it("step-down rounds up: 3→1 and 5→2 refused, 2→1 and 3→2 allowed", () => {
    const s = PROD();
    s.nodegroups[0] = { ...s.nodegroups[0], min: 1, desired: 3, max: 5 };
    const ng = (desired: number) => planLive(T, s, LiveTierSize.parse({ nodegroups: { "eks-prod-node-group-m5-2x-extra": { min: 1, desired, max: 5 } } })).violations.join();
    expect(ng(1)).toMatch(/below ×0.5/);
    expect(ng(2)).toBe("");
    const two = planLive(T, PROD(), LiveTierSize.parse({ workloads: { "alert-service-deployment": { replicas: 1 } } }));
    expect(two.violations).toEqual([]);
  });

  it("drain guard: one node, one group per apply", () => {
    const s = PROD();
    s.nodegroups = s.nodegroups.map((n) => ({ ...n, min: 1, desired: 4, max: 6 }));
    const bigDrop = planLive(T, s, LiveTierSize.parse({ nodegroups: { "eks-prod-node-group-m5-2x-extra": { min: 1, desired: 2, max: 6 } } })).violations.join();
    expect(bigDrop).toMatch(/shrink one node per apply/);
    const both = planLive(T, s, LiveTierSize.parse({ nodegroups: { "eks-prod-node-group-m5-2x-extra": { min: 1, desired: 3, max: 6 }, "eks-prod-node-group-m5-2xlarge": { min: 1, desired: 3, max: 6 } } })).violations.join();
    expect(both).toMatch(/shrink one group per apply/);
  });

  it("a refused node group: drained to zero / not ACTIVE", () => {
    const s = PROD();
    s.nodegroups[0].status = "UPDATING";
    const v = planLive(T, s, LiveTierSize.parse({ nodegroups: { "eks-prod-node-group-m5-2x-extra": { min: 0, desired: 3, max: 5 } } })).violations.join();
    expect(v).toMatch(/UPDATING/);
    expect(v).toMatch(/never scales to zero/);
  });
});

describe("applyLive", () => {
  it("applies only the confirmed plan, in order", async () => {
    const port = new FakePort(PROD());
    const desired = LiveTierSize.parse({ workloads: pair(30), nodegroups: { "eks-prod-node-group-m5-2x-extra": { min: 3, desired: 4, max: 6 } } });
    const plan = planLive(T, await port.read(), desired);
    const r = await applyLive(port, T, desired, plan.planHash);
    expect(r.failed).toBeUndefined();
    expect(port.calls).toEqual(["nodegroup eks-prod-node-group-m5-2x-extra 4", "scale default/moly-backend-deployment 30", "scale default/lolygram-discovery-deployment 30"]);
  });

  it("refuses when the cluster moved after review", async () => {
    const port = new FakePort(PROD());
    const desired = LiveTierSize.parse({ workloads: pair(30) });
    const plan = planLive(T, await port.read(), desired);
    port.state.workloads.find((w) => w.name === "moly-backend-deployment")!.replicas = 26; // someone scaled by hand
    await expect(applyLive(port, T, desired, plan.planHash)).rejects.toThrow(/changed since you reviewed/);
    expect(port.calls).toEqual([]);
  });

  it("stops at the first failure and reports exactly what ran", async () => {
    const port = new FakePort(PROD(), "lolygram-discovery-deployment");
    const desired = LiveTierSize.parse({ workloads: pair(30) });
    const r = await applyLive(port, T, desired, planLive(T, await port.read(), desired).planHash);
    expect(r.applied).toHaveLength(1);
    expect(r.applied[0]).toMatch(/moly-backend-deployment: replicas 24 → 30/);
    expect(r.failed).toMatch(/lolygram-discovery-deployment.*boom/);
  });
});

describe("policy.yaml: prod exemptions are exactly two tools, named fields", async () => {
  const { evaluatePolicy, loadPolicyFile } = await import("../policy");
  const policy = loadPolicyFile(new URL("../../../../apps/mcp/policy.yaml", import.meta.url).pathname);
  it("apply_live_capacity may name tier=production", () => {
    expect(evaluatePolicy(policy, "apply_live_capacity", { tier: "production", preset: "campaign", planHash: "ab12" }).allowed).toBe(true);
    expect(evaluatePolicy(policy, "apply_live_capacity", { tier: "staging", preset: "custom", planHash: "ab12" }).allowed).toBe(true);
  });
  it("…but every other field of it still hits global_deny, and the allowlist still applies", () => {
    expect(evaluatePolicy(policy, "apply_live_capacity", { tier: "production", preset: "campaign", planHash: "prod-x" }).allowed).toBe(false);
    expect(evaluatePolicy(policy, "apply_live_capacity", { tier: "preprod", preset: "x", planHash: "ab" }).allowed).toBe(false);
    expect(evaluatePolicy(policy, "apply_live_capacity", { tier: "production", preset: "myprod", planHash: "ab" }).allowed).toBe(false);
  });
  it("no other tool gains the exemption", () => {
    expect(evaluatePolicy(policy, "apply_capacity_preset", { tier: "production", preset: "peak", sizeHash: "ab" })).toMatchObject({ allowed: false, reason: expect.stringMatching(/global deny/) });
    expect(evaluatePolicy(policy, "promote_release", { service: "twizz-sentinel", target: "production", imageTag: "main-1" })).toMatchObject({ allowed: false, reason: expect.stringMatching(/global deny/) });
    expect(evaluatePolicy(policy, "set_atlas_tier", { tier: "production", instanceSize: "M20", autoScaling: "off" }).allowed).toBe(false);
  });
  it("set_prod_atlas_tier: tier + cluster exempt, exact cluster allowlist, other fields still checked", () => {
    const ok = { tier: "production", cluster: "Moly-Prod", instanceSize: "M80", autoScaling: "off", from: "M60" };
    expect(evaluatePolicy(policy, "set_prod_atlas_tier", ok).allowed).toBe(true);
    expect(evaluatePolicy(policy, "set_prod_atlas_tier", { ...ok, cluster: "Prod-Shift4", autoScaling: "M30-M40" }).allowed).toBe(true);
    expect(evaluatePolicy(policy, "set_prod_atlas_tier", { ...ok, cluster: "Moly-Prod-2" }).allowed).toBe(false);
    expect(evaluatePolicy(policy, "set_prod_atlas_tier", { ...ok, tier: "staging" }).allowed).toBe(false);
    expect(evaluatePolicy(policy, "set_prod_atlas_tier", { ...ok, instanceSize: "M400" }).allowed).toBe(false);
    expect(evaluatePolicy(policy, "set_prod_atlas_tier", { ...ok, autoScaling: "prod" })).toMatchObject({ allowed: false, reason: expect.stringMatching(/global deny/) });
  });
});

describe("HPA needs CPU requests on every container", () => {
  it("refuses when a sidecar has none", () => {
    const s = PROD();
    for (const w of s.workloads.filter((x) => (T.pair as readonly string[]).includes(x.name))) {
      w.resources = { requests: { cpu: "250m", memory: "256Mi" } };
      w.cpuRequestsOnAll = false;
    }
    expect(planLive(T, s, LiveTierSize.parse({ workloads: pair(24, [24, 48]) })).violations.join()).toMatch(/no CPU requests on every container/);
  });
});

// ── Prod templates (platform owner 2026-11-05): Baseline / Campaign / Max in one click ──
describe("named templates with a baseline floor", () => {
  const NG = "eks-prod-node-group-m5-2x-extra";
  // EKS-Moly-Prod as it runs on 2026-11-05: one node group, the pair at 40/20
  const NOW = (): LiveState => {
    const s = PROD();
    s.nodegroups = [{ name: NG, status: "ACTIVE", instanceTypes: ["m5.2xlarge"], min: 5, desired: 5, max: 8 }];
    for (const w of s.workloads) if (w.name === "moly-backend-deployment") w.replicas = 40;
    for (const w of s.workloads) if (w.name === "lolygram-discovery-deployment") w.replicas = 20;
    return s;
  };
  const tpl = (b: number, d: number, ng: [number, number, number]) =>
    LiveTierSize.parse({ workloads: { "moly-backend-deployment": { replicas: b }, "lolygram-discovery-deployment": { replicas: d } }, nodegroups: { [NG]: { min: ng[0], desired: ng[1], max: ng[2] } } });
  const BASELINE = tpl(40, 20, [5, 5, 8]);
  const CAMPAIGN = tpl(80, 40, [8, 10, 14]);
  const MAX = tpl(120, 60, [12, 15, 20]);
  const at = (size: LiveTierSize): LiveState => {
    const s = NOW();
    for (const [n, w] of Object.entries(size.workloads)) s.workloads.find((x) => x.name === n)!.replicas = w.replicas;
    for (const [n, g] of Object.entries(size.nodegroups)) Object.assign(s.nodegroups.find((x) => x.name === n)!, g);
    return s;
  };
  const opts = (name: string) => ({ template: { name, floor: BASELINE } });

  it("Baseline → Campaign and Baseline → Max plan clean (Max is exactly the ×3 / cap edge)", () => {
    for (const [name, size] of [["campaign", CAMPAIGN], ["max", MAX]] as const) {
      const p = planLive(T, NOW(), size, opts(name));
      expect(p.violations).toEqual([]);
      expect(p.ops[0]).toMatchObject({ kind: "nodegroup", name: NG }); // nodes grow first
    }
  });

  it("Max → Baseline in ONE apply as a template; the same values by hand are still refused", () => {
    const asTemplate = planLive(T, at(MAX), BASELINE, opts("baseline"));
    expect(asTemplate.violations).toEqual([]);
    expect(asTemplate.ops.map((o) => o.kind)).toEqual(["scale", "scale", "nodegroup"]); // pods first, then drain
    const byHand = planLive(T, at(MAX), BASELINE).violations.join("\n");
    expect(byHand).toMatch(/below ×0.5/);
    expect(byHand).toMatch(/shrink one node per apply/);
  });

  it("never below the baseline floor, even as a template", () => {
    const v = planLive(T, at(CAMPAIGN), tpl(30, 20, [4, 4, 8]), opts("quiet")).violations.join("\n");
    expect(v).toMatch(/moly-backend-deployment: 30 replicas is below the baseline template \(40\)/);
    expect(v).toMatch(new RegExp(`node group ${NG}: 4/4/8 is below the baseline template \\(5/5/8\\)`));
  });

  it("step-up limit and caps still hold for templates", () => {
    const v = planLive(T, NOW(), tpl(121, 61, [12, 16, 21]), opts("too-big")).violations.join("\n");
    expect(v).toMatch(/exceeds the production cap of 120/);
    expect(v).toMatch(/more than ×3/);
    expect(v).toMatch(/max 21 exceeds the production cap of 20/);
  });

  it("a template's uneven pair split does not warn; the same split by hand still does", () => {
    expect(planLive(T, NOW(), CAMPAIGN, opts("campaign")).warnings.join()).not.toMatch(/not scaled symmetrically/);
    expect(planLive(T, NOW(), CAMPAIGN).warnings.join()).toMatch(/not scaled symmetrically/);
  });

  it("a TRAFFIC ESTIMATE keeps the step-down guards: Max → baseline-sized estimate is refused (Codex review)", () => {
    const est = { template: { name: "estimate-150", floor: BASELINE, liftStepDown: false } };
    const v = planLive(T, at(MAX), BASELINE, est).violations.join("\n");
    expect(v).toMatch(/below ×0.5/); // 120 → 40 pods in one apply
    expect(v).toMatch(/shrink one node per apply/); // 15 → 5 nodes in one apply
    // …but scaling UP by estimate is unaffected, and the floor still holds
    expect(planLive(T, NOW(), CAMPAIGN, { template: { name: "estimate-2500", floor: BASELINE, liftStepDown: false } }).violations).toEqual([]);
    expect(planLive(T, at(CAMPAIGN), tpl(30, 20, [4, 4, 8]), est).violations.join("\n")).toMatch(/below the baseline template/);
  });

  it("a template without a floor gets the normal rules", () => {
    const v = planLive(T, at(MAX), BASELINE, { template: { name: "baseline" } }).violations.join("\n");
    expect(v).toMatch(/below ×0.5/);
  });

  it("the plan hash binds the template: a hand edit can't reuse a template's confirmation", () => {
    const a = planLive(T, NOW(), CAMPAIGN, opts("campaign")).planHash;
    expect(planLive(T, NOW(), CAMPAIGN).planHash).not.toBe(a);
    expect(planLive(T, NOW(), CAMPAIGN, opts("campaign")).planHash).toBe(a);
  });

  it("applyLive applies a template step-down only with the template options", async () => {
    const port = new FakePort(at(MAX));
    const hash = planLive(T, at(MAX), BASELINE, opts("baseline")).planHash;
    const r = await applyLive(port, T, BASELINE, hash, opts("baseline"));
    expect(r.failed).toBeUndefined();
    expect(port.calls).toEqual([
      "scale default/moly-backend-deployment 40",
      "scale default/lolygram-discovery-deployment 20",
      `nodegroup ${NG} 5`,
    ]);
    await expect(applyLive(new FakePort(at(MAX)), T, BASELINE, hash)).rejects.toThrow(/changed since you reviewed/);
  });
});

describe("plan hash ignores volatile rollout progress (Codex re-review)", () => {
  it("same spec, different rollout observations → same hash; a spec change → different hash", () => {
    const want = { workloads: { "moly-backend-deployment": { replicas: 48 } }, nodegroups: {} } as LiveTierSize;
    const a = PROD();
    const b = PROD();
    for (const w of b.workloads) Object.assign(w, { ready: Math.max(0, w.ready - 3), rollout: { observed: false, updated: 1, available: 2, total: w.replicas + 4, unavailable: 2 } });
    expect(planLive(T, a, want).planHash).toBe(planLive(T, b, want).planHash);
    const c = PROD();
    c.workloads.find((w) => w.name === "moly-backend-deployment")!.replicas = 30;
    expect(planLive(T, c, want).planHash).not.toBe(planLive(T, a, want).planHash);
  });
});
