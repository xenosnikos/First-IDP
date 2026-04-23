"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { trpc } from "@/lib/trpc-client";
import { ServiceLogViewer } from "@/components/environments/service-logs";

const tierBadge: Record<string, string> = {
  DEV: "bg-blue-500/15 text-blue-400",
  QA: "bg-cyan-500/15 text-cyan-400",
  STAGING: "bg-yellow-500/15 text-yellow-400",
  PRODUCTION: "bg-red-500/15 text-red-400",
};

const statusDot: Record<string, string> = {
  PROVISIONING: "bg-yellow-500 animate-pulse",
  RUNNING: "bg-green-500",
  FAILED: "bg-red-500",
  DESTROYING: "bg-orange-500 animate-pulse",
  DESTROYED: "bg-zinc-500",
};

// Map tier to cluster
const TIER_CLUSTER: Record<string, string> = {
  PRODUCTION: process.env.NEXT_PUBLIC_EKS_PROD_CLUSTER ?? "EKS-Moly-Prod",
  STAGING: process.env.NEXT_PUBLIC_EKS_STAGING_CLUSTER ?? "EKS-Moly-staging",
  DEV: process.env.NEXT_PUBLIC_EKS_STAGING_CLUSTER ?? "EKS-Moly-staging",
  QA: process.env.NEXT_PUBLIC_EKS_STAGING_CLUSTER ?? "EKS-Moly-staging",
  PREVIEW: process.env.NEXT_PUBLIC_EKS_STAGING_CLUSTER ?? "EKS-Moly-staging",
};

export default function EnvironmentDetailPage() {
  const params = useParams<{ projectId: string; envId: string }>();
  const envId = params.envId;
  const projectId = params.projectId;

  const env = trpc.environment.get.useQuery({ id: envId });

  if (env.isLoading) {
    return (
      <div className="p-8 flex items-center gap-2 text-muted-foreground justify-center py-20">
        <span className="w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
        Loading environment...
      </div>
    );
  }

  if (env.error) {
    return (
      <div className="p-8 max-w-4xl mx-auto">
        <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-4">
          <p className="text-destructive text-sm">{env.error.message}</p>
        </div>
      </div>
    );
  }

  const data = env.data!;
  const clusterName = TIER_CLUSTER[data.tier] ?? "EKS-Moly-staging";

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link href="/projects" className="hover:text-foreground">Projects</Link>
        <span>/</span>
        <Link href={`/projects/${projectId}`} className="hover:text-foreground">{data.project?.name ?? projectId}</Link>
        <span>/</span>
        <span className="text-foreground">{data.tier} Environment</span>
      </div>

      {/* Status header */}
      <div className="rounded-lg border border-border bg-card p-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <span className={`w-3 h-3 rounded-full ${statusDot[data.status] ?? "bg-zinc-500"}`} />
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-bold">{data.project?.name ?? "Environment"}</h1>
                <span className={`text-xs px-2 py-0.5 rounded-full ${tierBadge[data.tier] ?? ""}`}>
                  {data.tier}
                </span>
              </div>
              <div className="flex items-center gap-3 mt-1 text-sm text-muted-foreground">
                <span className="font-mono text-xs">{data.namespace}</span>
                <span className="text-muted-foreground/30">|</span>
                <span className="text-xs">{clusterName}</span>
                <span className="text-muted-foreground/30">|</span>
                <span className={`text-xs ${data.status === "RUNNING" ? "text-green-400" : data.status === "FAILED" ? "text-red-400" : "text-yellow-400"}`}>
                  {data.status}
                </span>
              </div>
            </div>
          </div>
          {data.serviceUrl && (
            <a
              href={data.serviceUrl.startsWith("http") ? data.serviceUrl : `https://${data.serviceUrl}`}
              target="_blank"
              rel="noopener noreferrer"
              className="px-4 py-2 text-sm rounded-lg bg-primary/10 text-primary hover:bg-primary/20 font-mono"
            >
              {data.serviceUrl}
            </a>
          )}
        </div>

        {/* Deploy config */}
        {data.deployConfig && (
          <div className="mt-4 pt-4 border-t border-border flex items-center gap-6 text-xs text-muted-foreground">
            <span>Branch: <span className="text-foreground font-mono">{data.deployConfig.branch}</span></span>
            <span>Commit: <span className="text-foreground font-mono">{data.deployConfig.commitSha?.slice(0, 7)}</span></span>
            <span>Replicas: <span className="text-foreground">{data.deployConfig.replicas}</span></span>
            <span>CPU: <span className="text-foreground font-mono">{data.deployConfig.cpuLimit}</span></span>
            <span>Mem: <span className="text-foreground font-mono">{data.deployConfig.memLimit}</span></span>
          </div>
        )}
      </div>

      {/* Recent Pipeline Runs */}
      {data.pipelineRuns && data.pipelineRuns.length > 0 && (
        <div className="rounded-lg border border-border bg-card p-5">
          <h2 className="text-sm font-semibold mb-3">Recent Pipeline Runs</h2>
          <div className="space-y-2">
            {data.pipelineRuns.map((run) => (
              <Link
                key={run.id}
                href={`/pipelines/${run.id}`}
                className="flex items-center justify-between rounded-md border border-border/50 px-4 py-2.5 text-sm hover:border-primary/30 transition-colors"
              >
                <div className="flex items-center gap-2.5">
                  <span className={`w-2 h-2 rounded-full ${
                    run.status === "SUCCEEDED" ? "bg-green-500"
                    : run.status === "FAILED" ? "bg-red-500"
                    : run.status === "RUNNING" ? "bg-blue-500 animate-pulse"
                    : "bg-yellow-500"
                  }`} />
                  <span className="font-mono text-xs text-muted-foreground">{run.argoWorkflowName}</span>
                </div>
                <div className="flex items-center gap-4 text-xs text-muted-foreground">
                  <span className={
                    run.status === "SUCCEEDED" ? "text-green-400"
                    : run.status === "FAILED" ? "text-red-400"
                    : run.status === "RUNNING" ? "text-blue-400"
                    : ""
                  }>{run.status}</span>
                  {run.startedAt && (
                    <span>{new Date(run.startedAt).toLocaleString()}</span>
                  )}
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Service Logs */}
      <div className="rounded-lg border border-border bg-card p-5">
        <h2 className="text-sm font-semibold mb-3">Service Logs</h2>
        <ServiceLogViewer
          clusterName={clusterName}
          namespace={data.namespace}
          pods={[]}
        />
      </div>
    </div>
  );
}
