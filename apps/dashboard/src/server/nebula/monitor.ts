// Monitor (docs/NEBULA.md §N6): one consolidated, near-real-time view per
// Moly cluster — traffic (load balancer), CPU/memory (Container Insights),
// pods + node headroom (kube), and the database (Atlas measurements).
// READ ONLY. Every source is read with the dashboard's existing access
// (cloudwatch:GetMetricData/ListMetrics, the Atlas keys, group nebula-capacity
// reads); nothing here writes. One snapshot per (tier, window) is cached for
// 30 s and shared by every viewer, which caps the CloudWatch spend.
import { atlasTierService, getMetricSeries, listMetricDims, prodAtlasTierService, type AtlasTierService, type MetricQuery } from "@twizz-idp/core";
import { ATLAS_LIMITS } from "@twizz-idp/actions";
import { ATLAS_TIERS, type AtlasTier } from "@twizz-idp/shared";
import { readLive } from "./capacity";
import {
  MONITOR_TARGETS,
  WINDOW_SPEC,
  combine,
  deriveSignals,
  snapEnd,
  last,
  qid,
  scale,
  sumAll,
  tgLabel,
  type MonitorTarget,
  type MonitorTier,
  type MonitorWindow,
  type Series,
  type Signal,
} from "./monitor-model";

const errMsg = (e: unknown) => String((e as Error)?.message ?? e);
const CI = "ContainerInsights";

/** small TTL cache that shares the in-flight promise (and forgets failures) */
function cached<T>(ttlMs: number) {
  const m = new Map<string, { at: number; p: Promise<T> }>();
  return (key: string, f: () => Promise<T>): Promise<T> => {
    const hit = m.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.p;
    const p = f();
    m.set(key, { at: Date.now(), p });
    p.catch(() => m.delete(key));
    return p;
  };
}
// ≈ the client's 60 s poll, so N viewers share one build per minute
const snapshotCache = cached<MonitorSnapshot>(55_000);
const dimsCache = cached<Array<Record<string, string>>>(10 * 60_000);
// short: a resize (or any failover) moves the primary
const procCache = cached<{ primary?: string }>(60_000);

// ── traffic ────────────────────────────────────────────────────────────

export type Traffic = {
  source: string;
  /** false: the LB measures connections, not requests (TCP listener) — no latency shown */
  latency: boolean;
  rps: Series;
  p95: Series;
  p50: Series;
  errPct: Series;
  err5xx: Series;
  byService: Array<{ name: string; rps: Series; p95: Series; err5xx: Series }>;
};

