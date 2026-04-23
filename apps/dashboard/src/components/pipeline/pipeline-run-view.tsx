"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { DagTimeline } from "./dag-timeline";
import { StepLogViewer } from "./step-log-viewer";
import { PipelineOutput } from "./pipeline-output";

const phaseColor: Record<string, string> = {
  Pending: "text-muted-foreground",
  Running: "text-blue-400",
  Succeeded: "text-green-400",
  Failed: "text-red-400",
  Error: "text-red-400",
};

const phaseBg: Record<string, string> = {
  Pending: "bg-muted-foreground",
  Running: "bg-blue-500",
  Succeeded: "bg-green-500",
  Failed: "bg-red-500",
  Error: "bg-red-500",
};

export function PipelineRunView({ runId }: { runId: string }) {
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);

  const status = trpc.pipeline.getStatus.useQuery(
    { pipelineRunId: runId },
    {
      refetchInterval: (query) => {
        const data = query.state.data;
        if (!data) return 3000;
        const s = data.status;
        return s === "RUNNING" || s === "PENDING" ? 3000 : false;
      },
    },
  );

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
  const succeeded = data.status === "SUCCEEDED";
  const failed = data.status === "FAILED";

  // Duration
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
            <span className={`w-3 h-3 rounded-full ${phaseBg[data.status === "RUNNING" ? "Running" : data.status === "SUCCEEDED" ? "Succeeded" : data.status === "FAILED" ? "Failed" : "Pending"]} ${isRunning ? "animate-pulse" : ""}`} />
            <div>
              <h2 className="font-semibold">
                <span className="font-mono text-sm text-muted-foreground mr-2">
                  {data.argoWorkflowName}
                </span>
              </h2>
              <div className="flex items-center gap-3 mt-1 text-sm">
                {data.environment && (
                  <>
                    <span className="text-muted-foreground">
                      {data.environment.project?.name}
                    </span>
                    <span className="text-muted-foreground/50">/</span>
                    <span className={phaseColor[data.status === "SUCCEEDED" ? "Succeeded" : data.status === "FAILED" ? "Failed" : data.status === "RUNNING" ? "Running" : "Pending"]}>
                      {data.status}
                    </span>
                  </>
                )}
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
          </div>
        </div>
      </div>

      {/* Output URL on success */}
      {succeeded && data.outputs && (
        <PipelineOutput outputs={data.outputs} />
      )}

      {/* Failed banner */}
      {failed && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-4 flex items-start gap-3">
          <svg className="w-5 h-5 text-red-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
          </svg>
          <div>
            <p className="text-sm font-medium text-red-400">Pipeline Failed</p>
            <p className="text-xs text-red-400/70 mt-1">
              Check the failed step logs below for details.
            </p>
          </div>
        </div>
      )}

      {/* DAG Timeline + Log Viewer */}
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
            <StepLogViewer runId={runId} stepId={selectedStepId} />
          ) : (
            <div className="rounded-lg border border-border bg-card p-8 text-center text-muted-foreground text-sm">
              Select a step to view its logs
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
