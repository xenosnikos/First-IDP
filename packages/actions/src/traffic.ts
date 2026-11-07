// Traffic-driven live sizing (docs/NEBULA.md §N5.4). Pure: no AWS, no kube.
//
// estimateLive turns an expected PEAK edge requests/s into a LiveTierSize
// (replicas per workload + node group min/desired/max) from a profile measured
// on real events (twizz-gitops capacity/profiles.yaml `<tier>.live`), floored
// by the tier's `baseline` template and capped by LIVE_TARGETS. The result is
// an ordinary LiveTierSize: planLive / applyLive (step limits, caps, plan
// hash, the gate) treat it exactly like a named template.
//
// findBursts finds sudden ramps in a per-minute rps series — the shape of the
// 2026-11-05 00:17 event (17× in two minutes) that reactive autoscaling cannot
// catch, so it must be provisioned for ahead of time.
import { parse as parseYaml } from "yaml";
import { CapacityCasesFile, type CapacityCase, type EstimateLiveInput, type LiveProfile, type LiveTierSize } from "@twizz-idp/shared";
import type { LiveTarget } from "./live-capacity";
import type { PromotionRepo } from "./promote";

export const CASES_FILE = "capacity/cases.yaml";

export type LiveEstimate = {
  designRps: number;
  size: LiveTierSize;
  workloads: Array<{ name: string; replicas: number; rpsPerPod: number; servedRps: number; mcpuPerPodAtDesign: number; utilAtDesign: number; flooredBy?: number; cappedAt?: number }>;
  nodegroups: Array<{ name: string; desired: number; min: number; max: number; podCpu: number; neededCpu: number; utilAtDesign: number; flooredBy?: number; cappedAt?: number }>;
  rationale: string[];
  warnings: string[];
};

const r1 = (n: number) => Math.round(n * 10) / 10;

/** rps one pod serves at its target CPU: (target − idle) ÷ cost per rps. */
export function rpsPerPod(p: { mcpuPerRps: number; baseMcpu: number; targetMcpu: number }): number {
  return Math.max(0.1, (p.targetMcpu - p.baseMcpu) / p.mcpuPerRps);
}

