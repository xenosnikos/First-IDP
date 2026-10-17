// Monitor (docs/NEBULA.md §N6): the pure half — targets, windows, query ids,
// series maths and the signal thresholds. No AWS / Atlas / kube imports, so
// every rule here is unit-tested. READ ONLY by construction: the Monitor only
// ever reads CloudWatch, the Atlas measurements API and the live kube state.
import type { StatusWord } from "@/lib/nebula/status";

export const MONITOR_TIERS = ["production", "staging"] as const;
export type MonitorTier = (typeof MONITOR_TIERS)[number];

export type LbSource = { kind: "alb"; prefix: string } | { kind: "elb"; name: string };

export type MonitorTarget = {
  tier: MonitorTier;
  cluster: string;
  namespaces: readonly string[];
  /** what fronts the API (found live: the ALB is owned by the AWS LB controller and can be recreated) */
  lb: LbSource;
  /** which Atlas account + clusters back this tier */
  atlas: { account: "prod" | "nonprod"; clusters?: readonly string[]; note?: string };
};

export const MONITOR_TARGETS: Record<MonitorTier, MonitorTarget> = {
  production: {
    tier: "production",
    cluster: "EKS-Moly-Prod",
    namespaces: ["default", "jobs"],
    // the AWS LB controller's ingress group (moly-backend, invoice-gen, sendgrid…);
    // ALB-Prod-Moly-API is legacy and carries no traffic
    lb: { kind: "alb", prefix: "app/k8s-internalingressgr-" },
    atlas: { account: "prod" },
  },
  staging: {
    tier: "staging",
    cluster: "EKS-Moly-staging",
    namespaces: ["default", "jobs"],
    // ingress-nginx's classic ELB (apistg.twizz.com)
    lb: { kind: "elb", name: "ada851bddef6b4684964f3c42b81a0db" },
    atlas: { account: "nonprod", clusters: ["NonProd-Twizz"], note: "shared with the NonProd previews" },
  },
};

export const MONITOR_WINDOWS = ["15m", "1h", "6h", "24h"] as const;
export type MonitorWindow = (typeof MONITOR_WINDOWS)[number];
export const WINDOW_SPEC: Record<MonitorWindow, { ms: number; period: number; atlas: { granularity: "PT1M" | "PT5M"; period: string } }> = {
  "15m": { ms: 15 * 60_000, period: 60, atlas: { granularity: "PT1M", period: "PT15M" } },
  "1h": { ms: 3_600_000, period: 60, atlas: { granularity: "PT1M", period: "PT1H" } },
  "6h": { ms: 6 * 3_600_000, period: 300, atlas: { granularity: "PT5M", period: "PT6H" } },
  "24h": { ms: 24 * 3_600_000, period: 900, atlas: { granularity: "PT5M", period: "P1D" } },
};

/** [epochMs, value] ascending */
export type Series = Array<[number, number]>;

