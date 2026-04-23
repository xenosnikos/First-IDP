"use client";

import { useState } from "react";
import Link from "next/link";
import type { AllEnvironmentsData, EnvironmentOverview, ServiceInstance } from "@/server/services/introspect";

const tierColor: Record<string, { bg: string; border: string; badge: string; dot: string }> = {
  production: {
    bg: "bg-red-500/5",
    border: "border-red-500/20",
    badge: "bg-red-500/15 text-red-400",
    dot: "bg-red-500",
  },
  staging: {
    bg: "bg-yellow-500/5",
    border: "border-yellow-500/20",
    badge: "bg-yellow-500/15 text-yellow-400",
    dot: "bg-yellow-500",
  },
  dev: {
    bg: "bg-blue-500/5",
    border: "border-blue-500/20",
    badge: "bg-blue-500/15 text-blue-400",
    dot: "bg-blue-500",
  },
};

const sourceIcon: Record<string, string> = {
  eks: "EKS",
  vercel: "Vercel",
};

const statusDot: Record<string, string> = {
  Running: "bg-green-500",
  READY: "bg-green-500",
  IDLE: "bg-green-500",
  Pending: "bg-yellow-500",
  BUILDING: "bg-yellow-500",
  QUEUED: "bg-yellow-500",
  ERROR: "bg-red-500",
  Failed: "bg-red-500",
  CrashLoopBackOff: "bg-red-500",
};

type ViewMode = "diagram" | "table";

export function EnvironmentMap({ data }: { data: AllEnvironmentsData }) {
  const [view, setView] = useState<ViewMode>("diagram");
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());

  const toggleProject = (key: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div>
      {/* View toggle + summary */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-6">
          {data.environments.map((env) => {
            const c = tierColor[env.tier];
            const liveCount = env.services.filter((s) => s.status === "Running" || s.status === "READY" || s.status === "IDLE").length;
            return (
              <div key={env.tier} className="flex items-center gap-2 text-sm">
                <span className={`w-2.5 h-2.5 rounded-full ${c?.dot}`} />
                <span className="font-medium">{env.label}</span>
                <span className="text-muted-foreground">
                  {liveCount}/{env.services.length} live
                </span>
              </div>
            );
          })}
        </div>
        <div className="flex gap-1 bg-secondary rounded-lg p-0.5">
          <button
            onClick={() => setView("diagram")}
            className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
              view === "diagram" ? "bg-background text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Diagram
          </button>
          <button
            onClick={() => setView("table")}
            className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
              view === "table" ? "bg-background text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Table
          </button>
        </div>
      </div>

      {view === "diagram" ? (
        <DiagramView data={data} expandedProjects={expandedProjects} toggleProject={toggleProject} />
      ) : (
        <TableView data={data} />
      )}
    </div>
  );
}

// ── Diagram View ─────────────────────────────
// Shows environment tiers as swim lanes, with service cards grouped by project

