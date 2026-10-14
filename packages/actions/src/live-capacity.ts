// Live capacity (docs/NEBULA.md §N5.2): size workloads + node groups straight
// on EKS-Moly-staging (ns default/jobs) and EKS-Moly-Prod — the clusters have
// no gitops source for sizing (their pipelines only `rollout restart`), so the
// LIVE cluster is the truth: every plan is a diff against a fresh read, and
// apply re-reads and refuses if anything moved since the human confirmed.
//
// Rules (platform owner, 2026-10-14):
//   - moly-backend + lolygram-discovery scale as a PAIR (same replicas / HPA)
//   - every other workload stays at its baseline unless a preset names it
//   - one apply never more than triples or halves a workload or node group
//   - Nebula never deletes anything (no HPA removal, no scale to zero)
// Kubernetes access is the `nebula-capacity` RBAC (infra/k8s/): patch
// deployments / scale / HPAs in default + jobs, read nodes. Node groups go
// through eks:UpdateNodegroupConfig (infra/src/capacity-access.ts).
import { createHash } from "node:crypto";
import { cpuToCores, memToGi, type LiveTierSize, type LiveWorkloadSize, type NodegroupSize } from "@twizz-idp/shared";

export type LiveTier = "staging" | "production";

export type LiveResources = { requests?: { cpu?: string; memory?: string }; limits?: { cpu?: string; memory?: string } };
export type LiveWorkload = {
  namespace: string;
  name: string;
  replicas: number;
  ready: number;
  container: string;
  resources: LiveResources;
  hpa?: { min: number; max: number; targetCPU?: number; current?: number; desired?: number };
};
export type LiveNodegroup = { name: string; status: string; instanceTypes: string[]; capacityType?: string; min: number; desired: number; max: number };
export type LiveNode = { name: string; nodegroup?: string; instanceType?: string; cpuCores: number; memGi: number };
export type LiveState = {
  tier: LiveTier;
  cluster: string;
  readAt: string;
  workloads: LiveWorkload[];
  nodegroups: LiveNodegroup[];
  nodes: LiveNode[];
  /** metrics.k8s.io is served (HPAs can work) */
  metricsServer: boolean;
};

export interface LiveClusterPort {
  read(): Promise<LiveState>;
  scale(namespace: string, name: string, replicas: number): Promise<void>;
  /** create the HPA (named after the Deployment) or patch its bounds */
  upsertHpa(namespace: string, name: string, a: { min: number; max: number; targetCPU: number }, exists: boolean): Promise<void>;
  updateNodegroup(name: string, size: NodegroupSize): Promise<void>;
}

export type LiveTarget = {
  tier: LiveTier;
  cluster: string;
  namespaces: readonly string[];
  /** Deployments that always scale together */
  pair: readonly [string, string];
  caps: { maxReplicas: number; maxNodesPerGroup: number; maxStepUp: number; maxStepDown: number };
};

const PAIR = ["moly-backend-deployment", "lolygram-discovery-deployment"] as const;

export const LIVE_TARGETS: Record<LiveTier, LiveTarget> = {
  staging: { tier: "staging", cluster: "EKS-Moly-staging", namespaces: ["default", "jobs"], pair: PAIR, caps: { maxReplicas: 20, maxNodesPerGroup: 6, maxStepUp: 3, maxStepDown: 0.5 } },
  production: { tier: "production", cluster: "EKS-Moly-Prod", namespaces: ["default", "jobs"], pair: PAIR, caps: { maxReplicas: 120, maxNodesPerGroup: 20, maxStepUp: 3, maxStepDown: 0.5 } },
};

export function isLiveTier(t: string): t is LiveTier {
  return t === "staging" || t === "production";
}

// ── the plan ───────────────────────────────────────────────────────────

export type LiveOp =
  | { kind: "nodegroup"; name: string; from: NodegroupSize; to: NodegroupSize }
  | { kind: "scale"; namespace: string; name: string; from: number; to: number }
  | { kind: "hpa"; namespace: string; name: string; from: LiveWorkload["hpa"] | null; to: { min: number; max: number; targetCPU: number } };

export type LiveRow = { workload: string; namespace: string; pair: boolean; before: string; after: string; changes: string[] };
export type LiveNodegroupRow = { name: string; before: string; after: string; changes: string[] };

export type LivePlan = {
  tier: LiveTier;
  cluster: string;
  readAt: string;
  rows: LiveRow[];
  nodegroupRows: LiveNodegroupRow[];
  ops: LiveOp[];
  violations: string[];
  warnings: string[];
  /** binds the nonce: the ops AND the live values they were computed from */
  planHash: string;
};