async function readTraffic(t: MonitorTarget, start: number, end: number, period: number): Promise<Traffic> {
  if (t.lb.kind === "elb") {
    const dims = { LoadBalancerName: t.lb.name };
    const q = (id: string, metric: string, stat: string): MetricQuery => ({ id, namespace: "AWS/ELB", metric, dims, stat, period });
    // staging's ELB is a TCP listener in front of ingress-nginx: its `Latency`
    // is connection set-up (~10 µs), not request time, so none is reported
    const r = await getMetricSeries([q("req", "RequestCount", "Sum"), q("b5", "HTTPCode_Backend_5XX", "Sum"), q("e5", "HTTPCode_ELB_5XX", "Sum")], start, end);
    const req = r.req ?? [];
    const e5 = combine(r.b5, r.e5, (a, b) => a + b);
    return { source: `classic ELB ${t.lb.name.slice(0, 12)}… (TCP)`, latency: false, rps: scale(req, 1 / period), p95: [], p50: [], err5xx: e5, errPct: errPct(req, e5), byService: [] };
  }
  const prefix = t.lb.prefix;
  const all = await dimsCache(`alb:${prefix}`, () => listMetricDims("AWS/ApplicationELB", "RequestCount", {}));
  const mine = all.filter((d) => d.LoadBalancer?.startsWith(prefix));
  const lb = mine.find((d) => !d.TargetGroup && !d.AvailabilityZone)?.LoadBalancer ?? mine[0]?.LoadBalancer;
  if (!lb) throw new Error(`no ALB matching ${prefix} reported in the last 3 h`);
  const tgs = [...new Set(mine.filter((d) => d.LoadBalancer === lb && d.TargetGroup && !d.AvailabilityZone).map((d) => d.TargetGroup))];
  const q = (id: string, metric: string, stat: string, dims: Record<string, string>): MetricQuery => ({ id, namespace: "AWS/ApplicationELB", metric, dims, stat, period });
  const L = { LoadBalancer: lb };
  const queries: MetricQuery[] = [
    q("req", "RequestCount", "Sum", L),
    q("p95", "TargetResponseTime", "p95", L),
    q("p50", "TargetResponseTime", "p50", L),
    q("t5", "HTTPCode_Target_5XX_Count", "Sum", L),
    q("e5", "HTTPCode_ELB_5XX_Count", "Sum", L),
    ...tgs.flatMap((tg, k) => {
      const D = { LoadBalancer: lb, TargetGroup: tg };
      return [q(qid("tg", k, "req"), "RequestCount", "Sum", D), q(qid("tg", k, "p95"), "TargetResponseTime", "p95", D), q(qid("tg", k, "t5"), "HTTPCode_Target_5XX_Count", "Sum", D)];
    }),
  ];
  const r = await getMetricSeries(queries, start, end);
  const req = r.req ?? [];
  const e5 = combine(r.t5, r.e5, (a, b) => a + b);
  return {
    source: `ALB ${lb.split("/")[1]}`,
    latency: true,
    rps: scale(req, 1 / period),
    p95: r.p95 ?? [],
    p50: r.p50 ?? [],
    err5xx: e5,
    errPct: errPct(req, e5),
    byService: tgs
      .map((tg, k) => ({ name: tgLabel(tg), rps: scale(r[qid("tg", k, "req")], 1 / period), p95: r[qid("tg", k, "p95")] ?? [], err5xx: r[qid("tg", k, "t5")] ?? [] }))
      // target groups that served nothing in the window (grafana, prometheus…) are noise here
      .filter((x) => x.rps.some((p) => p[1] > 0))
      .sort((a, b) => (last(b.rps) ?? 0) - (last(a.rps) ?? 0)),
  };
}
const errPct = (req: Series, e5: Series): Series => combine(req, e5, (r, e) => (r > 0 ? (e / r) * 100 : 0));

// ── cluster + workloads (Container Insights) ────────────────────────────

export type WorkloadMetrics = { namespace: string; name: string; cpuCores: Series; cpuMaxPodCores: Series; memGi: Series; pods: Series; restarts: Series };
export type NodeMetrics = { cpu: Series; cpuMax: Series; mem: Series; memMax: Series; count: Series };

/** without a live Deployment list, query at most this many workloads (Job pods add a name per run) */
const MAX_WORKLOADS = 25;

async function readContainerInsights(t: MonitorTarget, start: number, end: number, period: number, deployments: Set<string> | null): Promise<{ nodes: NodeMetrics; workloads: WorkloadMetrics[] }> {
  const C = { ClusterName: t.cluster };
  const dims = (await Promise.all(t.namespaces.map((ns) => dimsCache(`ci:${t.cluster}:${ns}`, () => listMetricDims(CI, "pod_cpu_usage_total", { ...C, Namespace: ns })))))
    .flat()
    .filter((d) => d.PodName && Object.keys(d).length === 3);
  const workloads = [...new Map(dims.map((d) => [`${d.Namespace}/${d.PodName}`, { namespace: d.Namespace, name: d.PodName }])).values()]
    // only the Deployments that exist (CI's PodName for Job pods is the Job name: one per run)
    .filter((w) => !deployments || deployments.has(`${w.namespace}/${w.name}`))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, deployments ? undefined : MAX_WORKLOADS);
  const q = (id: string, metric: string, stat: string, d: Record<string, string>): MetricQuery => ({ id, namespace: CI, metric, dims: d, stat, period });
  const queries: MetricQuery[] = [
    q("ncpu", "node_cpu_utilization", "Average", C),
    q("ncpumax", "node_cpu_utilization", "Maximum", C),
    q("nmem", "node_memory_utilization", "Average", C),
    q("nmemmax", "node_memory_utilization", "Maximum", C),
    q("ncount", "cluster_node_count", "Average", C),
    ...workloads.flatMap((w, k) => {
      const D = { ...C, Namespace: w.namespace, PodName: w.name };
      return [
        q(qid("w", k, "cpu"), "pod_cpu_usage_total", "Sum", D),
        q(qid("w", k, "cpumax"), "pod_cpu_usage_total", "Maximum", D),
        q(qid("w", k, "cnt"), "pod_cpu_usage_total", "SampleCount", D),
        q(qid("w", k, "mem"), "pod_memory_working_set", "Sum", D),
        q(qid("w", k, "rst"), "pod_number_of_container_restarts", "Sum", D),
      ];
    }),
  ];
  const r = await getMetricSeries(queries, start, end);
  // the agent reports each pod every 60 s: SampleCount / (period / 60) ≈ pods
  const perMinute = period / 60;
  return {
    nodes: { cpu: r.ncpu ?? [], cpuMax: r.ncpumax ?? [], mem: r.nmem ?? [], memMax: r.nmemmax ?? [], count: r.ncount ?? [] },
    workloads: workloads.map((w, k) => ({
      ...w,
      // Sum over the period of per-minute samples → mean total millicores
      cpuCores: scale(r[qid("w", k, "cpu")], 1 / 1000 / perMinute),
      cpuMaxPodCores: scale(r[qid("w", k, "cpumax")], 1 / 1000),
      memGi: scale(r[qid("w", k, "mem")], 1 / 1024 ** 3 / perMinute),
      pods: scale(r[qid("w", k, "cnt")], 1 / perMinute),
      restarts: scale(r[qid("w", k, "rst")], 1 / perMinute),
    })),
  };
}

