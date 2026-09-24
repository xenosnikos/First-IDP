"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
//
// Two views on one route:
//   overview — the three cluster plates (page scrolls as usual)
//   logs     — a full-height workspace: breadcrumb › query bar › log viewer;
//              the only scroller is the log text itself (plus the Observer
//              drawer's own transcript). Clicking "logs" anywhere on the
//              overview applies a query straight away and opens this view.
// The applied log query lives in the URL (?c=&ns=&pod=&w=&q=&err=) so a view
// can be shared; keystrokes never touch history, only the Query button does.

export function ClustersView() {
  return (
    <Suspense fallback={null}>
      <ClustersViewInner />
    </Suspense>
  );
}

type View = "overview" | "logs";

function ClustersViewInner() {
  const overview = trpc.clusters.overview.useQuery(undefined, { refetchInterval: 60_000, retry: false });
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const initial = useMemo(() => decodeLogsState(params.toString(), CLUSTER_NAMES), [params]);
  const [sel, setSel] = useState<Selection | null>(() => (initial ? { cluster: initial.cluster as ClusterName, namespace: initial.namespace, pod: initial.pod } : null));
  const [applied, setApplied] = useState<AppliedQuery | null>(() => (initial ? { ...initial, cluster: initial.cluster as ClusterName } : null));
  const [view, setView] = useState<View>(() => (initial ? "logs" : "overview"));
  const lastUrl = useRef<string>(params.toString());

  useEffect(() => {
    if (!applied) return;
    const next = encodeLogsState(applied);
    if (next === lastUrl.current) return;
    lastUrl.current = next;
    router.replace(`${pathname}?${next}`, { scroll: false });
  }, [applied, pathname, router]);

  // "logs" on a namespace or pod: select it, run it with the current window /
  // filter (or the defaults), and go straight to the workspace. No scrolling.
  const openLogs = useCallback(
    (cluster: ClusterName, namespace: string, pod?: string) => {
      const s: Selection = { cluster, namespace, pod };
      setSel(s);
      setApplied({ ...s, minutesBack: applied?.minutesBack ?? 30, filter: applied?.filter ?? "", errorsOnly: applied?.errorsOnly ?? false });
      setView("logs");
    },
    [applied],
  );

  const clusters = overview.data?.clusters ?? [];

  if (view === "logs") {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden" }}>
        <Breadcrumb selection={sel} onBack={() => setView("overview")} />
        <LogsPanel clusters={clusters} clustersLoading={overview.isLoading} selection={sel} onSelect={setSel} applied={applied} onApply={setApplied} initial={initial} />
      </div>
    );
  }

  return (
    <div style={{ padding: 28, maxWidth: 1600 }}>
      <PageHeader title="Clusters" kicker="pods + logs across all three clusters · observe-only for staging/QA and prod">
        <Button
          variant={applied ? "ion" : "quiet"}
          onClick={() => setView("logs")}
          title={applied ? `back to the applied query: ${applied.cluster} / ${applied.namespace}${applied.pod ? ` / ${applied.pod}` : ""}` : "open the log workspace and compose a query"}
        >
          {applied ? "logs ›" : "query logs ›"}
        </Button>
      </PageHeader>

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

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 16 }}>
        {clusters.map((c) => (
          <ClusterPanel key={c.name} cluster={c} selected={sel} onPick={(namespace, pod) => openLogs(c.name, namespace, pod)} />
        ))}
      </div>
    </div>
  );
}

/** Clusters › cluster › namespace › pod — the way back is the first crumb. */
function Breadcrumb({ selection, onBack }: { selection: Selection | null; onBack: () => void }) {
  const crumbs = [selection?.cluster, selection?.namespace, selection?.pod].filter((c): c is string => !!c);
  return (
    <nav aria-label="breadcrumb" style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 8, padding: "12px 20px", borderBottom: "1px solid var(--n-hairline)", fontSize: 12, minWidth: 0 }}>
      <button
        type="button"
        onClick={onBack}
        title="back to the cluster overview (the applied query is kept)"
        style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit", fontSize: 12, color: "var(--n-ion-soft)", display: "inline-flex", alignItems: "center", gap: 6 }}
      >
        <span aria-hidden>‹</span> Clusters
      </button>
      {crumbs.length === 0 && (
        <>
          <span style={{ color: "var(--n-ink-faint)" }}>/</span>
          <span style={{ color: "var(--n-ink-muted)" }}>logs</span>
        </>
      )}
      {crumbs.map((c, i) => (
        <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span style={{ color: "var(--n-ink-faint)" }}>/</span>
          <span style={{ color: i === crumbs.length - 1 ? "var(--n-ink)" : "var(--n-ink-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c}</span>
        </span>
      ))}
    </nav>
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
                <Button onClick={() => onPick(ns.namespace)} style={{ padding: "3px 8px", fontSize: 9, borderColor: active ? "var(--n-ion)" : undefined }} title="query the last 30 min of this namespace">
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
                    <button type="button" onClick={() => onPick(ns.namespace, p.podName)} style={{ background: "none", border: "none", color: "var(--n-ion-soft)", fontFamily: "inherit", fontSize: 10, cursor: "pointer" }} title="query the last 30 min of this pod">
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