export function estimateLive(t: LiveTarget, profile: LiveProfile, input: EstimateLiveInput, floor?: LiveTierSize): LiveEstimate {
  const designRps = input.rps * input.peakFactor * input.headroom;
  const rationale = [`design load = ${input.rps} req/s × ${input.peakFactor} peak × ${input.headroom} headroom = ${Math.round(designRps)} req/s`];
  const warnings: string[] = [];
  const size: LiveTierSize = { workloads: {}, nodegroups: {} };
  const podCpuByGroup = new Map<string, number>();
  const workloads: LiveEstimate["workloads"] = [];

  for (const [name, p] of Object.entries(profile.workloads)) {
    const served = designRps * p.share;
    const perPod = rpsPerPod(p);
    let replicas = Math.max(1, Math.ceil(served / perPod - 1e-9));
    const floorReplicas = floor?.workloads?.[name]?.replicas;
    let flooredBy: number | undefined;
    let cappedAt: number | undefined;
    if (floorReplicas !== undefined && replicas < floorReplicas) {
      flooredBy = floorReplicas;
      replicas = floorReplicas;
    }
    if (replicas > t.caps.maxReplicas) {
      cappedAt = t.caps.maxReplicas;
      replicas = t.caps.maxReplicas;
    }
    const mcpu = p.baseMcpu + (served / replicas) * p.mcpuPerRps;
    size.workloads[name] = { replicas };
    podCpuByGroup.set(p.nodegroup, (podCpuByGroup.get(p.nodegroup) ?? 0) + (replicas * Math.min(mcpu, 1000)) / 1000);
    workloads.push({ name, replicas, rpsPerPod: r1(perPod), servedRps: Math.round(served), mcpuPerPodAtDesign: Math.round(mcpu), utilAtDesign: r1(mcpu / 10), flooredBy, cappedAt });
    rationale.push(
      `${name}: ${Math.round(served)} req/s ÷ ${r1(perPod)} per pod (${p.targetMcpu}m target: (${p.targetMcpu} − ${p.baseMcpu}) ÷ ${p.mcpuPerRps}m/req/s) → ${replicas} pods${flooredBy ? ` (floored by baseline ${flooredBy})` : ""}${cappedAt ? ` (CAPPED at ${cappedAt})` : ""}, ≈${Math.round(mcpu)}m each at the design load`,
    );
    if (cappedAt) warnings.push(`${name} needs more than the ${t.caps.maxReplicas}-replica cap at this load: it will run hot (≈${Math.round(mcpu)}m per pod). Raise the cap deliberately or shed load.`);
    if (mcpu > 900) warnings.push(`${name} at ≈${Math.round(mcpu)}m per pod is at Node's one-core ceiling: expect queueing and multi-second p95 like 2026-11-05.`);
  }

  const nodegroups: LiveEstimate["nodegroups"] = [];
  for (const [name, g] of Object.entries(profile.nodegroups)) {
    const podCpu = podCpuByGroup.get(name) ?? 0;
    const needed = (podCpu + g.reservedCpu) * g.headroom;
    let desired = Math.max(1, Math.ceil(needed / g.allocatableCpu - 1e-9));
    const fl = floor?.nodegroups?.[name];
    let flooredBy: number | undefined;
    let cappedAt: number | undefined;
    if (fl && desired < fl.desired) {
      flooredBy = fl.desired;
      desired = fl.desired;
    }
    if (desired > t.caps.maxNodesPerGroup) {
      cappedAt = t.caps.maxNodesPerGroup;
      desired = t.caps.maxNodesPerGroup;
    }
    // min = desired: the autoscaler must not take nodes away during the event
    const min = desired;
    const max = Math.min(t.caps.maxNodesPerGroup, Math.max(fl?.max ?? 0, Math.ceil(desired * g.burst - 1e-9), desired));
    size.nodegroups[name] = { min, desired, max };
    const util = (podCpu + g.reservedCpu) / (desired * g.allocatableCpu);
    nodegroups.push({ name, desired, min, max, podCpu: r1(podCpu), neededCpu: r1(needed), utilAtDesign: r1(util * 100), flooredBy, cappedAt });
    rationale.push(
      `${name}: (${r1(podCpu)} pod vCPU + ${g.reservedCpu} other) × ${g.headroom} headroom = ${r1(needed)} vCPU ÷ ${g.allocatableCpu} per node → ${desired} nodes (min ${min}, max ${max})${flooredBy ? ` (floored by baseline ${flooredBy})` : ""}${cappedAt ? ` (CAPPED at ${cappedAt})` : ""}, ≈${Math.round(util * 100)}% CPU at the design load`,
    );
    if (util > 0.85) warnings.push(`${name} would run at ≈${Math.round(util * 100)}% CPU at the design load: the node group is the ceiling (as on 2026-11-05, 91–99%).`);
  }
  for (const w of workloads) {
    const g = profile.workloads[w.name].nodegroup;
    if (!profile.nodegroups[g]) warnings.push(`${w.name} runs on ${g}, which the profile does not size: its pods may not fit.`);
  }
  return { designRps: Math.round(designRps), size, workloads, nodegroups, rationale, warnings };
}

// ── bursts ──────────────────────────────────────────────────────────────

export type Burst = {
  /** epoch ms of the first minute above 2× baseline */
  start: number;
  peakAt: number;
  end: number;
  baselineRps: number;
  peakRps: number;
  /** peak ÷ baseline */
  ratio: number;
  /** minutes from start to the first minute ≥ 80% of the peak */
  rampMinutes: number;
  durationMinutes: number;
};

/** Sudden ramps in a per-minute rps series: a minute ≥ max(minRatio × baseline,
 * baseline + minDelta), baseline = median of the preceding `lookback` minutes.
 * Consecutive hot minutes merge into one burst; strongest first. */
