// Traffic history for capacity planning (docs/NEBULA.md §N5.4). READ ONLY.
//   trafficPeaks: sudden ramps in the last ≤14 days of per-minute edge req/s (ALB
//     metrics keep 1-minute points for 15 days), with p95 and 5xx in each burst.
//   trafficWindow: one event minute by minute — req/s, p95, 5xx, plus pods and CPU per
//     modelled workload and node CPU per node group (Container Insights keeps those 1 day).
// Same load balancer and cluster as the Monitor pane (monitor-model MONITOR_TARGETS).
import { awsService, getMetricSeries, listMetricDims, type MetricQuery, type Series } from "@twizz-idp/core";
import { findBursts, loadCases, type Burst } from "@twizz-idp/actions";
import type { LiveProfile } from "@twizz-idp/shared";
import { MONITOR_TARGETS, type MonitorTier } from "./monitor-model";
import { namedEnvDeps } from "./deps";

const MIN = 60_000;

/** Logs Insights `bin()` values are UTC without a zone ("2026-11-05 22:18:00.000"); accept an
 * explicit zone too, and drop anything unparseable instead of mis-joining it. */
export function insightsTime(v: string): number | null {
  const iso = v.includes("T") ? v : v.replace(" ", "T");
  const t = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`);
  return Number.isFinite(t) ? t : null;
}

async function edgeDims(tier: MonitorTier): Promise<{ ns: string; dims: Record<string, string>; latency: boolean }> {
  const t = MONITOR_TARGETS[tier];
  if (t.lb.kind === "elb") return { ns: "AWS/ELB", dims: { LoadBalancerName: t.lb.name }, latency: false };
  const prefix = t.lb.prefix;
  const all = await listMetricDims("AWS/ApplicationELB", "RequestCount", {});
  const lb = all.find((d) => d.LoadBalancer?.startsWith(prefix) && !d.TargetGroup && !d.AvailabilityZone)?.LoadBalancer ?? all.find((d) => d.LoadBalancer?.startsWith(prefix))?.LoadBalancer;
  if (!lb) throw new Error(`no ALB matching ${prefix} reported in the last 3 h`);
  return { ns: "AWS/ApplicationELB", dims: { LoadBalancer: lb }, latency: true };
}

function edgeQueries(e: { ns: string; dims: Record<string, string>; latency: boolean }, period: number): MetricQuery[] {
  const alb = e.ns === "AWS/ApplicationELB";
  return [
    { id: "req", namespace: e.ns, metric: "RequestCount", dims: e.dims, stat: "Sum", period },
    ...(e.latency ? [{ id: "p95", namespace: e.ns, metric: "TargetResponseTime", dims: e.dims, stat: "p95", period }] : []),
    { id: "t5", namespace: e.ns, metric: alb ? "HTTPCode_Target_5XX_Count" : "HTTPCode_Backend_5XX", dims: e.dims, stat: "Sum", period },
    { id: "e5", namespace: e.ns, metric: alb ? "HTTPCode_ELB_5XX_Count" : "HTTPCode_ELB_5XX", dims: e.dims, stat: "Sum", period },
  ];
}

const perMinute = (s: Series | undefined): Series => (s ?? []).map(([t, v]) => [t, v / 60]);
const inWindow = (s: Series | undefined, from: number, to: number) => (s ?? []).filter(([t]) => t >= from && t <= to);

export type TrafficPeak = Burst & { startIso: string; peakAtIso: string; p95MaxMs: number | null; p95BeforeMs: number | null; err5xx: number };

export async function trafficPeaks(tier: MonitorTier, days: number, limit = 8): Promise<{ tier: MonitorTier; source: string; from: string; to: string; peaks: TrafficPeak[] }> {
  const end = Math.floor(Date.now() / MIN) * MIN;
  const start = end - Math.min(14, Math.max(1, days)) * 24 * 60 * MIN;
  const e = await edgeDims(tier);
  const r = await getMetricSeries(edgeQueries(e, 60), start, end);
  const bursts = findBursts(perMinute(r.req), { limit });
  const peaks = bursts.map((b) => {
    const w = (s: Series | undefined) => inWindow(s, b.start - 2 * MIN, b.end + 2 * MIN);
    const p95 = w(r.p95).map(([, v]) => v * 1000);
    const before = inWindow(r.p95, b.start - 15 * MIN, b.start - MIN).map(([, v]) => v * 1000);
    const errs = [...w(r.t5), ...w(r.e5)].reduce((a, [, v]) => a + v, 0);
    return {
      ...b,
      startIso: new Date(b.start).toISOString(),
      peakAtIso: new Date(b.peakAt).toISOString(),
      p95MaxMs: p95.length ? Math.round(Math.max(...p95)) : null,
      p95BeforeMs: before.length ? Math.round(before.reduce((a, v) => a + v, 0) / before.length) : null,
      err5xx: Math.round(errs),
    };
  });
  return { tier, source: `${e.ns} ${Object.values(e.dims)[0]}`, from: new Date(start).toISOString(), to: new Date(end).toISOString(), peaks };
}

const POD_QUERY = (names: string[]) =>
  `filter Type="Pod" and PodName in [${names.map((n) => JSON.stringify(n)).join(",")}] | stats count_distinct(kubernetes.pod_name) as pods, avg(pod_cpu_usage_total) as cpuAvg, max(pod_cpu_usage_total) as cpuMax by PodName, bin(1m) as t | sort t asc`;
const NODE_QUERY = `filter Type="Node" | stats count_distinct(NodeName) as nodes, avg(node_cpu_utilization) as cpuAvg, max(node_cpu_utilization) as cpuMax by bin(1m) as t | sort t asc`;

export type TrafficMinute = {
  t: string;
  rps: number;
  p95Ms: number | null;
  err5xx: number;
  workloads: Record<string, { pods: number; mcpuAvg: number; mcpuMax: number }>;
  nodes: { count: number; cpuAvgPct: number; cpuMaxPct: number } | null;
};

/** One event, minute by minute (≤ 3 h). Pod/node figures exist only inside Container
 * Insights' 1-day retention; older windows return edge metrics only, and say so. */
export async function trafficWindow(tier: MonitorTier, fromIso: string, toIso: string, profile?: LiveProfile): Promise<{ tier: MonitorTier; from: string; to: string; minutes: TrafficMinute[]; samples: { podMinutes: number; nodeMinutes: number }; podMetrics: "complete" | "timeout" | "failed" | "expired"; note?: string }> {
  const from = Math.floor(Date.parse(fromIso) / MIN) * MIN;
  let to = Math.ceil(Date.parse(toIso) / MIN) * MIN;
  if (!(to > from)) throw new Error("`to` must be after `from`");
  if (to - from > 3 * 60 * MIN) to = from + 3 * 60 * MIN;
  const e = await edgeDims(tier);
  const r = await getMetricSeries(edgeQueries(e, 60), from, to);
  const at = (s: Series | undefined) => new Map((s ?? []).map(([t, v]) => [t, v]));
  const req = at(r.req);
  const p95 = at(r.p95);
  const t5 = at(r.t5);
  const e5 = at(r.e5);

  const workloadNames = profile ? Object.keys(profile.workloads).map((n) => n) : [];
  // Container Insights keeps pod/node data ~1 day: query the RETAINED part of the window
  const retainedFrom = Math.max(from, Math.ceil((Date.now() - 24 * 60 * MIN) / MIN) * MIN);
  const expired = retainedFrom >= to;
  const partial = !expired && retainedFrom > from;
  let podMetrics: "complete" | "timeout" | "failed" | "expired" = "expired";
  const pods = new Map<number, TrafficMinute["workloads"]>();
  const nodes = new Map<number, NonNullable<TrafficMinute["nodes"]>>();
  if (!expired) {
    const cluster = MONITOR_TARGETS[tier].cluster;
    const [p, n] = await Promise.all([
      workloadNames.length ? awsService.queryPerformance(cluster, POD_QUERY(workloadNames), ["PodName", "t", "pods", "cpuAvg", "cpuMax"], retainedFrom / 1000, to / 1000) : Promise.resolve({ status: "complete" as const, rows: [] }),
      awsService.queryPerformance(cluster, NODE_QUERY, ["t", "nodes", "cpuAvg", "cpuMax"], retainedFrom / 1000, to / 1000),
    ]);
    podMetrics = p.status !== "complete" ? p.status : n.status;
    for (const row of p.rows) {
      const t = insightsTime(row.t);
      if (t === null) continue;
      const m = pods.get(t) ?? {};
      m[row.PodName] = { pods: Number(row.pods), mcpuAvg: Math.round(Number(row.cpuAvg)), mcpuMax: Math.round(Number(row.cpuMax)) };
      pods.set(t, m);
    }
    for (const row of n.rows) {
      const t = insightsTime(row.t);
      if (t !== null) nodes.set(t, { count: Number(row.nodes), cpuAvgPct: Math.round(Number(row.cpuAvg)), cpuMaxPct: Math.round(Number(row.cpuMax)) });
    }
  }
  const minutes: TrafficMinute[] = [];
  for (let t = from; t < to; t += MIN) {
    minutes.push({
      t: new Date(t).toISOString(),
      rps: Math.round((req.get(t) ?? 0) / 60),
      p95Ms: p95.has(t) ? Math.round(p95.get(t)! * 1000) : null,
      err5xx: Math.round((t5.get(t) ?? 0) + (e5.get(t) ?? 0)),
      workloads: pods.get(t) ?? {},
      nodes: nodes.get(t) ?? null,
    });
  }
  // a query that "completes" with no samples is a data gap, not health (Codex review)
  if (podMetrics === "complete" && !expired && ((workloadNames.length && pods.size === 0) || nodes.size === 0)) podMetrics = "failed";
  return {
    tier,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    minutes,
    samples: { podMinutes: pods.size, nodeMinutes: nodes.size },
    podMetrics,
    note: expired
      ? "pod and node metrics are kept 1 day: only edge req/s, p95 and 5xx for this window"
      : partial
        ? `pod and node metrics only from ${new Date(retainedFrom).toISOString()} (1-day retention); earlier minutes have edge metrics only`
        : !workloadNames.length
          ? "no live profile: pod breakdown skipped"
          : undefined,
  };
}

export async function capacityCases() {
  return loadCases(namedEnvDeps().promotions);
}
