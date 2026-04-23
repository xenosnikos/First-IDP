"use client";

import { useState } from "react";
import type { LiveEnvironment, DbConnection } from "@/server/services/introspect";
import type { SecretEntry, EksClusterInfo } from "@/server/services/aws";

const tierOrder = { production: 0, staging: 1, dev: 2, unknown: 3 };
const tierBadge: Record<string, string> = {
  production: "bg-red-500/15 text-red-400",
  staging: "bg-yellow-500/15 text-yellow-400",
  dev: "bg-blue-500/15 text-blue-400",
  unknown: "bg-zinc-500/15 text-zinc-400",
};
const tierBorder: Record<string, string> = {
  production: "border-red-500/30",
  staging: "border-yellow-500/30",
  dev: "border-blue-500/30",
  unknown: "border-zinc-500/30",
};
const dot: Record<string, string> = {
  READY: "bg-green-500", Running: "bg-green-500", IDLE: "bg-green-500", live: "bg-green-500",
  BUILDING: "bg-yellow-500", QUEUED: "bg-yellow-500", Pending: "bg-yellow-500", configured: "bg-yellow-500",
  ERROR: "bg-red-500", Failed: "bg-red-500",
};

export function EnvironmentTabs({ environments }: { environments: LiveEnvironment[] }) {
  const sorted = [...environments].sort((a, b) => (tierOrder[a.tier] ?? 3) - (tierOrder[b.tier] ?? 3));
  const [activeIdx, setActiveIdx] = useState(0);

  if (sorted.length === 0) {
    return <p className="text-sm text-muted-foreground">No environments detected.</p>;
  }

  const current = sorted[activeIdx] ?? sorted[0];

  return (
    <div>
      {/* Tab bar */}
      <div className="flex gap-1 border-b border-border mb-6">
        {sorted.map((env, i) => {
          const isActive = i === activeIdx;
          const hasError = env.services.some((s) => s.status === "ERROR" || s.status === "Failed");
          const isLive = env.status === "live";

          return (
            <button
              key={`${env.tier}-${env.source}`}
              onClick={() => setActiveIdx(i)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors flex items-center gap-2.5 ${
                isActive ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              <span className={`w-2 h-2 rounded-full ${
                hasError ? "bg-red-500" : isLive ? "bg-green-500" : "bg-yellow-500"
              }`} />
              {env.name}
              {!isLive && <span className="text-[10px] text-muted-foreground">(config only)</span>}
            </button>
          );
        })}
      </div>

      {/* Everything for the selected environment */}
      <EnvironmentDetail env={current} />
    </div>
  );
}

function EnvironmentDetail({ env }: { env: LiveEnvironment }) {
  return (
    <div className={`space-y-6 rounded-lg border p-6 ${tierBorder[env.tier]}`}>

      {/* Status summary */}
      <div className="flex items-center gap-4">
        <span className={`w-3 h-3 rounded-full ${dot[env.status] ?? "bg-zinc-500"}`} />
        <span className="font-semibold">{env.name}</span>
        <span className={`text-xs px-2 py-0.5 rounded-full ${tierBadge[env.tier]}`}>{env.tier}</span>
        <span className="text-xs text-muted-foreground">
          via {env.source === "eks" ? "EKS" : env.source === "vercel" ? "Vercel" : "Config"}
        </span>
        {env.status === "live" && <span className="text-xs text-green-400">Live</span>}
        {env.status === "configured" && <span className="text-xs text-yellow-400">Configured (no live pods)</span>}
      </div>

      {/* Endpoints */}
      {env.endpoints.length > 0 && (
        <Block title="Endpoints">
          <div className="flex flex-wrap gap-2">
            {env.endpoints.map((url) => (
              <a key={url} href={url} target="_blank" rel="noopener noreferrer"
                className="text-sm text-primary hover:underline font-mono bg-background/80 px-3 py-1.5 rounded border border-border/50">
                {url.replace("https://", "")}
              </a>
            ))}
          </div>
        </Block>
      )}

      {/* Services / Pods */}
      {env.services.length > 0 && (
        <Block title={`Services (${env.services.length})`}>
          <div className="space-y-2">
            {env.services.map((svc, i) => (
              <div key={i} className="flex items-center justify-between bg-background/60 rounded px-4 py-3 text-sm border border-border/30">
                <div className="flex items-center gap-2.5">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${dot[svc.status] ?? "bg-zinc-500"}`} />
                  <span className="font-mono text-xs">{svc.podName}</span>
                  {svc.containerName !== "vercel" && (
                    <span className="text-xs text-muted-foreground">({svc.containerName})</span>
                  )}
                </div>
                <div className="flex items-center gap-5 text-xs text-muted-foreground">
                  <StatusText status={svc.status} />
                  {svc.cpuUtil !== undefined && <Metric label="CPU" value={svc.cpuUtil} />}
                  {svc.memUtil !== undefined && <Metric label="Mem" value={svc.memUtil} />}
                  {svc.restarts > 0 && <span className="text-yellow-400">{svc.restarts} restarts</span>}
                  {svc.node && <span>{svc.node.split(".")[0]}</span>}
                </div>
              </div>
            ))}
          </div>
        </Block>
      )}

      {/* Nodes (EKS only, when live) */}
      {env.source === "eks" && env.nodes && env.nodes.length > 0 && (
        <Block title="Nodes">
          <div className="space-y-2">
            {env.nodes.map((n) => (
              <div key={n.name} className="flex items-center justify-between bg-background/60 rounded px-4 py-3 text-sm border border-border/30">
                <span className="font-mono text-xs">{n.name}</span>
                <div className="flex items-center gap-5 text-xs">
                  <Metric label="CPU" value={n.cpu} />
                  <Metric label="Mem" value={n.mem} />
                  <span className="text-muted-foreground">{n.pods} pods</span>
                </div>
              </div>
            ))}
          </div>
        </Block>
      )}

      {/* Databases */}
      {env.databases.length > 0 && (
        <Block title={`Database (${env.databases.length})`}>
          <div className="space-y-3">
            {env.databases.map((db, i) => (
              <div key={i} className="bg-background/60 rounded px-4 py-3 text-sm border border-border/30 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="font-mono font-medium">{db.host} / {db.database || "(default)"}</span>
                  {db.matchedAtlasCluster && (
                    <span className="text-xs bg-muted px-2 py-0.5 rounded">Atlas: {db.matchedAtlasCluster}</span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  URI from <span className="font-mono">{db.secretName}</span> <span className="font-mono text-foreground/50">{db.secretKey}</span>
                </p>
                <p className="text-xs font-mono text-blue-400/60 break-all">{db.uri}</p>
              </div>
            ))}
          </div>
        </Block>
      )}

      {/* Secrets */}
      {env.secrets.length > 0 && (
        <Block title={`Secrets (${env.secrets.length})`}>
          <div className="space-y-4">
            {env.secrets.map((secret) => (
              <SecretBlock key={secret.name} secret={secret} />
            ))}
          </div>
        </Block>
      )}

      {/* EKS cluster info */}
      {env.source === "eks" && env.eksCluster && (
        <Block title="Cluster">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <MiniCard label="Cluster" value={env.eksCluster.name} />
            <MiniCard label="K8s" value={`v${env.eksCluster.version}`} />
            <MiniCard label="Status" value={env.eksCluster.status} />
            <MiniCard label="Node Groups" value={String(env.eksCluster.nodeGroups.length)} />
          </div>
        </Block>
      )}
    </div>
  );
}

// ── Sub-components ───────────────────────────

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">{title}</h3>
      {children}
    </div>
  );
}

function MiniCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-background/60 rounded px-3 py-2 border border-border/30">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className="text-xs font-medium">{value}</p>
    </div>
  );
}

function StatusText({ status }: { status: string }) {
  const color = status === "Running" || status === "READY" ? "text-green-400"
    : status === "ERROR" || status === "Failed" ? "text-red-400"
    : "text-yellow-400";
  return <span className={color}>{status}</span>;
}

function Metric({ label, value }: { label: string; value: number }) {
  const color = value > 80 ? "text-red-400" : value > 50 ? "text-yellow-400" : "text-green-400";
  return <span className={color}>{label} {value.toFixed(1)}%</span>;
}

function SecretBlock({ secret }: { secret: SecretEntry }) {
  const rows = secret.keys.map((key) => {
    const val = secret.values[key] ?? "";
    const isSensitive = /secret|password|token|key|private/i.test(key);
    const isUri = /uri|url|endpoint|connection/i.test(key);

    let display: string;
    if (isSensitive) {
      display = val.length > 0 ? `${"*".repeat(Math.min(val.length, 8))}... (${val.length} chars)` : "(empty)";
    } else if (isUri && val.includes("@")) {
      display = val.replace(/\/\/[^:]+:[^@]+@/, "//***:***@");
    } else if (val.length > 80) {
      display = val.slice(0, 60) + "...";
    } else {
      display = val || "(empty)";
    }
    return { key, display, isSensitive, isUri };
  });

  return (
    <div className="bg-background/60 rounded p-4 border border-border/30">
      <p className="font-mono text-sm font-medium mb-2">{secret.name}</p>
      <div className="space-y-1">
        {rows.map(({ key, display, isSensitive, isUri }) => (
          <div key={key} className="flex items-start gap-3 text-xs">
            <span className="font-mono text-muted-foreground min-w-[160px] shrink-0">{key}</span>
            <span className={`font-mono break-all ${
              isSensitive ? "text-yellow-500/70" : isUri ? "text-blue-400/60" : "text-foreground/50"
            }`}>{display}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