export function findBursts(series: Array<[number, number]>, opts: { minRatio?: number; minDelta?: number; lookback?: number; limit?: number } = {}): Burst[] {
  const minRatio = opts.minRatio ?? 3;
  const minDelta = opts.minDelta ?? 300;
  const lookback = opts.lookback ?? 15;
  const out: Burst[] = [];
  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : 0;
  };
  let i = lookback;
  while (i < series.length) {
    const base = median(series.slice(i - lookback, i).map((p) => p[1]));
    const hot = (v: number) => v >= Math.max(base * minRatio, base + minDelta);
    if (!hot(series[i][1])) {
      i++;
      continue;
    }
    let j = i;
    let peak = i;
    while (j < series.length && series[j][1] >= Math.max(base * 2, base + minDelta / 2)) {
      if (series[j][1] > series[peak][1]) peak = j;
      j++;
    }
    const peakRps = series[peak][1];
    let ramp = i;
    while (ramp < peak && series[ramp][1] < peakRps * 0.8) ramp++;
    out.push({
      start: series[i][0],
      peakAt: series[peak][0],
      end: series[Math.max(i, j - 1)][0],
      baselineRps: Math.round(base),
      peakRps: Math.round(peakRps),
      ratio: r1(base > 0 ? peakRps / base : peakRps),
      rampMinutes: ramp - i + 1,
      durationMinutes: j - i,
    });
    i = j + 1;
  }
  return out.sort((a, b) => b.peakRps - a.peakRps).slice(0, opts.limit ?? 10);
}

// ── cases ───────────────────────────────────────────────────────────────

export function parseCases(text: string): CapacityCase[] {
  return CapacityCasesFile.parse(parseYaml(text) ?? {}).cases;
}

/** capacity/cases.yaml from twizz-gitops; a missing file is an empty library, not an error. */
export async function loadCases(repo: Pick<PromotionRepo, "readFile">): Promise<CapacityCase[]> {
  const f = await repo.readFile(CASES_FILE);
  return f ? parseCases(f.content) : [];
}

// ── assessing a sizing against a load (replaying a case, checking a template) ──

export type LiveAssessment = {
  rps: number;
  workloads: Array<{ name: string; replicas: number; mcpuPerPod: number; saturated: boolean }>;
  nodegroups: Array<{ name: string; nodes: number; cpuPct: number; saturated: boolean }>;
  verdict: "OK" | "WATCH" | "SATURATED";
  notes: string[];
};

/** What a given sizing does at a given edge load, by the same profile estimateLive
 * uses. Pods past ~900m and node groups past 90% CPU are saturated (2026-11-05). */
export function assessLive(profile: LiveProfile, size: LiveTierSize, rps: number): LiveAssessment {
  const podCpuByGroup = new Map<string, number>();
  const workloads: LiveAssessment["workloads"] = [];
  const notes: string[] = [];
  for (const [name, p] of Object.entries(profile.workloads)) {
    const replicas = size.workloads?.[name]?.replicas;
    if (!replicas) {
      notes.push(`${name}: not in this sizing (left as it runs) — not assessed`);
      continue;
    }
    const mcpu = p.baseMcpu + ((rps * p.share) / replicas) * p.mcpuPerRps;
    podCpuByGroup.set(p.nodegroup, (podCpuByGroup.get(p.nodegroup) ?? 0) + (replicas * Math.min(mcpu, 1000)) / 1000);
    workloads.push({ name, replicas, mcpuPerPod: Math.round(mcpu), saturated: mcpu >= 900 });
  }
  const nodegroups: LiveAssessment["nodegroups"] = [];
  for (const [name, g] of Object.entries(profile.nodegroups)) {
    const nodes = size.nodegroups?.[name]?.desired;
    if (!nodes) {
      notes.push(`${name}: not in this sizing — not assessed`);
      continue;
    }
    const pct = ((podCpuByGroup.get(name) ?? 0) + g.reservedCpu) / (nodes * g.allocatableCpu);
    nodegroups.push({ name, nodes, cpuPct: Math.round(pct * 100), saturated: pct >= 0.9 });
  }
  const sat = workloads.some((w) => w.saturated) || nodegroups.some((n) => n.saturated);
  const watch = workloads.some((w) => w.mcpuPerPod >= 700) || nodegroups.some((n) => n.cpuPct >= 75);
  return { rps: Math.round(rps), workloads, nodegroups, verdict: sat ? "SATURATED" : watch ? "WATCH" : "OK", notes };
}

/** A case as a sizing: what actually ran. */
export function caseSizing(c: CapacityCase): LiveTierSize {
  return {
    workloads: Object.fromEntries(Object.entries(c.ran.workloads).map(([k, v]) => [k, { replicas: v.replicas }])),
    nodegroups: Object.fromEntries(Object.entries(c.ran.nodegroups).map(([k, v]) => [k, { min: v.desired, desired: v.desired, max: v.desired }])),
  };
}

