"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@/server/routers/_app";
import { trpc } from "@/lib/trpc-client";
import { Pill } from "@/components/nebula/pill";
import { Button } from "@/components/nebula/button";
import { PageHeader } from "@/components/nebula/plate";

type Snap = inferRouterOutputs<AppRouter>["monitor"]["snapshot"];
type Series = Array<[number, number]>;
type Tier = "production" | "staging";
type Win = "15m" | "1h" | "6h" | "24h";

const TIER_LABEL: Record<Tier, string> = { production: "Prod", staging: "Staging" };
const WINDOWS: Win[] = ["15m", "1h", "6h", "24h"];
const REFRESH_MS = 60_000;

const label: CSSProperties = { fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--n-ink-faint)" };
const lastV = (s?: Series) => (s && s.length ? s[s.length - 1][1] : undefined);
const fmt = (v: number | undefined, d = 1, unit = "") => (v === undefined || Number.isNaN(v) ? "—" : `${v.toFixed(d)}${unit}`);

function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="n-plate" style={{ padding: 16, minWidth: 0 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, paddingBottom: 10, marginBottom: 8, borderBottom: "1px solid var(--n-hairline)" }}>
        <div className="n-display" style={{ fontSize: 18 }}>{title}</div>
        {right}
      </header>
      {children}
    </section>
  );
}

/** A small line chart. `max` pins the y-scale (e.g. 100 for percentages). */
function Spark({ s, max, height = 34, color = "var(--n-ion)", width = 220 }: { s?: Series; max?: number; height?: number; color?: string; width?: number }) {
  if (!s || s.length < 2) return <div style={{ height, fontSize: 10, color: "var(--n-ink-faint)", display: "flex", alignItems: "center" }}>no data</div>;
  const t0 = s[0][0], t1 = s[s.length - 1][0];
  const top = Math.max(max ?? 0, ...s.map((p) => p[1])) || 1;
  const x = (t: number) => ((t - t0) / (t1 - t0 || 1)) * width;
  const y = (v: number) => height - 2 - (v / top) * (height - 4);
  const d = s.map(([t, v], i) => `${i ? "L" : "M"}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join("");
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ width: "100%", height, display: "block" }} aria-hidden>
      <path d={`${d}L${width},${height}L0,${height}Z`} fill={`color-mix(in oklab, ${color} 14%, transparent)`} stroke="none" />
      <path d={d} fill="none" stroke={color} strokeWidth={1.4} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Metric({ name, value, s, max, color, hint }: { name: string; value: string; s?: Series; max?: number; color?: string; hint?: string }) {
  return (
    <div style={{ minWidth: 0 }} title={hint}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 6 }}>
        <span style={label}>{name}</span>
        <span style={{ fontSize: 15 }}>{value}</span>
      </div>
      <Spark s={s} max={max} color={color} />
    </div>
  );
}

const grid = (min: number): CSSProperties => ({ display: "grid", gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`, gap: 14 });

function Err({ what, msg }: { what: string; msg: string }) {
  return <div style={{ fontSize: 11, color: "var(--n-ink-muted)" }}><Pill word="UNKNOWN" /> {what}: {msg}</div>;
}

