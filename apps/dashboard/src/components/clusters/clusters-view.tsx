"use client";

import { useMemo, useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@/server/routers/_app";
import { trpc } from "@/lib/trpc-client";
import { Pill } from "@/components/nebula/pill";
import { Button } from "@/components/nebula/button";
import { Field, inputStyle, PageHeader } from "@/components/nebula/plate";
import type { StatusWord } from "@/lib/nebula/status";

type Overview = inferRouterOutputs<AppRouter>["clusters"]["overview"];
type Cluster = Overview["clusters"][number];
type ClusterName = Cluster["name"];

// Clusters = pods + logs across all three clusters (docs/NEBULA.md §N3.4).
// Non-prod is DEPLOYABLE; staging/QA and prod are OBSERVE ONLY — a structural
// fact (read-only IAM, no kube path), shown here as the pill on every panel.

export function ClustersView() {
  const overview = trpc.clusters.overview.useQuery(undefined, { refetchInterval: 60_000, retry: false });
  const [sel, setSel] = useState<{ cluster: ClusterName; namespace: string; pod?: string } | null>(null);

  return (
    <div style={{ padding: 28, maxWidth: 1400 }}>
      <PageHeader title="Clusters" kicker="pods + logs across all three clusters · observe-only for staging/QA and prod" />

      {overview.error && (
        <div className="n-plate" style={{ padding: 16, marginBottom: 18, borderColor: "color-mix(in oklab, var(--n-fail) 50%, transparent)" }}>
          <Pill word="FAIL" /> <span style={{ marginLeft: 8, color: "var(--n-fail)" }}>{overview.error.message}</span>
        </div>
      )}
      {overview.isLoading && (
        <div className="n-plate" style={{ padding: 24, color: "var(--n-ink-muted)", marginBottom: 18 }}>
          <Pill word="PENDING" /> <span style={{ marginLeft: 8 }}>querying Container Insights on three clusters (~10 s)…</span>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 16, marginBottom: 24 }}>
        {(overview.data?.clusters ?? []).map((c) => (
          <ClusterPanel key={c.name} cluster={c} selected={sel} onPick={(namespace, pod) => setSel({ cluster: c.name, namespace, pod })} />
        ))}
      </div>

      <LogsPanel clusters={overview.data?.clusters ?? []} selection={sel} onSelect={setSel} />
    </div>
  );
}

function ClusterPanel({ cluster: c, selected, onPick }: { cluster: Cluster; selected: { cluster: ClusterName; namespace: string; pod?: string } | null; onPick: (ns: string, pod?: string) => void }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const roleWord = c.role as StatusWord;
  return (
    <section className="n-plate" style={{ padding: 16, minWidth: 0 }}>
      <header style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, paddingBottom: 12, borderBottom: "1px solid var(--n-hairline)" }}>
        <div style={{ minWidth: 0 }}>
          <div className="n-display" style={{ fontSize: 20, lineHeight: 1.15 }}>{c.name}</div>
          <div style={{ color: "var(--n-ink-muted)", fontSize: 11, marginTop: 4 }}>{c.tier} · {c.note}</div>
        </div>
        <Pill word={roleWord} title={c.role === "DEPLOYABLE" ? "The only cluster Nebula deploys to" : "Read-only IAM; no kube-API path from Nebula"} />
      </header>

      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", padding: "10px 0", fontSize: 11, color: "var(--n-ink-muted)", borderBottom: "1px solid var(--n-hairline)" }}>
        {!c.reachable ? (
          <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }} title={c.reason}>
            <Pill word="UNKNOWN" /> not readable — {c.reason}
          </span>
        ) : (
          <>
            <span>{c.podCount} pods · {c.namespaces.length} namespaces</span>
            {Object.entries(c.counts).map(([w, n]) => (
              <span key={w} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                <Pill word={w as StatusWord} /> {n}
              </span>
            ))}
          </>
        )}
      </div>

      <div style={{ maxHeight: 420, overflowY: "auto" }}>
        {c.namespaces.map((ns) => {
          const isOpen = open[ns.namespace] ?? false;
          const nsCounts = ns.pods.reduce<Record<string, number>>((acc, p) => ({ ...acc, [p.word]: (acc[p.word] ?? 0) + 1 }), {});
          const active = selected?.cluster === c.name && selected.namespace === ns.namespace;
          return (
            <div key={ns.namespace} style={{ borderBottom: "1px solid var(--n-hairline)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 0" }}>
                <button
                  type="button"
                  onClick={() => setOpen((o) => ({ ...o, [ns.namespace]: !isOpen }))}
                  style={{ background: "none", border: "none", color: "var(--n-ink)", fontFamily: "inherit", fontSize: 12, cursor: "pointer", padding: 0, textAlign: "left", flex: 1, minWidth: 0 }}
                  title={isOpen ? "collapse" : "expand pods"}
                >
                  <span style={{ color: "var(--n-ink-faint)", marginRight: 6 }}>{isOpen ? "▾" : "▸"}</span>
                  {ns.namespace}
                  <span style={{ color: "var(--n-ink-faint)", marginLeft: 8, fontSize: 10 }}>{ns.pods.length}</span>
                </button>
                {Object.entries(nsCounts).map(([w, n]) => (
                  <span key={w} style={{ display: "inline-flex", gap: 4, alignItems: "center", fontSize: 10, color: "var(--n-ink-muted)" }}>
                    <Pill word={w as StatusWord} /> {n}
                  </span>
                ))}
                <Button onClick={() => onPick(ns.namespace)} style={{ padding: "3px 8px", fontSize: 9, borderColor: active ? "var(--n-ion)" : undefined }}>
                  logs
                </Button>
              </div>
              {isOpen &&
                ns.pods.map((p) => (
                  <div key={p.podName + p.containerName} style={{ display: "grid", gridTemplateColumns: "auto 1fr auto auto", gap: 8, alignItems: "center", padding: "4px 0 4px 18px", fontSize: 11, color: "var(--n-ink-muted)" }}>
                    <Pill word={p.word} title={p.detail} />
                    <span style={{ wordBreak: "break-all", color: "var(--n-ink)" }}>
                      {p.podName}
                      <span style={{ color: "var(--n-ink-faint)" }}> / {p.containerName}</span>
                    </span>
                    <span style={{ color: "var(--n-ink-faint)", fontSize: 10 }} title="restarts">{p.restarts > 0 ? `↻ ${p.restarts}` : ""}</span>
                    <button type="button" onClick={() => onPick(ns.namespace, p.podName)} style={{ background: "none", border: "none", color: "var(--n-ion-soft)", fontFamily: "inherit", fontSize: 10, cursor: "pointer" }}>
                      logs
                    </button>
                  </div>
                ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function LogsPanel({
  clusters,
  selection,
  onSelect,
}: {
  clusters: Cluster[];
  selection: { cluster: ClusterName; namespace: string; pod?: string } | null;
  onSelect: (s: { cluster: ClusterName; namespace: string; pod?: string }) => void;
}) {
  const [minutesBack, setMinutesBack] = useState(30);
  const [filter, setFilter] = useState("");
  const [applied, setApplied] = useState<{ cluster: ClusterName; namespace: string; pod?: string; minutesBack: number; filter: string } | null>(null);

  const cluster = clusters.find((c) => c.name === selection?.cluster);
  const namespaces = useMemo(() => cluster?.namespaces.map((n) => n.namespace) ?? [], [cluster]);
  const pods = useMemo(() => cluster?.namespaces.find((n) => n.namespace === selection?.namespace)?.pods.map((p) => p.podName) ?? [], [cluster, selection?.namespace]);

  const logs = trpc.clusters.logs.useQuery(
    applied ? { cluster: applied.cluster, namespace: applied.namespace, podName: applied.pod, minutesBack: applied.minutesBack, filter: applied.filter || undefined, limit: 300 } : { cluster: "EKS-Twizz-NonProd", namespace: "-" },
    { enabled: !!applied, retry: false, refetchOnWindowFocus: false },
  );

  const canRun = !!selection?.cluster && !!selection?.namespace;

  return (
    <section className="n-plate" style={{ padding: 16 }}>
      <header style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
        <div className="n-display" style={{ fontSize: 20 }}>Logs</div>
        <span style={{ fontSize: 11, color: "var(--n-ink-muted)" }}>CloudWatch Container Insights · /aws/containerinsights/&lt;cluster&gt;/application · one place for all three clusters</span>
      </header>

      <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1.4fr 0.7fr 1.2fr auto", gap: 10, alignItems: "end" }}>
        <Field label="cluster">
          <select value={selection?.cluster ?? ""} onChange={(e) => onSelect({ cluster: e.target.value as ClusterName, namespace: "" })} style={inputStyle}>
            <option value="" disabled>pick a cluster</option>
            {clusters.map((c) => (
              <option key={c.name} value={c.name}>{c.name} — {c.role}</option>
            ))}
          </select>
        </Field>
        <Field label="namespace">
          <select value={selection?.namespace ?? ""} onChange={(e) => selection && onSelect({ cluster: selection.cluster, namespace: e.target.value })} style={inputStyle} disabled={!selection?.cluster}>
            <option value="" disabled>{cluster ? "pick a namespace" : "—"}</option>
            {namespaces.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </Field>
        <Field label="pod (optional)">
          <select value={selection?.pod ?? ""} onChange={(e) => selection && onSelect({ ...selection, pod: e.target.value || undefined })} style={inputStyle} disabled={!selection?.namespace}>
            <option value="">all pods in namespace</option>
            {pods.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </Field>
        <Field label="window">
          <select value={minutesBack} onChange={(e) => setMinutesBack(Number(e.target.value))} style={inputStyle}>
            <option value={15}>15 min</option>
            <option value={30}>30 min</option>
            <option value={60}>1 h</option>
            <option value={180}>3 h</option>
            <option value={720}>12 h</option>
            <option value={1440}>24 h</option>
          </select>
        </Field>
        <Field label="filter (regex, optional)">
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="ERROR|timeout" style={inputStyle} />
        </Field>
        <div style={{ marginBottom: 14 }}>
          <Button variant="ion" disabled={!canRun} onClick={() => selection && setApplied({ cluster: selection.cluster, namespace: selection.namespace, pod: selection.pod, minutesBack, filter })}>
            Query
          </Button>
        </div>
      </div>

      <div style={{ fontSize: 11, color: "var(--n-ink-muted)", marginBottom: 8, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        {!applied && <span>pick a namespace (or a pod) above, then Query. Reading is the same for every cluster; writing exists only for non-prod, and only through the gate.</span>}
        {logs.isFetching && <span><Pill word="RUNNING" /> Logs Insights query in flight (up to ~20 s)…</span>}
        {logs.error && <span style={{ color: "var(--n-fail)" }}><Pill word="FAIL" /> {logs.error.message}</span>}
        {logs.data && !logs.isFetching && (
          <span>
            {logs.data.count} lines · {logs.data.cluster} / {logs.data.namespace}{applied?.pod ? ` / ${applied.pod}` : ""} · {new Date(logs.data.from).toLocaleTimeString()} → {new Date(logs.data.to).toLocaleTimeString()}
            {logs.data.count === 0 && <> — <Pill word="UNKNOWN" /> nothing matched (no pods logging, or the window/filter is too narrow)</>}
          </span>
        )}
      </div>

      {logs.data && logs.data.lines.length > 0 && (
        <pre
          style={{
            margin: 0,
            padding: 12,
            maxHeight: 520,
            overflow: "auto",
            fontSize: 11,
            lineHeight: 1.5,
            background: "var(--n-surface)",
            border: "1px solid var(--n-hairline)",
            borderRadius: "var(--n-radius)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {logs.data.lines.map((l, i) => (
            <div key={i}>
              <span style={{ color: "var(--n-ink-faint)" }}>{l.timestamp.replace("T", " ").slice(0, 23)}</span>{" "}
              <span style={{ color: "var(--n-ion-soft)" }}>{l.podName.replace(/-[a-z0-9]{5,10}(-[a-z0-9]{5})?$/, "")}</span>{" "}
              <span style={{ color: "var(--n-ink)" }}>{l.message}</span>
            </div>
          ))}
        </pre>
      )}
    </section>
  );
}