// ── rollout validation: is the cluster where the plan said it would be? ──

export type RolloutCheck = {
  verdict: "READY" | "PROGRESSING" | "MISMATCH";
  workloads: Array<{ name: string; want: number; spec: number | null; ready: number | null; ok: boolean; note?: string }>;
  /** nodes = Ready + schedulable; joining = registered, not Ready yet; draining = cordoned
   * (scale-down in progress); total = every node of the group the cluster still lists */
  nodegroups: Array<{ name: string; want: { min: number; desired: number; max: number }; spec: { min: number; desired: number; max: number } | null; nodes: number; joining: number; draining: number; total: number; ok: boolean; note?: string }>;
  /** things that block or slow the rollout (stuck pods of the planned workloads, node-group
   * health issues); they never change the verdict on their own — a human reads them */
  issues: Array<{ kind: "pod" | "nodegroup"; subject: string; reason: string; message: string; count?: number }>;
};

type VerifyState = {
  workloads: Array<{ name: string; replicas: number; ready: number; rollout?: { observed: boolean; updated: number; available: number; total?: number; unavailable?: number } }>;
  nodegroups: Array<{ name: string; min: number; desired: number; max: number; issues?: Array<{ code: string; message: string }> }>;
  nodes: Array<{ nodegroup?: string; ready?: boolean; schedulable?: boolean }>;
  problems?: Array<{ pod: string; workload?: string; reason: string; message: string }>;
};

/** Compare the live state with a target size. MISMATCH = the spec isn't what was planned
 * (the apply stopped, or something else changed it); PROGRESSING = spec right, pods or
 * nodes still coming; READY = spec right and everything ready. */
export function verifyLive(state: VerifyState, size: LiveTierSize): RolloutCheck {
  let mismatch = false;
  let progressing = false;
  const workloads = Object.entries(size.workloads ?? {}).map(([name, want]) => {
    const w = state.workloads.find((x) => x.name === name);
    if (!w) {
      mismatch = true;
      return { name, want: want.replicas, spec: null, ready: null, ok: false, note: "not found on the cluster" };
    }
    if (w.replicas !== want.replicas) {
      mismatch = true;
      return { name, want: want.replicas, spec: w.replicas, ready: w.ready, ok: false, note: `spec is ${w.replicas}, plan said ${want.replicas}` };
    }
    // done = the controller observed this spec AND every replica is updated and available (not just "ready")
    const ro = w.rollout;
    if (ro && !ro.observed) {
      progressing = true;
      return { name, want: want.replicas, spec: w.replicas, ready: w.ready, ok: false, note: "the deployment controller hasn't observed the new spec yet" };
    }
    // `kubectl rollout status` semantics: every desired replica updated, no old replicas left
    // (total == desired), all available, none unavailable — old pods can't mask new ones
    if (ro) {
      const notUpdated = w.replicas - ro.updated;
      const oldLeft = (ro.total ?? w.replicas) - w.replicas;
      const notAvailable = Math.max(w.replicas - ro.available, ro.unavailable ?? 0);
      if (notUpdated > 0 || oldLeft > 0 || notAvailable > 0) {
        progressing = true;
        const bits = [notUpdated > 0 ? `${notUpdated} pod(s) not updated` : "", oldLeft > 0 ? `${oldLeft} old pod(s) still running` : "", notAvailable > 0 ? `${notAvailable} pod(s) not available` : ""].filter(Boolean);
        return { name, want: want.replicas, spec: w.replicas, ready: w.ready, ok: false, note: bits.join(", ") };
      }
    } else if (w.ready < w.replicas) {
      progressing = true;
      return { name, want: want.replicas, spec: w.replicas, ready: w.ready, ok: false, note: `${w.replicas - w.ready} pod(s) not ready yet` };
    }
    return { name, want: want.replicas, spec: w.replicas, ready: w.ready, ok: true };
  });
  const nodegroups = Object.entries(size.nodegroups ?? {}).map(([name, want]) => {
    const g = state.nodegroups.find((x) => x.name === name);
    const inGroup = state.nodes.filter((n) => n.nodegroup === name);
    // only Ready, schedulable nodes count as capacity; a cordoned node is draining (scale-down),
    // a registered-but-NotReady one is still joining (scale-up)
    const nodes = inGroup.filter((n) => n.ready !== false && n.schedulable !== false).length;
    const draining = inGroup.filter((n) => n.schedulable === false).length;
    const joining = inGroup.filter((n) => n.ready === false && n.schedulable !== false).length;
    const counts = { nodes, joining, draining, total: inGroup.length };
    if (!g) {
      mismatch = true;
      return { name, want, spec: null, ...counts, ok: false, note: "node group not found" };
    }
    const spec = { min: g.min, desired: g.desired, max: g.max };
    if (g.min !== want.min || g.desired !== want.desired || g.max !== want.max) {
      mismatch = true;
      return { name, want, spec, ...counts, ok: false, note: `spec ${g.min}/${g.desired}/${g.max}, plan said ${want.min}/${want.desired}/${want.max}` };
    }
    if (nodes < want.desired) {
      progressing = true;
      return { name, want, spec, ...counts, ok: false, note: `${want.desired - nodes} node(s) not Ready+schedulable yet (EC2 + bootstrap take a few minutes)` };
    }
    // scale-down: done only when the extra nodes are gone, not when the spec says so
    if (inGroup.length > want.desired) {
      progressing = true;
      return { name, want, spec, ...counts, ok: false, note: `${inGroup.length - want.desired} node(s) still draining / terminating (pods move off first)` };
    }
    return { name, want, spec, ...counts, ok: true };
  });
  return { verdict: mismatch ? "MISMATCH" : progressing ? "PROGRESSING" : "READY", workloads, nodegroups, issues: rolloutIssues(state, size) };
}

