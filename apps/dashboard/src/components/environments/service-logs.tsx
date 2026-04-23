"use client";

import { useState, useRef, useEffect } from "react";
import { trpc } from "@/lib/trpc-client";

type Pod = { podName: string; containerName: string };

const TIME_RANGES = [
  { label: "15m", seconds: 15 * 60 },
  { label: "1h", seconds: 60 * 60 },
  { label: "6h", seconds: 6 * 60 * 60 },
  { label: "24h", seconds: 24 * 60 * 60 },
];

export function ServiceLogViewer({
  clusterName,
  namespace,
  pods,
}: {
  clusterName: string;
  namespace: string;
  pods: Pod[];
}) {
  const [selectedPod, setSelectedPod] = useState<string>("");
  const [timeRange, setTimeRange] = useState(TIME_RANGES[0].seconds);
  const [search, setSearch] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const now = Math.floor(Date.now() / 1000);

  const logs = trpc.logs.getPodLogs.useQuery(
    {
      clusterName,
      namespace,
      podName: selectedPod || undefined,
      startTime: now - timeRange,
      endTime: now,
      filterPattern: search || undefined,
      limit: 500,
    },
    {
      enabled: !!clusterName && !!namespace,
      refetchInterval: autoRefresh ? 10_000 : false,
    },
  );

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs.data]);

  return (
    <div className="rounded-lg border border-border overflow-hidden flex flex-col">
      {/* Controls */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-border bg-card flex-wrap">
        {/* Pod selector */}
        <select
          value={selectedPod}
          onChange={(e) => setSelectedPod(e.target.value)}
          className="rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary"
        >
          <option value="">All pods</option>
          {pods.map((p) => (
            <option key={p.podName} value={p.podName}>
              {p.podName}
            </option>
          ))}
        </select>

        {/* Time range */}
        <div className="flex gap-1">
          {TIME_RANGES.map((tr) => (
            <button
              key={tr.seconds}
              onClick={() => setTimeRange(tr.seconds)}
              className={`px-2 py-1 text-xs rounded-md border transition-colors ${
                timeRange === tr.seconds
                  ? "border-primary/30 bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              {tr.label}
            </button>
          ))}
        </div>

        {/* Search */}
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search logs..."
          className="flex-1 min-w-[120px] rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-mono placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary"
        />

        {/* Auto-refresh */}
        <button
          onClick={() => setAutoRefresh(!autoRefresh)}
          className={`px-2.5 py-1.5 text-xs rounded-md border transition-colors flex items-center gap-1.5 ${
            autoRefresh
              ? "border-green-500/30 bg-green-500/10 text-green-400"
              : "border-border text-muted-foreground hover:text-foreground"
          }`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${autoRefresh ? "bg-green-500 animate-pulse" : "bg-zinc-500"}`} />
          Auto
        </button>

        {/* Loading indicator */}
        {logs.isFetching && (
          <span className="w-3.5 h-3.5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
        )}
      </div>

      {/* Log content */}
      <div
        ref={containerRef}
        className="h-[400px] overflow-y-auto p-4 bg-[#0a0a0a] font-mono text-xs leading-relaxed"
      >
        {logs.isLoading ? (
          <p className="text-muted-foreground">Querying CloudWatch Logs...</p>
        ) : logs.error ? (
          <p className="text-red-400">Error: {logs.error.message}</p>
        ) : !logs.data || logs.data.length === 0 ? (
          <p className="text-muted-foreground">No logs found for this time range.</p>
        ) : (
          logs.data.map((entry, i) => {
            const isError = /error|fatal|panic|exception/i.test(entry.message);
            const isWarn = /warn|warning/i.test(entry.message);
            const color = isError ? "text-red-400" : isWarn ? "text-yellow-400" : "text-foreground/70";

            return (
              <div key={i} className={`py-0.5 flex gap-3 ${color}`}>
                <span className="text-muted-foreground/40 shrink-0 select-none">
                  {formatTimestamp(entry.timestamp)}
                </span>
                {selectedPod === "" && (
                  <span className="text-blue-400/50 shrink-0 w-[180px] truncate">
                    {entry.podName}
                  </span>
                )}
                <span className="whitespace-pre-wrap break-all">{entry.message}</span>
              </div>
            );
          })
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-1.5 border-t border-border text-[10px] text-muted-foreground/50 flex items-center justify-between">
        <span>{logs.data?.length ?? 0} entries</span>
        <span>{namespace} on {clusterName}</span>
      </div>
    </div>
  );
}

function formatTimestamp(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return ts;
  }
}
