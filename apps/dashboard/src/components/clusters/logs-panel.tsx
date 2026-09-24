"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { trpc } from "@/lib/trpc-client";
import { Pill } from "@/components/nebula/pill";
import { Button } from "@/components/nebula/button";
import { inputStyle } from "@/components/nebula/plate";
import { WINDOW_OPTIONS, type LogsUrlState } from "@/lib/nebula/logs-url";
import { groupPodsByDeployment } from "@/lib/nebula/pods";
import { assignDisplayLevels, isErrorLevel, normalizeLine, podShort, type Level } from "@twizz-idp/observer/logs";
import { LogHistogram } from "./log-histogram";
import { ObserverPanel } from "./observer-panel";
import type { AppliedQuery, Cluster, ClusterName, LogLine, Selection } from "./types";

// The log workspace. It fills whatever height it is given (the parent is a
// column flex box the height of <main>) and never scrolls as a whole:
//   query bar (one row)        — fixed
//   status + histogram         — fixed
//   log text                   — the ONE scroller, takes the rest
//   Observer drawer (optional) — full height on the right, its own scroller
// So the query is always reachable, the log always has the room, and the
// Observer never steals height from the text it talks about.

const LEVEL_COLOR: Record<Level, string> = {
  FATAL: "var(--n-fail)",
  ERROR: "var(--n-fail)",
  WARN: "var(--n-pending)",
  INFO: "var(--n-ink)",
  UNKNOWN: "var(--n-ink)",
  DEBUG: "var(--n-ink-faint)",
  VERBOSE: "var(--n-ink-faint)",
};

const OBSERVER_WIDTH = 440;

const dedupKey = (l: LogLine) => `${l.timestamp}|${l.podName}|${l.message}`;

const compactInput: CSSProperties = { ...inputStyle, padding: "6px 8px", fontSize: 11 };

