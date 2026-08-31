"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { DagTimeline } from "./dag-timeline";
import { StepLogViewer } from "./step-log-viewer";

const phaseColor: Record<string, string> = {
  PENDING: "text-muted-foreground",
  RUNNING: "text-blue-400",
  SUCCEEDED: "text-green-400",
  FAILED: "text-red-400",
  CANCELLED: "text-zinc-400",
};

const phaseBg: Record<string, string> = {
  PENDING: "bg-muted-foreground",
  RUNNING: "bg-blue-500",
  SUCCEEDED: "bg-green-500",
  FAILED: "bg-red-500",
  CANCELLED: "bg-zinc-500",
};

// runId route param format: "<owner>--<repo>--<githubRunId>"
export function PipelineRunView({ runId }: { runId: string }) {
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);

  const [owner, repo, ghRunIdStr] = runId.split("--");
  const ghRunId = Number(ghRunIdStr);
  const valid = Boolean(owner && repo && Number.isFinite(ghRunId));

  const status = trpc.pipeline.getGithubRun.useQuery(
    { owner, repo, runId: ghRunId },
    {
      enabled: valid,
      refetchInterval: (query) => {
        const data = query.state.data;
        if (!data) return 5000;
        return data.status === "RUNNING" || data.status === "PENDING" ? 5000 : false;
      },
    },
  );

  if (!valid) {
    return (
      <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-4">
        <p className="text-destructive text-sm">Unrecognized run id: {runId}</p>
      </div>
    );
  }

  if (status.isLoading) {
    return (
      <div className="flex items-center justify-center py-20 gap-3 text-muted-foreground">
        <span className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
        Loading pipeline...
      </div>
    );
  }

  if (status.error) {
    return (
      <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-4">
        <p className="text-destructive text-sm">{status.error.message}</p>
      </div>
    );
  }

  const data = status.data!;
  const isRunning = data.status === "RUNNING" || data.status === "PENDING";
  const failed = data.status === "FAILED";

  const startTime = data.startedAt ? new Date(data.startedAt).getTime() : Date.now();
  const endTime = data.completedAt ? new Date(data.completedAt).getTime() : Date.now();
  const durationSec = Math.round((endTime - startTime) / 1000);
  const durationStr = durationSec >= 60
    ? `${Math.floor(durationSec / 60)}m ${durationSec % 60}s`
    : `${durationSec}s`;

  return (
    <div className="space-y-6">
      {/* Status header */}
      <div className="rounded-lg border border-border bg-card p-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <span className={`w-3 h-3 rounded-full ${phaseBg[data.status] ?? "bg-muted-foreground"} ${isRunning ? "animate-pulse" : ""}`} />
            <div>
              <h2 className="font-semibold">
                <span className="font-mono text-sm text-muted-foreground mr-2">
                  {data.workflowName} #{data.runNumber}
                </span>
              </h2>
              <div className="flex items-center gap-3 mt-1 text-sm">
                <span className="text-muted-foreground">{owner}/{repo}</span>
                <span className="text-muted-foreground/50">/</span>
                <span className="font-mono text-xs text-muted-foreground">{data.branch}</span>
                <span className="text-muted-foreground/50">/</span>
                <span className={phaseColor[data.status] ?? ""}>{data.status}</span>
              </div>
            </div>
          </div>
          <div className="text-right text-sm text-muted-foreground">
            <p className="font-mono">{durationStr}</p>
            {data.startedAt && (
              <p className="text-xs mt-0.5">
                Started {new Date(data.startedAt).toLocaleTimeString()}
              </p>
            )}
            <a
              href={data.htmlUrl}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-primary hover:underline"
            >
              Open in GitHub ↗
            </a>
          </div>
        </div>
      </div>

      {/* Failed banner */}
      {failed && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-4 flex items-start gap-3">
          <svg className="w-5 h-5 text-red-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
          </svg>
          <div>
            <p className="text-sm font-medium text-red-400">Pipeline Failed</p>
            <p className="text-xs text-red-400/70 mt-1">
              Check the failed job logs below for details.
            </p>
          </div>
        </div>
      )}

      {/* Jobs timeline + Log viewer */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <div className="lg:col-span-2">
          <DagTimeline
            steps={data.steps}
            selectedStepId={selectedStepId}
            onSelectStep={setSelectedStepId}
          />
        </div>
        <div className="lg:col-span-3">
          {selectedStepId ? (
            <StepLogViewer owner={owner} repo={repo} jobId={Number(selectedStepId)} />
          ) : (
            <div className="rounded-lg border border-border bg-card p-8 text-center text-muted-foreground text-sm">
              Select a job to view its logs
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