/** Stuck pods (grouped by workload + reason) and node-group health issues, for the planned
 * node groups and every workload in the target namespaces (a drain can strand any of them). */
export function rolloutIssues(state: VerifyState, size: LiveTierSize): RolloutCheck["issues"] {
  const out: RolloutCheck["issues"] = [];
  const groups = new Map<string, { subject: string; reason: string; message: string; count: number }>();
  for (const p of state.problems ?? []) {
    const subject = p.workload ?? p.pod;
    const key = `${subject}\u0000${p.reason}`;
    const g = groups.get(key);
    if (g) g.count += 1;
    else groups.set(key, { subject, reason: p.reason, message: p.message, count: 1 });
  }
  for (const g of groups.values()) out.push({ kind: "pod", ...g });
  for (const name of Object.keys(size.nodegroups ?? {})) {
    for (const i of state.nodegroups.find((x) => x.name === name)?.issues ?? []) out.push({ kind: "nodegroup", subject: name, reason: i.code, message: i.message });
  }
  return out;
}

/** True when `a` is at least `b` everywhere `b` names (replicas, node-group desired). */
export function atLeastAsLarge(a: LiveTierSize, b: LiveTierSize): boolean {
  for (const [n, w] of Object.entries(b.workloads ?? {})) if ((a.workloads?.[n]?.replicas ?? Infinity) < w.replicas) return false;
  for (const [n, g] of Object.entries(b.nodegroups ?? {})) if ((a.nodegroups?.[n]?.desired ?? Infinity) < g.desired) return false;
  return true;
}

/** The smallest named template that is OK at `rps` (by assessLive), else null. With
 * `atLeast` (what runs now), never one that is smaller anywhere: no downsizing mid-incident. */
export function recommendTemplate(profile: LiveProfile, templates: Array<{ name: string; size: LiveTierSize }>, rps: number, atLeast?: LiveTierSize): { name: string; size: LiveTierSize; assessment: LiveAssessment } | null {
  const scored = templates
    .filter((t) => !atLeast || atLeastAsLarge(t.size, atLeast))
    .map((t) => ({ ...t, assessment: assessLive(profile, t.size, rps), weight: Object.values(t.size.workloads ?? {}).reduce((a, w) => a + w.replicas, 0) }))
    .filter((t) => t.assessment.verdict === "OK")
    .sort((a, b) => a.weight - b.weight);
  return scored[0] ? { name: scored[0].name, size: scored[0].size, assessment: scored[0].assessment } : null;
}
