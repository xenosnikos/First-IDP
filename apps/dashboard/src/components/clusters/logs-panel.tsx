"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { Pill } from "@/components/nebula/pill";
import { Button } from "@/components/nebula/button";
import { Field, inputStyle } from "@/components/nebula/plate";
import { WINDOW_OPTIONS, type LogsUrlState } from "@/lib/nebula/logs-url";
import { groupPodsByDeployment } from "@/lib/nebula/pods";
import { assignDisplayLevels, isErrorLevel, normalizeLine, podShort, type Level } from "@twizz-idp/observer/logs";
import { LogHistogram } from "./log-histogram";
import { ObserverPanel } from "./observer-panel";
import type { AppliedQuery, Cluster, ClusterName, LogLine, Selection } from "./types";

const LEVEL_COLOR: Record<Level, string> = {
  FATAL: "var(--n-fail)",
  ERROR: "var(--n-fail)",
  WARN: "var(--n-pending)",
  INFO: "var(--n-ink)",
  UNKNOWN: "var(--n-ink)",
  DEBUG: "var(--n-ink-faint)",
  VERBOSE: "var(--n-ink-faint)",
};

const dedupKey = (l: LogLine) => `${l.timestamp}|${l.podName}|${l.message}`;

export function LogsPanel({
  clusters,
  selection,
  onSelect,
  applied,
  onApply,
  initial,
}: {
  clusters: Cluster[];
  selection: Selection | null;
  onSelect: (s: Selection) => void;
  applied: AppliedQuery | null;
  onApply: (q: AppliedQuery) => void;
  initial: LogsUrlState | null;
}) {
  const [minutesBack, setMinutesBack] = useState(initial?.minutesBack ?? 30);
  const [filter, setFilter] = useState(initial?.filter ?? "");
  const [errorsOnly, setErrorsOnly] = useState(initial?.errorsOnly ?? false);
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
    <section className="n-plate" style={{ padding: 16 }}>
      <header style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
        <div className="n-display" style={{ fontSize: 20 }}>Logs</div>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 11, color: "var(--n-ink-muted)" }}>CloudWatch Container Insights · /aws/containerinsights/&lt;cluster&gt;/application · one place for all three clusters</span>
          <Button onClick={() => setObserverOpen((o) => !o)} style={{ borderColor: observerOpen ? "var(--n-ion)" : undefined }} title="Observer: read-only log assistant">
            {observerOpen ? "hide observer" : "observer"}
          </Button>
        </div>
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
            {selection?.namespace && !namespaces.includes(selection.namespace) && <option value={selection.namespace}>{selection.namespace}</option>}
          </select>
        </Field>
        <Field label="pod (optional)">
          <select value={selection?.pod ?? ""} onChange={(e) => selection && onSelect({ ...selection, pod: e.target.value || undefined })} style={inputStyle} disabled={!selection?.namespace}>
            <option value="">all pods in namespace</option>
            {podGroups.map((g) => (
              <optgroup key={g.deployment} label={g.deployment}>
                {g.pods.length > 1 && <option value={g.deployment}>all replicas of {g.deployment}</option>}
                {g.pods.map((p) => <option key={p.podName} value={p.podName}>{p.podName}</option>)}
              </optgroup>
            ))}
            {selection?.pod && !podGroups.some((g) => g.deployment === selection.pod || g.pods.some((p) => p.podName === selection.pod)) && <option value={selection.pod}>{selection.pod}</option>}
          </select>
        </Field>
        <Field label="window">
          <select value={minutesBack} onChange={(e) => setMinutesBack(Number(e.target.value))} style={inputStyle}>
            {WINDOW_OPTIONS.map((w) => (
              <option key={w} value={w}>{w < 60 ? `${w} min` : `${w / 60} h`}</option>
            ))}
          </select>
        </Field>
        <Field label="filter (regex on text or pod name)">
          <input value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => e.key === "Enter" && canRun && run()} placeholder="ERROR|timeout or email-service" style={inputStyle} />
        </Field>
        <div style={{ marginBottom: 14 }}>
          <Button variant="ion" disabled={!canRun} onClick={run}>
            Query
          </Button>
        </div>
      </div>

      <div style={{ fontSize: 11, color: "var(--n-ink-muted)", marginBottom: 8, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        {!applied && <span>pick a namespace (or a pod) above, then Query. Reading is the same for every cluster; writing exists only for non-prod, and only through the gate.</span>}
        {logs.isFetching && <span><Pill word="RUNNING" /> Logs Insights query in flight (up to ~22 s)…</span>}
        {logs.error && <span style={{ color: "var(--n-fail)" }}><Pill word="FAIL" /> {logs.error.message}</span>}
        {logs.data && !logs.isFetching && (
          <span>
            {allLines.length} lines{rows.length !== allLines.length ? ` (${rows.length} shown)` : ""} · {logs.data.cluster} / {logs.data.namespace}{applied?.pod ? ` / ${applied.pod}` : ""} · {logs.data.from.slice(11, 19)} → {logs.data.to.slice(11, 19)} UTC
            {logs.data.status === "timeout" && <> — <Pill word="UNKNOWN" /> Logs Insights timed out after ~22 s: narrow the window, pod or filter (this is not &quot;no logs&quot;)</>}
            {logs.data.status === "failed" && <> — <Pill word="FAIL" /> Logs Insights query failed</>}
            {logs.data.status === "complete" && logs.data.count === 0 && <> — <Pill word="UNKNOWN" /> nothing matched (no pods logging, or the window/filter is too narrow)</>}
          </span>
        )}
        <label style={{ display: "inline-flex", gap: 6, alignItems: "center", cursor: "pointer", marginLeft: "auto" }} title="Show ERROR/FATAL/WARN records and their stack frames from the loaded lines. For older errors, add ERROR to the filter.">
          <input type="checkbox" checked={errorsOnly} onChange={(e) => { setErrorsOnly(e.target.checked); if (applied) onApply({ ...applied, errorsOnly: e.target.checked }); }} />
          errors only
        </label>
      </div>

      {applied && <LogHistogram bins={histogram.data?.bins ?? []} binMinutes={15} status={histogram.data?.status} isFetching={histogram.isFetching} />}

      <div style={{ display: "grid", gridTemplateColumns: observerOpen ? "minmax(0, 1fr) 420px" : "1fr", gap: 12, alignItems: "start" }}>
        <div style={{ minWidth: 0 }}>
          {logs.data && (
            <div style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 11, color: "var(--n-ink-muted)", marginBottom: 6 }}>
              <Button disabled={!canLoadOlder} onClick={loadOlder} style={{ padding: "3px 8px", fontSize: 9 }} title="Re-query with to = oldest loaded line (newest 300 older lines)">
                load older
              </Button>
              {olderStatus === "loading" && <span><Pill word="RUNNING" /> loading older lines…</span>}
              {olderStatus === "timeout" && <span><Pill word="UNKNOWN" /> older page timed out</span>}
              {olderStatus === "failed" && <span><Pill word="FAIL" /> older page failed</span>}
              {olderStatus === "idle" && older.length > 0 && <span>reached the start of the window</span>}
              {logs.data.status === "complete" && logs.data.count < 300 && older.length === 0 && <span>all lines in the window loaded</span>}
              {selectionText && <span style={{ marginLeft: "auto" }}>selection: {selectionText.split("\n").length} lines</span>}
            </div>
          )}
          {rows.length > 0 && (
            <pre
              ref={preRef}
              onMouseUp={captureSelection}
              style={{
                margin: 0,
                padding: 12,
                maxHeight: 560,
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
          )}
        </div>
        {observerOpen && <ObserverPanel scope={scope} selection={selectionText} />}
      </div>
    </section>
  );
}