export const last = (s: Series | undefined): number | undefined => (s && s.length ? s[s.length - 1][1] : undefined);
export const lastAt = (s: Series | undefined): number | undefined => (s && s.length ? s[s.length - 1][0] : undefined);
export const maxOf = (s: Series | undefined): number | undefined => (s && s.length ? Math.max(...s.map((p) => p[1])) : undefined);
/** mean of the points in the trailing `ms` (default: the last 5 minutes of data) */
export function recent(s: Series | undefined, ms = 5 * 60_000): number | undefined {
  return recentOf(s, ms);
}
function recentOf(s: Series | undefined, ms: number): number | undefined {
  if (!s || !s.length) return undefined;
  const end = s[s.length - 1][0];
  const xs = s.filter((p) => p[0] > end - ms).map((p) => p[1]);
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
export const scale = (s: Series | undefined, k: number): Series => (s ?? []).map(([t, v]) => [t, v * k]);
/** pointwise a ⊕ b on shared timestamps (missing on one side counts as 0) */
export function combine(a: Series | undefined, b: Series | undefined, f: (x: number, y: number) => number): Series {
  const m = new Map<number, [number, number]>();
  for (const [t, v] of a ?? []) m.set(t, [v, 0]);
  for (const [t, v] of b ?? []) m.set(t, [m.get(t)?.[0] ?? 0, v]);
  return [...m.entries()].sort((x, y) => x[0] - y[0]).map(([t, [x, y]]) => [t, f(x, y)]);
}
export const sumAll = (xs: Array<Series | undefined>): Series => xs.reduce<Series>((acc, s) => combine(acc, s, (x, y) => x + y), []);

/** k8s ALB target group `k8s-<ns>-<svc>-<hash>` → its service fragment */
export function tgLabel(targetGroup: string): string {
  const name = targetGroup.replace(/^targetgroup\//, "").split("/")[0];
  const m = /^k8s-([^-]+)-(.+)-[0-9a-f]{10}$/.exec(name);
  return m ? m[2] : name;
}

/** CloudWatch query ids: [a-z][A-Za-z0-9_]* */
export const qid = (...parts: Array<string | number>) => parts.map((p) => String(p).replace(/[^A-Za-z0-9]/g, "_")).join("_").replace(/^([^a-z])/, "q$1");

// ── signals: the "pressure board" ──────────────────────────────────────

export type Signal = { key: string; label: string; word: StatusWord; value: string; detail?: string };

/** data older than this is UNKNOWN; coarse windows get 2 buckets + CloudWatch's lag */
export const staleMs = (periodS: number) => Math.max(6 * 60_000, 2 * periodS * 1000 + 3 * 60_000);
/** the window's end, snapped to the last COMPLETE period (a partial bucket under-reports Sums) */
export const snapEnd = (nowMs: number, periodS: number) => Math.floor(nowMs / (periodS * 1000)) * periodS * 1000;
/** ≥ watch → WATCH, ≥ hot → HOT */
export function level(v: number | undefined, watch: number, hot: number): StatusWord {
  if (v === undefined || Number.isNaN(v)) return "UNKNOWN";
  return v >= hot ? "HOT" : v >= watch ? "WATCH" : "OK";
}
const worst = (ws: StatusWord[]): StatusWord => (ws.includes("HOT") ? "HOT" : ws.includes("WATCH") ? "WATCH" : ws.length && ws.every((w) => w === "UNKNOWN") ? "UNKNOWN" : "OK");
const pct = (v: number | undefined, d = 0) => (v === undefined ? "—" : `${v.toFixed(d)}%`);


export const THRESHOLDS = {
  errPct: { watch: 1, hot: 5 },
  p95s: { watch: 1, hot: 3 },
  nodeCpu: { watch: 70, hot: 85 },
  nodeMem: { watch: 75, hot: 90 },
  dbCpu: { watch: 60, hot: 80 },
  dbConnPct: { watch: 70, hot: 90 },
  /** scanned/returned: an index hint, never HOT on its own */
  targeting: { watch: 1000 },
} as const;

export type SignalInput = {
  now: number;
  /** the query period (s): sets staleness and the "recent" span */
  period?: number;
  traffic?: { rps: Series; p95: Series; errPct: Series; latency?: boolean } | null;
  nodes?: { cpu: Series; mem: Series; cpuMax: Series } | null;
  nodegroups?: Array<{ name: string; desired: number; max: number }> | null;
  workloads?: Array<{ name: string; ready: number; replicas: number }> | null;
  restarts?: Array<{ name: string; delta: number }>;
  atlas?: Array<{ cluster: string; cpu: Series; conns: Series; connLimit?: number; targeting: Series }> | null;
};

export function deriveSignals(i: SignalInput): Signal[] {
  const out: Signal[] = [];
  const stale = staleMs(i.period ?? 60);
  const fresh = (s: Series | undefined, now: number) => {
    const t = lastAt(s);
    return t !== undefined && now - t <= stale;
  };
  // "last 5 min", or the last bucket on coarse windows
  const span = Math.max(5 * 60_000, (i.period ?? 60) * 1000);
  const recent = (s: Series | undefined) => recentOf(s, span);
  const unknown = (key: string, label: string, detail: string): Signal => ({ key, label, word: "UNKNOWN", value: "—", detail });

  if (i.traffic) {
    const ok = fresh(i.traffic.rps, i.now);
    const rps = recent(i.traffic.rps);
    out.push(ok ? { key: "rps", label: "requests", word: "OK", value: `${(rps ?? 0).toFixed(1)} rps`, detail: `peak ${(maxOf(i.traffic.rps) ?? 0).toFixed(1)} rps in window` } : unknown("rps", "requests", "no recent load-balancer data"));
    const err = recent(i.traffic.errPct);
    out.push(ok ? { key: "err", label: "5xx rate", word: level(err ?? 0, THRESHOLDS.errPct.watch, THRESHOLDS.errPct.hot), value: pct(err ?? 0, 2), detail: "target + load-balancer 5xx, latest" } : unknown("err", "5xx rate", "no recent data"));
    const p95 = recent(i.traffic.p95);
    if (i.traffic.latency !== false) out.push(p95 !== undefined && ok ? { key: "p95", label: "latency p95", word: level(p95, THRESHOLDS.p95s.watch, THRESHOLDS.p95s.hot), value: `${Math.round(p95 * 1000)} ms`, detail: "latest" } : unknown("p95", "latency p95", "no recent data"));
  } else out.push(unknown("rps", "requests", "load balancer not found"));

  if (i.nodes && fresh(i.nodes.cpu, i.now)) {
    const cpu = recent(i.nodes.cpu), mem = recent(i.nodes.mem), hottest = recent(i.nodes.cpuMax);
    out.push({ key: "nodecpu", label: "node CPU", word: worst([level(cpu, THRESHOLDS.nodeCpu.watch, THRESHOLDS.nodeCpu.hot), level(hottest, 90, 101)]), value: pct(cpu), detail: `avg across nodes · hottest ${pct(hottest)}` });
    out.push({ key: "nodemem", label: "node memory", word: level(mem, THRESHOLDS.nodeMem.watch, THRESHOLDS.nodeMem.hot), value: pct(mem), detail: "avg across nodes" });
  } else out.push(unknown("nodecpu", "node CPU", "no recent Container Insights data"));

  if (i.nodegroups) {
    const full = i.nodegroups.filter((g) => g.desired >= g.max);
    out.push({ key: "headroom", label: "node headroom", word: full.length ? "WATCH" : "OK", value: full.length ? `${full.length} group(s) at max` : "can scale out", detail: full.length ? `${full.map((g) => g.name).join(", ")}: desired = max — raise max on /capacity before a spike` : i.nodegroups.map((g) => `${g.name} ${g.desired}/${g.max}`).join(" · ") });
  }

  if (i.workloads) {
    const short = i.workloads.filter((w) => w.ready < w.replicas);
    const bad = short.filter((w) => w.ready * 2 <= w.replicas);
    const restarting = (i.restarts ?? []).filter((r) => r.delta > 0);
    out.push({
      key: "pods",
      label: "workloads",
      word: worst([bad.length ? "HOT" : short.length ? "WATCH" : "OK", restarting.length ? "WATCH" : "OK"]),
      value: short.length ? `${short.length} not fully ready` : "all ready",
      detail: [...short.map((w) => `${w.name} ${w.ready}/${w.replicas}`), ...restarting.map((r) => `${r.name} +${r.delta} restart(s)`)].join(" · ") || `${i.workloads.length} deployments`,
    });
  }

  for (const a of i.atlas ?? []) {
    if (!fresh(a.cpu, i.now)) {
      out.push(unknown(`db-${a.cluster}`, `${a.cluster}`, "no recent Atlas measurements"));
      continue;
    }
    const cpu = recent(a.cpu), conns = last(a.conns), tq = recent(a.targeting);
    const connPct = conns !== undefined && a.connLimit ? (conns / a.connLimit) * 100 : undefined;
    out.push({
      key: `db-${a.cluster}`,
      label: a.cluster,
      word: worst([level(cpu, THRESHOLDS.dbCpu.watch, THRESHOLDS.dbCpu.hot), connPct === undefined ? "OK" : level(connPct, THRESHOLDS.dbConnPct.watch, THRESHOLDS.dbConnPct.hot), level(tq ?? 0, THRESHOLDS.targeting.watch, Infinity)]),
      value: `CPU ${pct(cpu)}`,
      detail: `${conns === undefined ? "?" : Math.round(conns)} conns${connPct !== undefined ? ` (${connPct.toFixed(0)}% of tier max)` : ""}${tq !== undefined && tq >= THRESHOLDS.targeting.watch ? ` · query targeting ${Math.round(tq)} scanned/returned (missing index?)` : ""}`,
    });
  }
  return out;
}