const fmtW = (w: { replicas: number; hpa?: { min: number; max: number } | null }) => (w.hpa ? `HPA ${w.hpa.min}–${w.hpa.max}` : `${w.replicas}×`);
const fmtRes = (r: LiveResources) => `req ${r.requests?.cpu ?? "–"}/${r.requests?.memory ?? "–"} lim ${r.limits?.cpu ?? "–"}/${r.limits?.memory ?? "–"}`;
const fmtNg = (n: NodegroupSize) => `${n.min}/${n.desired}/${n.max}`;

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

function mergeRes(base: LiveResources, patch: NonNullable<LiveWorkloadSize["resources"]>): LiveResources {
  return {
    requests: { ...base.requests, ...patch.requests },
    limits: { ...base.limits, ...patch.limits },
  };
}

function sameRes(a: LiveResources, b: LiveResources): boolean {
  return canonical({ r: a.requests ?? {}, l: a.limits ?? {} }) === canonical({ r: b.requests ?? {}, l: b.limits ?? {} });
}

function within(t: LiveTarget, from: number, to: number): string | null {
  if (from <= 0) return null;
  if (to > Math.ceil(from * t.caps.maxStepUp)) return `more than ×${t.caps.maxStepUp} in one step (${from} → ${to})`;
  if (to < Math.ceil(from * t.caps.maxStepDown)) return `below ×${t.caps.maxStepDown} in one step (${from} → ${to})`;
  return null;
}