// ── database (Atlas measurements on the primary) ────────────────────────

export type DbMetrics = { cluster: string; tier: string; state: string; autoScaling?: { min: string; max: string }; connLimit?: number; cpu: Series; conns: Series; ops: Series; readMs: Series; writeMs: Series; memPct: Series; targeting: Series; note?: string; error?: string };

const ATLAS_METRICS = [
  "SYSTEM_NORMALIZED_CPU_USER",
  "SYSTEM_NORMALIZED_CPU_KERNEL",
  "CONNECTIONS",
  "OPCOUNTER_QUERY",
  "OPCOUNTER_INSERT",
  "OPCOUNTER_UPDATE",
  "OPCOUNTER_DELETE",
  "OPCOUNTER_GETMORE",
  "OPCOUNTER_CMD",
  "OP_EXECUTION_TIME_READS",
  "OP_EXECUTION_TIME_WRITES",
  "SYSTEM_MEMORY_USED",
  "SYSTEM_MEMORY_AVAILABLE",
  "QUERY_TARGETING_SCANNED_OBJECTS_PER_RETURNED",
] as const;

async function readDb(t: MonitorTarget, w: MonitorWindow): Promise<DbMetrics[]> {
  const svc: AtlasTierService | null = t.atlas.account === "prod" ? prodAtlasTierService() : process.env.ATLAS_PUBLIC_KEY ? atlasTierService : null;
  if (!svc) throw new Error(`${t.atlas.account} Atlas key not configured on the Nebula server`);
  const all = await svc.listClusterTiers();
  const clusters = t.atlas.clusters ? all.filter((c) => t.atlas.clusters!.includes(c.name)) : all;
  return Promise.all(
    clusters.map(async (c): Promise<DbMetrics> => {
      const tier = (ATLAS_TIERS as readonly string[]).includes(c.instanceSize) ? (c.instanceSize as AtlasTier) : undefined;
      const base = { cluster: c.name, tier: c.instanceSize, state: c.state, autoScaling: c.autoScaling, connLimit: tier ? ATLAS_LIMITS[tier].maxConns : undefined, note: t.atlas.note };
      const empty = { cpu: [], conns: [], ops: [], readMs: [], writeMs: [], memPct: [], targeting: [] };
      try {
        const { primary } = await procCache(`${t.atlas.account}:${c.name}`, () => svc.clusterProcesses(c.name));
        if (!primary) return { ...base, ...empty, error: "no primary found (paused or electing?)" };
        const m = await svc.processMeasurements(primary, { ...WINDOW_SPEC[w].atlas, metrics: ATLAS_METRICS });
        return {
          ...base,
          cpu: combine(m.SYSTEM_NORMALIZED_CPU_USER, m.SYSTEM_NORMALIZED_CPU_KERNEL, (a, b) => a + b),
          conns: m.CONNECTIONS ?? [],
          ops: sumAll([m.OPCOUNTER_QUERY, m.OPCOUNTER_INSERT, m.OPCOUNTER_UPDATE, m.OPCOUNTER_DELETE, m.OPCOUNTER_GETMORE, m.OPCOUNTER_CMD]),
          readMs: m.OP_EXECUTION_TIME_READS ?? [],
          writeMs: m.OP_EXECUTION_TIME_WRITES ?? [],
          memPct: combine(m.SYSTEM_MEMORY_USED, m.SYSTEM_MEMORY_AVAILABLE, (u, a) => (u + a > 0 ? (u / (u + a)) * 100 : 0)),
          targeting: m.QUERY_TARGETING_SCANNED_OBJECTS_PER_RETURNED ?? [],
        };
      } catch (e) {
        return { ...base, ...empty, error: errMsg(e) };
      }
    }),
  );
}