function DiagramView({
  data,
  expandedProjects,
  toggleProject,
}: {
  data: AllEnvironmentsData;
  expandedProjects: Set<string>;
  toggleProject: (key: string) => void;
}) {
  // Get unique projects across all environments
  const allProjects = new Map<string, { type: string; tiers: Set<string> }>();
  for (const env of data.environments) {
    for (const svc of env.services) {
      if (svc.project === "unknown") continue;
      if (!allProjects.has(svc.project)) {
        const found = data.projects.find((p) => p.name === svc.project);
        allProjects.set(svc.project, { type: found?.type ?? "UNKNOWN", tiers: new Set() });
      }
      allProjects.get(svc.project)!.tiers.add(env.tier);
    }
    for (const db of env.databases) {
      if (db.project !== "unknown" && !allProjects.has(db.project)) {
        const found = data.projects.find((p) => p.name === db.project);
        allProjects.set(db.project, { type: found?.type ?? "UNKNOWN", tiers: new Set() });
      }
    }
  }

  return (
    <div className="space-y-6">
      {/* Environment swim lanes */}
      {data.environments.map((env) => (
        <EnvironmentLane
          key={env.tier}
          env={env}
          allProjects={allProjects}
          expandedProjects={expandedProjects}
          toggleProject={toggleProject}
        />
      ))}

      {/* Unmatched pods */}
      {data.environments.some((e) => e.services.some((s) => s.project === "unknown")) && (
        <div className="rounded-lg border border-zinc-500/20 bg-zinc-500/5 p-5">
          <h3 className="text-sm font-semibold text-zinc-400 mb-3">Unmatched Services</h3>
          <div className="flex flex-wrap gap-2">
            {data.environments.flatMap((e) =>
              e.services
                .filter((s) => s.project === "unknown")
                .map((s) => (
                  <span
                    key={`${e.tier}-${s.podName}`}
                    className="text-xs font-mono bg-zinc-500/10 text-zinc-400 px-2.5 py-1 rounded border border-zinc-500/20"
                  >
                    {s.podName.split("-").slice(0, -2).join("-") || s.podName}
                    <span className="text-zinc-600 ml-1.5">({e.label})</span>
                  </span>
                ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function EnvironmentLane({
  env,
  allProjects,
  expandedProjects,
  toggleProject,
}: {
  env: EnvironmentOverview;
  allProjects: Map<string, { type: string; tiers: Set<string> }>;
  expandedProjects: Set<string>;
  toggleProject: (key: string) => void;
}) {
  const c = tierColor[env.tier];

  // Group services by project
  const byProject = new Map<string, ServiceInstance[]>();
  for (const svc of env.services) {
    if (svc.project === "unknown") continue;
    if (!byProject.has(svc.project)) byProject.set(svc.project, []);
    byProject.get(svc.project)!.push(svc);
  }

  // Group databases by project
  const dbByProject = new Map<string, typeof env.databases>();
  for (const db of env.databases) {
    if (!dbByProject.has(db.project)) dbByProject.set(db.project, []);
    dbByProject.get(db.project)!.push(db);
  }

  const projectNames = Array.from(new Set([...byProject.keys(), ...dbByProject.keys()])).sort();

  return (
    <div className={`rounded-lg border ${c?.border} ${c?.bg} p-5`}>
      {/* Lane header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <span className={`w-3 h-3 rounded-full ${c?.dot}`} />
          <h3 className="text-lg font-semibold">{env.label}</h3>
          <span className={`text-xs px-2 py-0.5 rounded-full ${c?.badge}`}>
            {env.services.length} service{env.services.length !== 1 ? "s" : ""}
          </span>
          {env.databases.length > 0 && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400">
              {env.databases.length} db{env.databases.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {env.clusters.map((cl) => (
            <span key={cl} className="bg-background/60 px-2 py-1 rounded border border-border/30 font-mono">
              {cl}
            </span>
          ))}
        </div>
      </div>

      {/* Project cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {projectNames.map((projName) => {
          const services = byProject.get(projName) ?? [];
          const dbs = dbByProject.get(projName) ?? [];
          const projMeta = allProjects.get(projName);
          const expandKey = `${env.tier}-${projName}`;
          const isExpanded = expandedProjects.has(expandKey);

          return (
            <ProjectCard
              key={projName}
              projectName={projName}
              projectType={projMeta?.type ?? "UNKNOWN"}
              services={services}
              databases={dbs}
              tier={env.tier}
              isExpanded={isExpanded}
              onToggle={() => toggleProject(expandKey)}
              presentInTiers={projMeta?.tiers ?? new Set()}
              currentTier={env.tier}
            />
          );
        })}

        {projectNames.length === 0 && (
          <p className="text-sm text-muted-foreground col-span-full">No matched services in this environment.</p>
        )}
      </div>
    </div>
  );
}

const typeColors: Record<string, string> = {
  FRONTEND: "text-blue-400",
  BACKEND: "text-green-400",
  FULLSTACK: "text-purple-400",
  UNKNOWN: "text-zinc-400",
};

function ProjectCard({
  projectName,
  projectType,
  services,
  databases,
  tier,
  isExpanded,
  onToggle,
  presentInTiers,
  currentTier,
}: {
  projectName: string;
  projectType: string;
  services: ServiceInstance[];
  databases: Array<{ host: string; database: string; matchedAtlasCluster?: string }>;
  tier: string;
  isExpanded: boolean;
  onToggle: () => void;
  presentInTiers: Set<string>;
  currentTier: string;
}) {
  const liveCount = services.filter(
    (s) => s.status === "Running" || s.status === "READY" || s.status === "IDLE",
  ).length;
  const hasErrors = services.some((s) => s.status === "ERROR" || s.status === "Failed" || s.status === "CrashLoopBackOff");
  const source = services[0]?.source ?? "eks";

  // Tier presence dots
  const tiers = ["production", "staging", "dev"] as const;

  return (
    <div className="rounded-lg bg-background/80 border border-border/40 overflow-hidden">
      {/* Card header */}
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-accent/30 transition-colors text-left"
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <span className={`w-2 h-2 rounded-full shrink-0 ${
            hasErrors ? "bg-red-500" : liveCount > 0 ? "bg-green-500" : "bg-yellow-500"
          }`} />
          <Link
            href={`/projects/${projectName}`}
            onClick={(e) => e.stopPropagation()}
            className="font-medium text-sm truncate hover:text-primary"
          >
            {projectName}
          </Link>
          <span className={`text-[10px] font-medium ${typeColors[projectType]}`}>{projectType}</span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {/* Tier presence indicator */}
          <div className="flex items-center gap-1" title="Present in tiers">
            {tiers.map((t) => (
              <span
                key={t}
                className={`w-1.5 h-1.5 rounded-full ${
                  presentInTiers.has(t)
                    ? tierColor[t]?.dot ?? "bg-zinc-500"
                    : "bg-zinc-800"
                }`}
                title={t}
              />
            ))}
          </div>
          <span className="text-xs text-muted-foreground">
            {sourceIcon[source]}
          </span>
          <span className="text-xs text-muted-foreground">
            {liveCount}/{services.length}
          </span>
          <svg
            className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${isExpanded ? "rotate-180" : ""}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
          </svg>
        </div>
      </button>

      {/* Expanded detail */}
      {isExpanded && (
        <div className="border-t border-border/30 px-4 py-3 space-y-3">
          {/* Pods */}
          {services.map((svc, i) => (
            <div key={i} className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-2 min-w-0">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDot[svc.status] ?? "bg-zinc-500"}`} />
                <span className="font-mono truncate text-muted-foreground">{svc.podName}</span>
              </div>
              <div className="flex items-center gap-3 text-muted-foreground shrink-0">
                <span className={
                  svc.status === "Running" || svc.status === "READY" ? "text-green-400"
                    : svc.status === "ERROR" || svc.status === "Failed" ? "text-red-400"
                    : "text-yellow-400"
                }>{svc.status}</span>
                {svc.cpuUtil !== undefined && (
                  <span className={svc.cpuUtil > 80 ? "text-red-400" : svc.cpuUtil > 50 ? "text-yellow-400" : "text-green-400"}>
                    CPU {svc.cpuUtil.toFixed(0)}%
                  </span>
                )}
                {svc.memUtil !== undefined && (
                  <span className={svc.memUtil > 80 ? "text-red-400" : svc.memUtil > 50 ? "text-yellow-400" : "text-green-400"}>
                    Mem {svc.memUtil.toFixed(0)}%
                  </span>
                )}
                {svc.restarts > 0 && <span className="text-yellow-400">{svc.restarts}x</span>}
                {svc.namespace && <span className="font-mono">{svc.namespace}</span>}
              </div>
            </div>
          ))}

          {/* Databases */}
          {databases.length > 0 && (
            <div className="pt-2 border-t border-border/20">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">Databases</p>
              {databases.map((db, i) => (
                <div key={i} className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                  <span className="font-mono">{db.host}</span>
                  {db.database && <span className="text-foreground/50">/ {db.database}</span>}
                  {db.matchedAtlasCluster && (
                    <span className="text-emerald-400 text-[10px]">Atlas: {db.matchedAtlasCluster}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Table View ──────────────────────────────
// Cross-environment comparison table

function TableView({ data }: { data: AllEnvironmentsData }) {
  // Build a grid: projects x tiers
  const projectRows = new Map<string, Map<string, ServiceInstance[]>>();

  for (const env of data.environments) {
    for (const svc of env.services) {
      if (svc.project === "unknown") continue;
      if (!projectRows.has(svc.project)) projectRows.set(svc.project, new Map());
      const row = projectRows.get(svc.project)!;
      if (!row.has(env.tier)) row.set(env.tier, []);
      row.get(env.tier)!.push(svc);
    }
  }

  const tiers = data.environments.map((e) => e.tier);
  const sortedProjects = Array.from(projectRows.keys()).sort();

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-card">
            <th className="text-left px-4 py-3 font-medium text-muted-foreground border-b border-border">
              Project
            </th>
            {tiers.map((t) => (
              <th key={t} className="text-left px-4 py-3 font-medium border-b border-border">
                <span className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${tierColor[t]?.dot}`} />
                  <span className={tierColor[t]?.badge.split(" ")[1]}>{t.charAt(0).toUpperCase() + t.slice(1)}</span>
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedProjects.map((proj) => {
            const row = projectRows.get(proj)!;
            return (
              <tr key={proj} className="border-b border-border/50 hover:bg-accent/20">
                <td className="px-4 py-3">
                  <Link href={`/projects/${proj}`} className="font-medium hover:text-primary">
                    {proj}
                  </Link>
                </td>
                {tiers.map((t) => {
                  const services = row.get(t);
                  if (!services || services.length === 0) {
                    return (
                      <td key={t} className="px-4 py-3">
                        <span className="text-xs text-zinc-600">--</span>
                      </td>
                    );
                  }

                  const live = services.filter(
                    (s) => s.status === "Running" || s.status === "READY",
                  ).length;
                  const hasErr = services.some(
                    (s) => s.status === "ERROR" || s.status === "Failed" || s.status === "CrashLoopBackOff",
                  );

                  return (
                    <td key={t} className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${
                          hasErr ? "bg-red-500" : live > 0 ? "bg-green-500" : "bg-yellow-500"
                        }`} />
                        <span className="text-xs">
                          {live}/{services.length} pods
                        </span>
                        <span className="text-[10px] text-muted-foreground font-mono">
                          {sourceIcon[services[0].source]}
                        </span>
                      </div>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
