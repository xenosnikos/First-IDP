"use client";

import { trpc } from "@/lib/trpc-client";

export function StepBranch({
  owner,
  repo,
  value,
  onChange,
}: {
  owner: string;
  repo: string;
  value: { branch: string; commitSha: string };
  onChange: (branch: string, commitSha: string) => void;
}) {
  const branches = trpc.project.listBranches.useQuery({ owner, repo });

  return (
    <div>
      <h3 className="text-lg font-semibold mb-1">Select Branch</h3>
      <p className="text-sm text-muted-foreground mb-6">
        Choose the branch to deploy from.
      </p>

      {branches.isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
          <span className="w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
          Loading branches...
        </div>
      )}

      {branches.error && (
        <p className="text-destructive text-sm">Failed to load branches: {branches.error.message}</p>
      )}

      {branches.data && (
        <div className="space-y-2 max-h-[400px] overflow-y-auto">
          {branches.data.map((b) => (
            <button
              key={b.name}
              onClick={() => onChange(b.name, b.sha)}
              className={`w-full flex items-center justify-between rounded-lg border px-4 py-3 text-left transition-colors ${
                value.branch === b.name
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-primary/30"
              }`}
            >
              <div className="flex items-center gap-3">
                <svg className="w-4 h-4 text-muted-foreground shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
                </svg>
                <span className="font-medium text-sm">{b.name}</span>
              </div>
              <span className="font-mono text-xs text-muted-foreground">
                {b.sha.slice(0, 7)}
              </span>
            </button>
          ))}
        </div>
      )}

      {value.branch && (
        <div className="mt-4 rounded-md bg-muted/50 px-4 py-2.5 text-sm flex items-center gap-2">
          <span className="text-muted-foreground">Selected:</span>
          <span className="font-medium">{value.branch}</span>
          <span className="font-mono text-xs text-muted-foreground">({value.commitSha.slice(0, 7)})</span>
        </div>
      )}
    </div>
  );
}