// ── the snapshot ──────────────────────────────────────────────────────

type Part<T> = { ok: T } | { error: string };
const part = <T,>(p: Promise<T>): Promise<Part<T>> => p.then((ok) => ({ ok }), (e) => ({ error: errMsg(e) }));

export type MonitorSnapshot = {
  tier: MonitorTier;
  cluster: string;
  window: MonitorWindow;
  period: number;
  at: string;
  traffic: Part<Traffic>;
  ci: Part<{ nodes: NodeMetrics; workloads: WorkloadMetrics[] }>;
  live: Part<{ workloads: Array<{ namespace: string; name: string; ready: number; replicas: number; hpa?: { min: number; max: number } }>; nodegroups: Array<{ name: string; min: number; desired: number; max: number; instanceTypes: string[] }>; vcpu: number; readAt: string }>;
  db: Part<DbMetrics[]>;
  signals: Signal[];
};

async function build(tier: MonitorTier, w: MonitorWindow): Promise<MonitorSnapshot> {
  const t = MONITOR_TARGETS[tier];
  const spec = WINDOW_SPEC[w];
  const now = Date.now();
  const end = snapEnd(now, spec.period);
  const start = end - spec.ms;
  const liveP = readLive(tier);
  const [traffic, ci, liveR, db] = await Promise.all([
    part(readTraffic(t, start, end, spec.period)),
    part(
      liveP.then((l) =>
        readContainerInsights(t, start, end, spec.period, "state" in l ? new Set(l.state.workloads.map((x) => `${x.namespace}/${x.name}`)) : null),
      ),
    ),
    liveP,
    part(readDb(t, w)),
  ]);
  const live: MonitorSnapshot["live"] =
    "state" in liveR
      ? {
          ok: {
            workloads: liveR.state.workloads.map((x) => ({ namespace: x.namespace, name: x.name, ready: x.ready, replicas: x.replicas, ...(x.hpa ? { hpa: { min: x.hpa.min, max: x.hpa.max } } : {}) })),
            nodegroups: liveR.state.nodegroups.map((g) => ({ name: g.name, min: g.min, desired: g.desired, max: g.max, instanceTypes: g.instanceTypes })),
            vcpu: liveR.state.nodes.reduce((a, n) => a + n.cpuCores, 0),
            readAt: liveR.state.readAt,
          },
        }
      : { error: liveR.error };
  const signals = deriveSignals({
    now,
    period: spec.period,
    traffic: "ok" in traffic ? traffic.ok : null,
    nodes: "ok" in ci ? ci.ok.nodes : null,
    nodegroups: "ok" in live ? live.ok.nodegroups : null,
    workloads: "ok" in live ? live.ok.workloads.filter((x) => x.replicas > 0) : null,
    restarts: "ok" in ci ? ci.ok.workloads.map((x) => ({ name: x.name, delta: Math.max(0, Math.round((last(x.restarts) ?? 0) - (x.restarts[0]?.[1] ?? 0))) })) : [],
    atlas: "ok" in db ? db.ok.map((d) => ({ cluster: d.cluster, cpu: d.cpu, conns: d.conns, connLimit: d.connLimit, targeting: d.targeting })) : null,
  });
  return { tier, cluster: t.cluster, window: w, period: spec.period, at: new Date(now).toISOString(), traffic, ci, live, db, signals };
}

export function monitorSnapshot(tier: MonitorTier, w: MonitorWindow): Promise<MonitorSnapshot> {
  return snapshotCache(`${tier}:${w}`, () => build(tier, w));
}