/** Pure: the ops that take `live` to `desired`, with every rule checked. */
export function planLive(t: LiveTarget, live: LiveState, desired: LiveTierSize): LivePlan {
  const violations: string[] = [];
  const warnings: string[] = [];
  const ops: LiveOp[] = [];
  const rows: LiveRow[] = [];
  const nodegroupRows: LiveNodegroupRow[] = [];

  // pair symmetry
  const [a, b] = t.pair;
  const da = desired.workloads[a];
  const db = desired.workloads[b];
  if (!!da !== !!db) violations.push(`${a} and ${b} scale as a pair — size both or neither`);
  if (da && db && canonical({ r: da.replicas, a: da.autoscaling ?? null }) !== canonical({ r: db.replicas, a: db.autoscaling ?? null })) {
    violations.push(`${a} and ${b} must have the same replicas / HPA (got ${fmtW({ replicas: da.replicas, hpa: da.autoscaling ? { min: da.autoscaling.minReplicas, max: da.autoscaling.maxReplicas } : null })} vs ${fmtW({ replicas: db.replicas, hpa: db.autoscaling ? { min: db.autoscaling.minReplicas, max: db.autoscaling.maxReplicas } : null })})`);
  }

  const nodegroupUps: LiveOp[] = [];
  const nodegroupDowns: LiveOp[] = [];
  const workloadOps: LiveOp[] = [];

  for (const [name, want] of Object.entries(desired.workloads)) {
    const w = live.workloads.find((x) => x.name === name && t.namespaces.includes(x.namespace));
    if (!w) {
      violations.push(`${name}: no such Deployment in ns ${t.namespaces.join("/")} on ${t.cluster}`);
      continue;
    }
    const changes: string[] = [];
    const prefix = `${name}:`;
    if (want.autoscaling?.enabled) {
      const to = { min: want.autoscaling.minReplicas, max: want.autoscaling.maxReplicas, targetCPU: want.autoscaling.targetCPUUtilizationPercentage };
      if (!live.metricsServer) violations.push(`${prefix} ${t.cluster} serves no metrics.k8s.io — an HPA would never scale`);
      // a CPU-utilization HPA needs CPU requests to compute anything; without them it is
      // inert AND blocks fixed sizing, and Nebula cannot delete it (RBAC) — refuse
      if (!w.resources.requests?.cpu) violations.push(`${prefix} pods have no CPU requests — a CPU HPA could never scale them; size replicas instead`);
      if (to.min < w.replicas) warnings.push(`${prefix} HPA min ${to.min} < ${w.replicas} running — at today's utilization the HPA scales it DOWN to ${to.min} within minutes`);
      if (to.max > t.caps.maxReplicas) violations.push(`${prefix} HPA max ${to.max} exceeds the ${t.tier} cap of ${t.caps.maxReplicas}`);
      const base = w.hpa ? w.hpa.min : w.replicas;
      const step = within(t, base, to.min);
      if (step) violations.push(`${prefix} HPA min ${step}`);
      if (!w.hpa || w.hpa.min !== to.min || w.hpa.max !== to.max || (w.hpa.targetCPU ?? 80) !== to.targetCPU) {
        workloadOps.push({ kind: "hpa", namespace: w.namespace, name, from: w.hpa ?? null, to });
        changes.push(`${w.hpa ? `HPA ${w.hpa.min}–${w.hpa.max}` : `${w.replicas}× (no HPA)`} → HPA ${to.min}–${to.max} @${to.targetCPU}%`);
        // raise the floor right away so capacity is there before the HPA's first evaluation
        if (w.replicas < to.min) workloadOps.push({ kind: "scale", namespace: w.namespace, name, from: w.replicas, to: to.min });
      }
    } else {
      if (w.hpa) violations.push(`${prefix} has an HPA (${w.hpa.min}–${w.hpa.max}); Nebula never deletes it — size it with an HPA, or remove the HPA by hand first`);
      if (want.replicas > t.caps.maxReplicas) violations.push(`${prefix} ${want.replicas} replicas exceeds the ${t.tier} cap of ${t.caps.maxReplicas}`);
      const step = within(t, w.replicas, want.replicas);
      if (step) violations.push(`${prefix} replicas ${step}`);
      if (want.replicas !== w.replicas) {
        workloadOps.push({ kind: "scale", namespace: w.namespace, name, from: w.replicas, to: want.replicas });
        changes.push(`replicas ${w.replicas} → ${want.replicas}`);
      }
    }
    if (want.resources && !sameRes(w.resources, mergeRes(w.resources, want.resources))) {
      // RBAC grants deployments/scale + HPAs only (no `patch deployments`: that would be
      // full pod-template control on prod) — resources are changed by the app's own deploy
      violations.push(`${prefix} resource sizing is not available on live tiers (Nebula may only scale replicas / HPAs here)`);
    }
    rows.push({ workload: name, namespace: w.namespace, pair: (t.pair as readonly string[]).includes(name), before: `${fmtW(w)} · ${fmtRes(w.resources)}`, after: changes.length ? changes.join("; ") : "unchanged", changes });
  }

  // workloads the preset does not name stay exactly as they are (baseline)
  for (const w of live.workloads.filter((x) => t.namespaces.includes(x.namespace) && !desired.workloads[x.name])) {
    rows.push({ workload: w.name, namespace: w.namespace, pair: (t.pair as readonly string[]).includes(w.name), before: `${fmtW(w)} · ${fmtRes(w.resources)}`, after: "baseline (untouched)", changes: [] });
  }

  for (const [name, want] of Object.entries(desired.nodegroups)) {
    const ng = live.nodegroups.find((x) => x.name === name);
    if (!ng) {
      violations.push(`node group ${name}: not found on ${t.cluster}`);
      continue;
    }
    const from = { min: ng.min, desired: ng.desired, max: ng.max };
    const changes: string[] = [];
    if (ng.status !== "ACTIVE") violations.push(`node group ${name} is ${ng.status} — wait for ACTIVE`);
    if (want.max > t.caps.maxNodesPerGroup) violations.push(`node group ${name}: max ${want.max} exceeds the ${t.tier} cap of ${t.caps.maxNodesPerGroup}`);
    if (want.min < 1) violations.push(`node group ${name}: min ${want.min} — a group never scales to zero`);
    const step = within(t, from.desired, want.desired);
    if (step) violations.push(`node group ${name}: desired ${step}`);
    if (canonical(from) !== canonical(want)) {
      const op: LiveOp = { kind: "nodegroup", name, from, to: want };
      (want.desired >= from.desired ? nodegroupUps : nodegroupDowns).push(op);
      changes.push(`${fmtNg(from)} → ${fmtNg(want)} (min/desired/max)`);
      if (want.desired < from.desired) warnings.push(`node group ${name}: desired ${from.desired} → ${want.desired} drains nodes; their pods are rescheduled`);
    }
    nodegroupRows.push({ name, before: fmtNg(from), after: changes.length ? fmtNg(want) : "unchanged", changes });
  }
  for (const ng of live.nodegroups.filter((x) => !desired.nodegroups[x.name])) nodegroupRows.push({ name: ng.name, before: fmtNg(ng), after: "baseline (untouched)", changes: [] });

  // drain guard: pods here mostly carry no requests, so the scheduler cannot see
  // load — shrink capacity one node, one group, per apply
  for (const o of nodegroupDowns) if (o.kind === "nodegroup" && o.from.desired - o.to.desired > 1) violations.push(`node group ${o.name}: desired ${o.from.desired} → ${o.to.desired} — shrink one node per apply`);
  if (nodegroupDowns.length > 1) violations.push(`${nodegroupDowns.length} node groups shrink at once — shrink one group per apply`);

  // order: grow nodes first, then workloads, then shrink nodes
  ops.push(...nodegroupUps, ...workloadOps, ...nodegroupDowns);

  // capacity sanity on what the scheduler can see (requests)
  const nodeCpu = live.nodes.reduce((s, n) => s + n.cpuCores, 0);
  const addedPods = ops.filter((o): o is Extract<LiveOp, { kind: "scale" }> => o.kind === "scale").reduce((s, o) => s + Math.max(0, o.to - o.from), 0);
  if (addedPods > 0 && nodegroupUps.length === 0) warnings.push(`+${addedPods} pods with no node-group change; ${live.nodes.length} nodes / ${nodeCpu} vCPU today — check node headroom`);

  const touched = ops.map((o) => (o.kind === "nodegroup" ? live.nodegroups.find((n) => n.name === o.name) : live.workloads.find((w) => w.name === o.name)));
  const planHash = createHash("sha256").update(canonical({ tier: t.tier, ops, touched })).digest("hex");
  return { tier: t.tier, cluster: t.cluster, readAt: live.readAt, rows: rows.sort((x, y) => Number(y.pair) - Number(x.pair) || x.workload.localeCompare(y.workload)), nodegroupRows, ops, violations, warnings, planHash };
}