// Monitor (docs/NEBULA.md §N6): one page that answers "are we OK, and how much
// room is left?" for prod and staging, so nobody has to sit on CloudWatch,
// Atlas and kubectl at once. Read-only; resizing is on /capacity.
export function MonitorView({ operator }: { operator: boolean }) {
  const [tier, setTier] = useState<Tier>("production");
  const [win, setWin] = useState<Win>("1h");
  const q = trpc.monitor.snapshot.useQuery({ tier, window: win }, { refetchInterval: REFRESH_MS, retry: false, placeholderData: (prev) => (prev?.tier === tier ? prev : undefined) });
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 5_000);
    return () => clearInterval(t);
  }, []);
  const d = q.data;
  const age = d ? Math.round((Date.now() - Date.parse(d.at)) / 1000) : null;

  return (
    <div style={{ padding: 28, maxWidth: 1500 }}>
      <PageHeader title="Monitor" kicker="traffic, CPU / memory, pods, node headroom and the database — live, one page · read-only">
        <span style={{ fontSize: 11, color: "var(--n-ink-muted)" }}>
          {q.isFetching ? "refreshing…" : age !== null ? `updated ${age}s ago · every 60 s` : ""}
        </span>
      </PageHeader>

      <nav style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
        {(["production", "staging"] as Tier[]).map((t) => (
          <Button key={t} variant={t === tier ? "ion" : "quiet"} onClick={() => setTier(t)}>{TIER_LABEL[t]}</Button>
        ))}
        <span style={{ width: 16 }} />
        {WINDOWS.map((w) => (
          <Button key={w} variant={w === win ? "ion" : "quiet"} onClick={() => setWin(w)}>{w}</Button>
        ))}
        <span style={{ flex: 1 }} />
        {d && <span style={{ fontSize: 11, color: "var(--n-ink-muted)" }}>{d.cluster}</span>}
        <Link href="/capacity" style={{ fontSize: 12, color: "var(--n-ion-soft)", textDecoration: "none" }} title={operator ? "resize pods, nodes and Atlas (gated)" : "operators resize; you can view the plan"}>
          Scale on /capacity →
        </Link>
      </nav>

      {q.error && <div className="n-plate" style={{ padding: 12, marginBottom: 12 }}><Pill word="FAIL" /> <span style={{ marginLeft: 8, color: "var(--n-fail)" }}>{q.error.message}</span></div>}
      {!d && q.isLoading && <div style={{ color: "var(--n-ink-muted)" }}>reading CloudWatch, Atlas and the cluster…</div>}

      {d && (
        <>
          <div style={{ ...grid(190), marginBottom: 16 }}>
            {d.signals.map((s) => (
              <div key={s.key} className="n-plate" style={{ padding: "10px 12px", minWidth: 0 }} title={s.detail}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                  <span style={label}>{s.label}</span>
                  <Pill word={s.word} />
                </div>
                <div style={{ fontSize: 18, marginTop: 6 }}>{s.value}</div>
                {s.detail && <div style={{ fontSize: 10, color: "var(--n-ink-muted)", marginTop: 3, lineHeight: 1.5, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{s.detail}</div>}
              </div>
            ))}
          </div>

          <div style={{ ...grid(420), alignItems: "start" }}>
            <TrafficPane d={d} />
            <ComputePane d={d} />
            <WorkloadsPane d={d} />
            <DbPane d={d} />
          </div>
          <p style={{ fontSize: 10, color: "var(--n-ink-faint)", marginTop: 14, lineHeight: 1.6 }}>
            Sources: load balancer + Container Insights (CloudWatch, 1-min data, ~1–2 min behind), Atlas measurements on each primary, live pod / node-group state from the cluster API. One snapshot per tier and window is shared by all viewers for 30 s.
          </p>
        </>
      )}
    </div>
  );
}

function TrafficPane({ d }: { d: Snap }) {
  if ("error" in d.traffic) return <Section title="Traffic"><Err what="load balancer" msg={d.traffic.error} /></Section>;
  const t = d.traffic.ok;
  return (
    <Section title="Traffic" right={<span style={{ fontSize: 11, color: "var(--n-ink-muted)" }}>{t.source}</span>}>
      <div style={grid(170)}>
        <Metric name="requests / s" value={fmt(lastV(t.rps))} s={t.rps} />
        {t.latency ? (
          <Metric name="latency p95" value={fmt((lastV(t.p95) ?? NaN) * 1000, 0, " ms")} s={t.p95} color="var(--n-pending)" hint={`p50 ${fmt((lastV(t.p50) ?? NaN) * 1000, 0, " ms")}`} />
        ) : (
          <div style={{ fontSize: 11, color: "var(--n-ink-faint)", alignSelf: "center" }}>no request latency: this load balancer is a TCP pass-through</div>
        )}
        <Metric name="5xx %" value={fmt(lastV(t.errPct), 2, "%")} s={t.errPct} color="var(--n-fail)" />
      </div>
      {t.byService.length > 0 && (
        <table style={{ width: "100%", fontSize: 12, marginTop: 12, borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ ...label, textAlign: "left" }}>
              <th style={{ fontWeight: 400, padding: "4px 0" }}>service</th>
              <th style={{ fontWeight: 400 }}>rps</th>
              <th style={{ fontWeight: 400 }}>p95</th>
              <th style={{ fontWeight: 400 }}>5xx</th>
              <th style={{ fontWeight: 400, width: "35%" }} />
            </tr>
          </thead>
          <tbody>
            {t.byService.map((s) => (
              <tr key={s.name} style={{ borderTop: "1px solid var(--n-hairline)" }}>
                <td style={{ padding: "4px 0" }}>{s.name}</td>
                <td>{fmt(lastV(s.rps))}</td>
                <td>{fmt((lastV(s.p95) ?? NaN) * 1000, 0, " ms")}</td>
                <td>{fmt(s.err5xx.reduce((a, p) => a + p[1], 0), 0)}</td>
                <td><Spark s={s.rps} height={20} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

function ComputePane({ d }: { d: Snap }) {
  return (
    <Section title="Compute" right={"ok" in d.live ? <span style={{ fontSize: 11, color: "var(--n-ink-muted)" }}>{d.live.ok.vcpu} vCPU on nodes</span> : undefined}>
      {"error" in d.ci ? (
        <Err what="Container Insights" msg={d.ci.error} />
      ) : (
        <div style={grid(170)}>
          <Metric name="node CPU avg" value={fmt(lastV(d.ci.ok.nodes.cpu), 0, "%")} s={d.ci.ok.nodes.cpu} max={100} hint={`hottest node ${fmt(lastV(d.ci.ok.nodes.cpuMax), 0, "%")}`} />
          <Metric name="node memory avg" value={fmt(lastV(d.ci.ok.nodes.mem), 0, "%")} s={d.ci.ok.nodes.mem} max={100} color="var(--n-pass)" hint={`fullest node ${fmt(lastV(d.ci.ok.nodes.memMax), 0, "%")}`} />
          <Metric name="nodes" value={fmt(lastV(d.ci.ok.nodes.count), 0)} s={d.ci.ok.nodes.count} color="var(--n-ink-muted)" />
        </div>
      )}
      <div style={{ ...label, margin: "14px 0 6px" }}>node groups · min / desired / max</div>
      {"error" in d.live ? (
        <Err what="cluster" msg={d.live.error} />
      ) : (
        d.live.ok.nodegroups.map((g) => {
          const full = g.desired >= g.max;
          return (
            <div key={g.name} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, padding: "3px 0" }}>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }} title={g.name}>{g.name.replace(/^eks-/, "")}</span>
              <span>{g.min} / <b>{g.desired}</b> / {g.max}</span>
              <span style={{ color: "var(--n-ink-faint)", fontSize: 11 }}>{g.instanceTypes.join(",")}</span>
              <Pill word={full ? "WATCH" : "OK"} title={full ? "desired = max: no room to add nodes — raise max on /capacity" : "room to scale out"} />
            </div>
          );
        })
      )}
    </Section>
  );
}

function WorkloadsPane({ d }: { d: Snap }) {
  const live = "ok" in d.live ? d.live.ok.workloads : [];
  const ci = "ok" in d.ci ? d.ci.ok.workloads : [];
  const names = [...new Set([...live.map((w) => `${w.namespace}/${w.name}`), ...ci.map((w) => `${w.namespace}/${w.name}`)])];
  return (
    <Section title="Workloads" right={<span style={{ fontSize: 11, color: "var(--n-ink-muted)" }}>ns default · jobs</span>}>
      {"error" in d.ci && <Err what="Container Insights" msg={d.ci.error} />}
      <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ ...label, textAlign: "left" }}>
            <th style={{ fontWeight: 400, padding: "4px 0" }}>deployment</th>
            <th style={{ fontWeight: 400 }} title="ready / desired, from the cluster now">pods</th>
            <th style={{ fontWeight: 400 }} title="total CPU used across pods (cores)">cpu</th>
            <th style={{ fontWeight: 400 }} title="busiest pod (cores)">hot pod</th>
            <th style={{ fontWeight: 400 }} title="total working-set memory">mem</th>
            <th style={{ fontWeight: 400, width: "26%" }}>cpu trend</th>
          </tr>
        </thead>
        <tbody>
          {names.map((key) => {
            const [ns, name] = key.split("/");
            const l = live.find((w) => w.namespace === ns && w.name === name);
            const m = ci.find((w) => w.namespace === ns && w.name === name);
            if (l && l.replicas === 0 && !lastV(m?.cpuCores)) return null;
            const short = l && l.ready < l.replicas;
            return (
              <tr key={key} style={{ borderTop: "1px solid var(--n-hairline)" }}>
                <td style={{ padding: "4px 0", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={key}>{name.replace(/-deployment$/, "")}</td>
                <td style={{ color: short ? "var(--n-pending)" : undefined, whiteSpace: "nowrap" }}>{l ? `${l.ready}/${l.replicas}` : fmt(lastV(m?.pods), 0)}{l?.hpa ? <span style={{ color: "var(--n-ink-faint)" }}> HPA {l.hpa.min}–{l.hpa.max}</span> : null}</td>
                <td>{fmt(lastV(m?.cpuCores), 2)}</td>
                <td>{fmt(lastV(m?.cpuMaxPodCores), 2)}</td>
                <td style={{ whiteSpace: "nowrap" }}>{fmt(lastV(m?.memGi), 1, " Gi")}</td>
                <td><Spark s={m?.cpuCores} height={20} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Section>
  );
}

function DbPane({ d }: { d: Snap }) {
  if ("error" in d.db) return <Section title="Database"><Err what="Atlas" msg={d.db.error} /></Section>;
  return (
    <Section title="Database" right={<span style={{ fontSize: 11, color: "var(--n-ink-muted)" }}>MongoDB Atlas · primary</span>}>
      {d.db.ok.map((c, i) => (
        <div key={c.cluster} style={{ paddingTop: i ? 12 : 0, marginTop: i ? 12 : 0, borderTop: i ? "1px solid var(--n-hairline)" : undefined }}>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline", marginBottom: 6, flexWrap: "wrap" }}>
            <span style={{ fontSize: 14 }}>{c.cluster}</span>
            <span style={{ fontSize: 12, color: "var(--n-ink-muted)" }}>{c.tier}{c.autoScaling ? ` · auto ${c.autoScaling.min}–${c.autoScaling.max}` : " · no auto-scaling"} · {c.state}</span>
            {c.note && <span style={{ fontSize: 11, color: "var(--n-ink-faint)" }}>({c.note})</span>}
          </div>
          {c.error ? (
            <Err what="measurements" msg={c.error} />
          ) : (
            <div style={grid(130)}>
              <Metric name="cpu" value={fmt(lastV(c.cpu), 0, "%")} s={c.cpu} max={100} />
              <Metric name="connections" value={`${fmt(lastV(c.conns), 0)}${c.connLimit ? ` / ${(c.connLimit / 1000).toFixed(0)}k` : ""}`} s={c.conns} color="var(--n-pending)" />
              <Metric name="ops / s" value={fmt(lastV(c.ops), 0)} s={c.ops} color="var(--n-pass)" />
              <Metric name="read · write ms" value={`${fmt(lastV(c.readMs), 1)} · ${fmt(lastV(c.writeMs), 1)}`} s={c.readMs} color="var(--n-ink-muted)" />
              <Metric name="memory" value={fmt(lastV(c.memPct), 0, "%")} s={c.memPct} max={100} color="var(--n-ink-muted)" />
              <Metric name="scanned / returned" value={fmt(lastV(c.targeting), 0)} s={c.targeting} color="var(--n-ink-muted)" hint="query targeting: high values mean collection scans (a missing index)" />
            </div>
          )}
        </div>
      ))}
    </Section>
  );
}
