"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { trpc } from "@/lib/trpc-client";
import { Pill } from "@/components/nebula/pill";
import { Button } from "@/components/nebula/button";
import { PageHeader } from "@/components/nebula/plate";
import type { StatusWord } from "@/lib/nebula/status";
import { decodeLogsState, encodeLogsState } from "@/lib/nebula/logs-url";
import { CLUSTER_NAMES } from "@/lib/nebula/clusters";
import { LogsPanel } from "./logs-panel";
import type { AppliedQuery, Cluster, ClusterName, Selection } from "./types";

// Clusters = pods + logs across all three clusters (docs/NEBULA.md §N3.4).
// Non-prod is DEPLOYABLE; staging/QA and prod are OBSERVE ONLY — a structural
// fact (read-only IAM, no kube path), shown here as the pill on every panel.
// The applied log query lives in the URL (?c=&ns=&pod=&w=&q=&err=) so a view
// can be shared; keystrokes never touch history, only the Query button does.

export function ClustersView() {
  return (
    <Suspense fallback={null}>
      <ClustersViewInner />
    </Suspense>
  );
}

function ClustersViewInner() {
  const overview = trpc.clusters.overview.useQuery(undefined, { refetchInterval: 60_000, retry: false });
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const initial = useMemo(() => decodeLogsState(params.toString(), CLUSTER_NAMES), [params]);
  const [sel, setSel] = useState<Selection | null>(() => (initial ? { cluster: initial.cluster as ClusterName, namespace: initial.namespace, pod: initial.pod } : null));
  const [applied, setApplied] = useState<AppliedQuery | null>(() => (initial ? { ...initial, cluster: initial.cluster as ClusterName } : null));
  const lastUrl = useRef<string>(params.toString());

  useEffect(() => {
    if (!applied) return;
    const next = encodeLogsState(applied);
    if (next === lastUrl.current) return;
    lastUrl.current = next;
    router.replace(`${pathname}?${next}`, { scroll: false });
  }, [applied, pathname, router]);

  return (
    <div style={{ padding: 28, maxWidth: 1600 }}>
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

      <LogsPanel clusters={overview.data?.clusters ?? []} selection={sel} onSelect={setSel} applied={applied} onApply={setApplied} initial={initial} />
    </div>
  );
}

function ClusterPanel({ cluster: c, selected, onPick }: { cluster: Cluster; selected: Selection | null; onPick: (ns: string, pod?: string) => void }) {
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
