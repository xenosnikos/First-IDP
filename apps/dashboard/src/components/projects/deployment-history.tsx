import type { ProjectIntrospection } from "@/server/services/introspect";

export function DeploymentHistory({ deployments }: { deployments: ProjectIntrospection["vercelDeployments"] }) {
  if (deployments.length === 0) return null;

  return (
    <div className="space-y-2">
      {deployments.slice(0, 15).map((d) => (
        <div key={d.id} className="flex items-center justify-between rounded-md border border-border/50 px-4 py-3 text-sm">
          <div className="flex items-center gap-3">
            <StatusDot status={d.state} />
            <a href={d.url} target="_blank" rel="noopener noreferrer"
              className="text-primary hover:underline font-mono text-xs">
              {d.url.replace("https://", "")}
            </a>
          </div>
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            {d.branch && <span className="bg-muted px-2 py-0.5 rounded">{d.branch}</span>}
            <span>{new Date(d.createdAt).toLocaleString()}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const s = status.toUpperCase();
  const color = s === "READY" || s === "IDLE" || s === "RUNNING" ? "bg-green-500"
    : s === "BUILDING" || s === "QUEUED" || s === "PENDING" ? "bg-yellow-500"
    : s === "ERROR" || s === "FAILED" ? "bg-red-500" : "bg-zinc-500";
  return <span className={`w-2 h-2 rounded-full inline-block shrink-0 ${color}`} />;
}
