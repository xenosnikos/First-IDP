"use client";

import Link from "next/link";
import { trpc } from "@/lib/trpc-client";

const statusColor: Record<string, string> = {
  SUCCEEDED: "bg-green-500",
  RUNNING: "bg-blue-500 animate-pulse",
  PENDING: "bg-yellow-500",
  FAILED: "bg-red-500",
  CANCELLED: "bg-zinc-500",
};

const statusText: Record<string, string> = {
  SUCCEEDED: "text-green-400",
  RUNNING: "text-blue-400",
  PENDING: "text-yellow-400",
  FAILED: "text-red-400",
  CANCELLED: "text-zinc-400",
};

export default function PipelinesPage() {
  const runs = trpc.pipeline.listAll.useQuery();

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Pipelines</h1>
        <p className="text-muted-foreground mt-1">Recent pipeline runs across all projects</p>
      </div>

      {runs.isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-12 justify-center">
          <span className="w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
          Loading...
        </div>
      )}

      {runs.error && (
        <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-4">
          <p className="text-destructive text-sm">{runs.error.message}</p>
        </div>
      )}

      {runs.data && (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-card border-b border-border">
                <th className="text-left px-4 py-3 text-muted-foreground font-medium">Status</th>
                <th className="text-left px-4 py-3 text-muted-foreground font-medium">Workflow</th>
                <th className="text-left px-4 py-3 text-muted-foreground font-medium">Project</th>
                <th className="text-left px-4 py-3 text-muted-foreground font-medium">Environment</th>
                <th className="text-left px-4 py-3 text-muted-foreground font-medium">Started</th>
                <th className="text-left px-4 py-3 text-muted-foreground font-medium">Duration</th>
              </tr>
            </thead>
            <tbody>
              {runs.data.map((run) => {
                const startMs = run.startedAt ? new Date(run.startedAt).getTime() : 0;
                const endMs = run.completedAt ? new Date(run.completedAt).getTime() : (run.status === "RUNNING" ? Date.now() : startMs);
                const durSec = startMs ? Math.round((endMs - startMs) / 1000) : 0;
                const duration = durSec >= 60 ? `${Math.floor(durSec / 60)}m ${durSec % 60}s` : `${durSec}s`;

                return (
                  <tr key={run.id} className="border-b border-border/50 hover:bg-accent/20">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${statusColor[run.status] ?? "bg-zinc-500"}`} />
                        <span className={`text-xs font-medium ${statusText[run.status] ?? ""}`}>
                          {run.status}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/pipelines/${run.id}`}
                        className="font-mono text-xs text-primary hover:underline"
                      >
                        {run.argoWorkflowName}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {run.environment?.project?.name ?? "--"}
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-xs">{run.environment?.tier ?? "--"}</span>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {run.startedAt ? new Date(run.startedAt).toLocaleString() : "--"}
                    </td>
                    <td className="px-4 py-3 text-xs font-mono text-muted-foreground">
                      {startMs ? duration : "--"}
                    </td>
                  </tr>
                );
              })}
              {runs.data.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-muted-foreground">
                    No pipeline runs yet
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