// ── apply ──────────────────────────────────────────────────────────────

export type LiveApplyResult = { tier: LiveTier; cluster: string; applied: string[]; failed?: string; planHash: string };

const describeOp = (o: LiveOp) =>
  o.kind === "nodegroup"
    ? `node group ${o.name}: ${fmtNg(o.from)} → ${fmtNg(o.to)}`
    : o.kind === "scale"
      ? `${o.namespace}/${o.name}: replicas ${o.from} → ${o.to}`
      : `${o.namespace}/${o.name}: HPA ${o.from ? `${o.from.min}–${o.from.max}` : "(new)"} → ${o.to.min}–${o.to.max} @${o.to.targetCPU}%`;

export { describeOp as describeLiveOp };

/** Re-read, re-plan, and apply ONLY if the plan is byte-identical to the one
 * the human confirmed (`planHash`). Ops run in plan order and stop at the
 * first failure; the result lists exactly what was applied. */
export async function applyLive(port: LiveClusterPort, t: LiveTarget, desired: LiveTierSize, confirmedHash: string): Promise<LiveApplyResult> {
  const live = await port.read();
  const plan = planLive(t, live, desired);
  if (plan.planHash !== confirmedHash) throw new Error(`${t.cluster} changed since you reviewed the plan — reload it and confirm again`);
  if (plan.violations.length) throw new Error(`refused:\n${plan.violations.join("\n")}`);
  if (!plan.ops.length) throw new Error(`${t.cluster} already matches — nothing to apply`);
  const applied: string[] = [];
  for (const op of plan.ops) {
    try {
      if (op.kind === "nodegroup") await port.updateNodegroup(op.name, op.to);
      else if (op.kind === "scale") await port.scale(op.namespace, op.name, op.to);
      else await port.upsertHpa(op.namespace, op.name, op.to, !!op.from);
      applied.push(describeOp(op));
    } catch (e) {
      return { tier: t.tier, cluster: t.cluster, applied, failed: `${describeOp(op)}: ${String((e as Error).message ?? e)}`, planHash: plan.planHash };
    }
  }
  return { tier: t.tier, cluster: t.cluster, applied, planHash: plan.planHash };
}

/** The live state as a preset (for "save current as baseline"). */
export function liveAsSize(t: LiveTarget, live: LiveState): LiveTierSize {
  const workloads: LiveTierSize["workloads"] = {};
  for (const w of live.workloads.filter((x) => t.namespaces.includes(x.namespace))) {
    workloads[w.name] = { replicas: w.replicas, ...(w.hpa ? { autoscaling: { enabled: true, minReplicas: w.hpa.min, maxReplicas: w.hpa.max, targetCPUUtilizationPercentage: w.hpa.targetCPU ?? 80 } } : {}) };
  }
  const nodegroups: LiveTierSize["nodegroups"] = {};
  for (const n of live.nodegroups) nodegroups[n.name] = { min: n.min, desired: n.desired, max: n.max };
  return { workloads, nodegroups };
}
