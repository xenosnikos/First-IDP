import type { ProjectIntrospection } from "@/server/services/introspect";

export function StackDetection({ detection, repo }: {
  detection: ProjectIntrospection["detection"];
  repo: ProjectIntrospection["repo"];
}) {
  return (
    <div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <InfoCard label="Language" value={repo.language ?? "Unknown"} />
        <InfoCard label="Framework" value={detection.framework ?? "None"} />
        <InfoCard label="Runtime" value={detection.runtime ?? "Unknown"} />
        <InfoCard label="Branch" value={repo.defaultBranch} />
        <InfoCard label="Dockerfile" value={detection.hasDockerfile ? "Yes" : "No"} />
        <InfoCard label="Vercel Config" value={detection.hasVercelConfig ? "Yes" : "No"} />
        <InfoCard label="Dependencies" value={`${Object.keys(detection.deps).length}`} />
      </div>
      {Object.keys(detection.deps).length > 0 && (
        <details className="mt-4">
          <summary className="text-sm text-muted-foreground cursor-pointer hover:text-foreground">
            View dependencies
          </summary>
          <div className="mt-2 grid grid-cols-2 md:grid-cols-3 gap-1 text-xs font-mono text-muted-foreground max-h-48 overflow-y-auto">
            {Object.entries(detection.deps).sort(([a], [b]) => a.localeCompare(b)).map(([n, v]) => (
              <span key={n}>{n} <span className="text-foreground/40">{v}</span></span>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

export function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-muted/50 px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium mt-0.5">{value}</p>
    </div>
  );
}
