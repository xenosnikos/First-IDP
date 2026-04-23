"use client";

import type { WorkflowStep } from "@/server/services/argo";

const phaseIcon: Record<string, { color: string; icon: React.ReactNode }> = {
  Pending: {
    color: "text-zinc-500 border-zinc-500/30",
    icon: <circle cx="12" cy="12" r="4" fill="currentColor" opacity="0.4" />,
  },
  Running: {
    color: "text-blue-400 border-blue-500/30",
    icon: (
      <g>
        <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="8 4">
          <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite" />
        </circle>
      </g>
    ),
  },
  Succeeded: {
    color: "text-green-400 border-green-500/30",
    icon: <path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />,
  },
  Failed: {
    color: "text-red-400 border-red-500/30",
    icon: <path d="M10 10l4 4m0-4l-4 4" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" fill="none" />,
  },
  Error: {
    color: "text-red-400 border-red-500/30",
    icon: <path d="M10 10l4 4m0-4l-4 4" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" fill="none" />,
  },
  Skipped: {
    color: "text-zinc-600 border-zinc-600/30",
    icon: <path d="M9 12h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />,
  },
};

// Sort steps by startedAt, then by name for deterministic ordering
function sortSteps(steps: WorkflowStep[]): WorkflowStep[] {
  return [...steps].sort((a, b) => {
    if (a.startedAt && b.startedAt) return new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime();
    if (a.startedAt) return -1;
    if (b.startedAt) return 1;
    return a.name.localeCompare(b.name);
  });
}

function stepDuration(step: WorkflowStep): string {
  if (!step.startedAt) return "";
  const start = new Date(step.startedAt).getTime();
  const end = step.finishedAt ? new Date(step.finishedAt).getTime() : Date.now();
  const sec = Math.round((end - start) / 1000);
  if (sec >= 60) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${sec}s`;
}

export function DagTimeline({
  steps,
  selectedStepId,
  onSelectStep,
}: {
  steps: WorkflowStep[];
  selectedStepId: string | null;
  onSelectStep: (id: string) => void;
}) {
  const sorted = sortSteps(steps);

  if (sorted.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-6">
        <h3 className="text-sm font-semibold mb-3">Pipeline Steps</h3>
        <p className="text-sm text-muted-foreground">Waiting for steps...</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <h3 className="text-sm font-semibold mb-4">Pipeline Steps</h3>
      <div className="space-y-1">
        {sorted.map((step, i) => {
          const pi = phaseIcon[step.phase] ?? phaseIcon.Pending;
          const isSelected = step.id === selectedStepId;
          const duration = stepDuration(step);
          const isLast = i === sorted.length - 1;

          return (
            <div key={step.id} className="flex gap-3">
              {/* Timeline connector */}
              <div className="flex flex-col items-center">
                <svg className={`w-6 h-6 shrink-0 ${pi.color}`} viewBox="0 0 24 24">
                  {pi.icon}
                </svg>
                {!isLast && (
                  <div className={`w-px flex-1 min-h-[20px] ${
                    step.phase === "Succeeded" ? "bg-green-500/30" : "bg-border"
                  }`} />
                )}
              </div>

              {/* Step card */}
              <button
                onClick={() => onSelectStep(step.id)}
                className={`flex-1 flex items-center justify-between rounded-md px-3 py-2 text-left text-sm transition-colors mb-1 ${
                  isSelected
                    ? "bg-primary/10 border border-primary/30"
                    : "hover:bg-accent/50 border border-transparent"
                }`}
              >
                <div className="min-w-0">
                  <p className={`font-medium truncate ${
                    step.phase === "Failed" || step.phase === "Error" ? "text-red-400" : ""
                  }`}>
                    {step.name}
                  </p>
                  {step.message && (
                    <p className="text-xs text-red-400/70 truncate mt-0.5">{step.message}</p>
                  )}
                </div>
                {duration && (
                  <span className="text-xs text-muted-foreground shrink-0 ml-2 font-mono">
                    {duration}
                  </span>
                )}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