/** A labelled control for the one-row query bar (no bottom margin, unlike <Field>). */
function Ctl({ label, children, style }: { label: string; children: ReactNode; style?: CSSProperties }) {
  return (
    <label style={{ display: "block", minWidth: 0, ...style }}>
      <div className="n-label" style={{ marginBottom: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</div>
      {children}
    </label>
  );
}

export function LogsPanel({
  clusters,
  clustersLoading,
  selection,
  onSelect,
  applied,
  onApply,
  initial,
}: {
  clusters: Cluster[];
  clustersLoading: boolean;
  selection: Selection | null;
  onSelect: (s: Selection) => void;
  applied: AppliedQuery | null;
  onApply: (q: AppliedQuery) => void;
  initial: LogsUrlState | null;
}) {
  // The draft (what the bar shows) follows the applied query whenever one is
  // applied from outside — e.g. "logs" on the overview — so the bar never lies.
  const [minutesBack, setMinutesBack] = useState(applied?.minutesBack ?? initial?.minutesBack ?? 30);
  const [filter, setFilter] = useState(applied?.filter ?? initial?.filter ?? "");
  const [errorsOnly, setErrorsOnly] = useState(applied?.errorsOnly ?? initial?.errorsOnly ?? false);
  useEffect(() => {
    if (!applied) return;
    setMinutesBack(applied.minutesBack);
    setFilter(applied.filter);
    setErrorsOnly(applied.errorsOnly);
  }, [applied]);

  const [observerOpen, setObserverOpen] = useState(false);
  const [selectionText, setSelectionText] = useState("");
  const preRef = useRef<HTMLPreElement>(null);

  const cluster = clusters.find((c) => c.name === selection?.cluster);
  const namespaces = useMemo(() => cluster?.namespaces.map((n) => n.namespace) ?? [], [cluster]);
  const podGroups = useMemo(() => groupPodsByDeployment(cluster?.namespaces.find((n) => n.namespace === selection?.namespace)?.pods ?? []), [cluster, selection?.namespace]);

  const queryInput = applied
    ? { cluster: applied.cluster, namespace: applied.namespace, podName: applied.pod, minutesBack: applied.minutesBack, filter: applied.filter || undefined }
    : { cluster: "EKS-Twizz-NonProd" as ClusterName, namespace: "-" };
  const logs = trpc.clusters.logs.useQuery({ ...queryInput, limit: 300 }, { enabled: !!applied, retry: false, refetchOnWindowFocus: false });
  const histogram = trpc.clusters.logHistogram.useQuery({ ...queryInput, binMinutes: 15 }, { enabled: !!applied, retry: false, refetchOnWindowFocus: false });
  const utils = trpc.useUtils();

  // Loaded lines = newest query result + older pages appended by "load older".
  const [older, setOlder] = useState<LogLine[]>([]);
  const [olderStatus, setOlderStatus] = useState<"idle" | "loading" | "done" | "timeout" | "failed">("idle");
  useEffect(() => {
    setOlder([]);
    setOlderStatus("idle");
  }, [logs.data?.from, logs.data?.to, applied]);

  const allLines = useMemo(() => {
    const seen = new Set<string>();
    const out: LogLine[] = [];
    for (const l of [...older, ...(logs.data?.lines ?? [])]) {
      const k = dedupKey(l);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(l);
    }
    return out;
  }, [older, logs.data?.lines]);

  const rows = useMemo(() => {
    const norm = assignDisplayLevels(allLines.map(normalizeLine));
    return norm.map((n, i) => ({ n, raw: allLines[i] })).filter(({ n }) => !errorsOnly || isErrorLevel(n.effectiveLevel) || n.effectiveLevel === "WARN");
  }, [allLines, errorsOnly]);

  const oldest = allLines[0]?.timestamp;
  const canLoadOlder = !!applied && !!logs.data && logs.data.status === "complete" && (older.length > 0 ? olderStatus === "done" : logs.data.count >= 300) && olderStatus !== "loading";

  const loadOlder = useCallback(async () => {
    if (!applied || !logs.data || !oldest) return;
    setOlderStatus("loading");
    try {
      const page = await utils.clusters.logs.fetch({ ...queryInput, from: logs.data.from, to: oldest, limit: 300 });
      setOlder((o) => [...page.lines, ...o]);
      setOlderStatus(page.status === "complete" ? (page.count >= 300 ? "done" : "idle") : page.status);
      if (page.status === "complete" && page.count < 300) setOlderStatus("idle");
    } catch {
      setOlderStatus("failed");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applied, logs.data, oldest, utils]);

  const canRun = !!selection?.cluster && !!selection?.namespace;
  const run = () => selection && onApply({ cluster: selection.cluster, namespace: selection.namespace, pod: selection.pod, minutesBack, filter: filter.trim(), errorsOnly });

  const captureSelection = () => {
    const s = window.getSelection()?.toString() ?? "";
    if (s.trim().length > 0 && preRef.current?.contains(window.getSelection()?.anchorNode ?? null)) setSelectionText(s.slice(0, 20_000));
  };

  const scope = applied && logs.data ? { cluster: applied.cluster, namespace: applied.namespace, pod: applied.pod, from: logs.data.from, to: logs.data.to } : null;

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", minWidth: 0 }}>
      {/* ── left: the log column ─────────────────────────────────────── */}
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {/* query bar — one row, always in view */}
        <div style={{ flexShrink: 0, padding: "12px 20px 10px", borderBottom: "1px solid var(--n-hairline)" }}>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(150px, 1.1fr) minmax(120px, 1fr) minmax(160px, 1.4fr) 88px minmax(160px, 1.3fr) auto auto", gap: 10, alignItems: "end" }}>
            <Ctl label="cluster">
              <select value={selection?.cluster ?? ""} onChange={(e) => onSelect({ cluster: e.target.value as ClusterName, namespace: "" })} style={compactInput}>
                <option value="" disabled>{clustersLoading ? "loading clusters…" : "pick a cluster"}</option>
                {clusters.map((c) => (
                  <option key={c.name} value={c.name}>{c.name} — {c.role}</option>
                ))}
                {selection?.cluster && !clusters.some((c) => c.name === selection.cluster) && <option value={selection.cluster}>{selection.cluster}</option>}
              </select>
            </Ctl>
            <Ctl label="namespace">
              <select value={selection?.namespace ?? ""} onChange={(e) => selection && onSelect({ cluster: selection.cluster, namespace: e.target.value })} style={compactInput} disabled={!selection?.cluster}>
                <option value="" disabled>{cluster ? "pick a namespace" : "—"}</option>
                {namespaces.map((n) => <option key={n} value={n}>{n}</option>)}
                {selection?.namespace && !namespaces.includes(selection.namespace) && <option value={selection.namespace}>{selection.namespace}</option>}
              </select>
            </Ctl>
            <Ctl label="pod (optional)">
              <select value={selection?.pod ?? ""} onChange={(e) => selection && onSelect({ ...selection, pod: e.target.value || undefined })} style={compactInput} disabled={!selection?.namespace}>
                <option value="">all pods in namespace</option>
                {podGroups.map((g) => (
                  <optgroup key={g.deployment} label={g.deployment}>
                    {g.pods.length > 1 && <option value={g.deployment}>all replicas of {g.deployment}</option>}
                    {g.pods.map((p) => <option key={p.podName} value={p.podName}>{p.podName}</option>)}
                  </optgroup>
                ))}
                {selection?.pod && !podGroups.some((g) => g.deployment === selection.pod || g.pods.some((p) => p.podName === selection.pod)) && <option value={selection.pod}>{selection.pod}</option>}
              </select>
            </Ctl>
            <Ctl label="window">
              <select value={minutesBack} onChange={(e) => setMinutesBack(Number(e.target.value))} style={compactInput}>
                {WINDOW_OPTIONS.map((w) => (
                  <option key={w} value={w}>{w < 60 ? `${w} min` : `${w / 60} h`}</option>
                ))}
              </select>
            </Ctl>
            <Ctl label="filter (regex on text or pod)">
              <input value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => e.key === "Enter" && canRun && run()} placeholder="ERROR|timeout or email-service" style={compactInput} />
            </Ctl>
            <Button variant="ion" disabled={!canRun} onClick={run} style={{ padding: "7px 14px" }}>
              Query
            </Button>
            <Button onClick={() => setObserverOpen((o) => !o)} style={{ padding: "7px 12px", borderColor: observerOpen ? "var(--n-ion)" : undefined }} title="Observer: read-only log assistant (full-height drawer)">
              {observerOpen ? "observer ▸" : "◂ observer"}
            </Button>
          </div>
        </div>

        {/* status line + histogram — fixed */}
        <div style={{ flexShrink: 0, padding: "8px 20px 0", fontSize: 11, color: "var(--n-ink-muted)" }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", minHeight: 22 }}>
            {!applied && <span>pick a namespace (or a pod), then Query. Reading is the same for every cluster; writing exists only for non-prod, and only through the gate.</span>}
            {logs.isFetching && <span><Pill word="RUNNING" /> Logs Insights query in flight (up to ~22 s)…</span>}
            {logs.error && <span style={{ color: "var(--n-fail)" }}><Pill word="FAIL" /> {logs.error.message}</span>}
            {logs.data && !logs.isFetching && (
              <span>
                {allLines.length} lines{rows.length !== allLines.length ? ` (${rows.length} shown)` : ""} · {logs.data.from.slice(11, 19)} → {logs.data.to.slice(11, 19)} UTC
                {logs.data.status === "timeout" && <> — <Pill word="UNKNOWN" /> Logs Insights timed out after ~22 s: narrow the window, pod or filter (this is not &quot;no logs&quot;)</>}
                {logs.data.status === "failed" && <> — <Pill word="FAIL" /> Logs Insights query failed</>}
                {logs.data.status === "complete" && logs.data.count === 0 && <> — <Pill word="UNKNOWN" /> nothing matched (no pods logging, or the window/filter is too narrow)</>}
              </span>
            )}
            {logs.data && (
              <>
                <Button disabled={!canLoadOlder} onClick={loadOlder} style={{ padding: "3px 8px", fontSize: 9 }} title="Re-query with to = oldest loaded line (newest 300 older lines)">
                  load older
                </Button>
                {olderStatus === "loading" && <span><Pill word="RUNNING" /> loading older lines…</span>}
                {olderStatus === "timeout" && <span><Pill word="UNKNOWN" /> older page timed out</span>}
                {olderStatus === "failed" && <span><Pill word="FAIL" /> older page failed</span>}
                {olderStatus === "idle" && older.length > 0 && <span>reached the start of the window</span>}
                {logs.data.status === "complete" && logs.data.count < 300 && older.length === 0 && <span>all lines in the window loaded</span>}
              </>
            )}
            <span style={{ marginLeft: "auto", display: "inline-flex", gap: 14, alignItems: "center" }}>
              {selectionText && <span title="what “Explain this trace” will send to the Observer">selection: {selectionText.split("\n").length} lines</span>}
              <label style={{ display: "inline-flex", gap: 6, alignItems: "center", cursor: "pointer" }} title="Show ERROR/FATAL/WARN records and their stack frames from the loaded lines. For older errors, add ERROR to the filter.">
                <input type="checkbox" checked={errorsOnly} onChange={(e) => { setErrorsOnly(e.target.checked); if (applied) onApply({ ...applied, errorsOnly: e.target.checked }); }} />
                errors only
              </label>
            </span>
          </div>
          {applied && <LogHistogram bins={histogram.data?.bins ?? []} binMinutes={15} status={histogram.data?.status} isFetching={histogram.isFetching} />}
        </div>

        {/* the log text — the one scroller, takes all remaining height */}
        <div style={{ flex: 1, minHeight: 0, padding: "8px 20px 16px", display: "flex" }}>
          <pre
            ref={preRef}
            onMouseUp={captureSelection}
            style={{
              flex: 1,
              minWidth: 0,
              minHeight: 0,
              margin: 0,
              padding: 12,
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
            {rows.length === 0 && (
              <span style={{ color: "var(--n-ink-faint)" }}>
                {!applied ? "no query applied" : logs.isFetching ? "…" : logs.data ? (errorsOnly && allLines.length > 0 ? "no ERROR/WARN lines among the loaded lines — untick “errors only” or add ERROR to the filter" : "no lines") : ""}
              </span>
            )}
            {rows.map(({ n, raw }, i) => (
              <div key={i} style={{ paddingLeft: n.continuation ? 18 : 0 }}>
                {!n.continuation && (
                  <>
                    <span style={{ color: "var(--n-ink-faint)" }}>{raw.timestamp.replace("T", " ").slice(0, 23)}</span>{" "}
                    <span style={{ color: "var(--n-ion-soft)" }}>{podShort(raw.podName)}</span>{" "}
                    {n.level !== "UNKNOWN" && <span style={{ color: LEVEL_COLOR[n.level], fontSize: 9, letterSpacing: "0.08em" }}>{n.level}</span>}{n.level !== "UNKNOWN" ? " " : ""}
                    {n.context && <span style={{ color: "var(--n-ink-faint)" }}>[{n.context}] </span>}
                  </>
                )}
                <span style={{ color: LEVEL_COLOR[n.effectiveLevel] }}>{n.continuation ? n.display : n.text}</span>
              </div>
            ))}
          </pre>
        </div>
      </div>

      {/* ── right: the Observer drawer, full height ───────────────────── */}
      {observerOpen && (
        <div style={{ width: OBSERVER_WIDTH, flexShrink: 0, minHeight: 0, borderLeft: "1px solid var(--n-hairline)", display: "flex" }}>
          <ObserverPanel scope={scope} selection={selectionText} onClose={() => setObserverOpen(false)} />
        </div>
      )}
    </div>
  );
}
