"use client";

import { useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc-client";

export function StepLogViewer({ runId, stepId }: { runId: string; stepId: string }) {
  const [search, setSearch] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);

  const logs = trpc.pipeline.getStepLogs.useQuery(
    { pipelineRunId: runId, stepId },
    { refetchInterval: 5000 },
  );

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs.data, autoScroll]);

  const logText = logs.data?.logs ?? "";
  const lines = logText.split("\n").filter(Boolean);
  const filtered = search
    ? lines.filter((l) => l.toLowerCase().includes(search.toLowerCase()))
    : lines;

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden flex flex-col h-[500px]">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-card shrink-0">
        <div className="flex items-center gap-3">
          <h4 className="text-sm font-medium">Logs</h4>
          {logs.isFetching && (
            <span className="w-3 h-3 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
          )}
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter..."
            className="w-40 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-mono placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <button
            onClick={() => setAutoScroll(!autoScroll)}
            className={`px-2 py-1 text-xs rounded-md border transition-colors ${
              autoScroll ? "border-primary/30 bg-primary/10 text-primary" : "border-border text-muted-foreground"
            }`}
            title="Auto-scroll"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 13.5L12 21m0 0l-7.5-7.5M12 21V3" />
            </svg>
          </button>
        </div>
      </div>

      {/* Log content */}
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto p-4 bg-[#0a0a0a] font-mono text-xs leading-relaxed"
      >
        {logs.isLoading ? (
          <p className="text-muted-foreground">Loading logs...</p>
        ) : filtered.length === 0 ? (
          <p className="text-muted-foreground">
            {logText ? "No matching lines." : "No logs yet. Waiting for output..."}
          </p>
        ) : (
          filtered.map((line, i) => (
            <LogLine key={i} line={line} search={search} />
          ))
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-1.5 border-t border-border text-[10px] text-muted-foreground/50 shrink-0">
        {filtered.length} line{filtered.length !== 1 ? "s" : ""}
        {search && ` (filtered from ${lines.length})`}
      </div>
    </div>
  );
}

function LogLine({ line, search }: { line: string; search: string }) {
  const isError = /error|fatal|panic|exception/i.test(line);
  const isWarn = /warn|warning/i.test(line);
  const color = isError ? "text-red-400" : isWarn ? "text-yellow-400" : "text-foreground/70";

  // Parse NDJSON from Argo if present
  let text = line;
  try {
    const parsed = JSON.parse(line);
    if (parsed.result?.content) text = parsed.result.content;
  } catch { /* not JSON, use raw line */ }

  return (
    <div className={`py-0.5 whitespace-pre-wrap break-all ${color}`}>
      {text}
    </div>
  );
}
