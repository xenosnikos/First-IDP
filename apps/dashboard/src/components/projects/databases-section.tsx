import type { DbConnection } from "@/server/services/introspect";

export function DatabasesSection({ connections }: { connections: DbConnection[] }) {
  if (connections.length === 0) return null;

  return (
    <div>
      <div className="space-y-3">
        {connections.map((db, i) => (
          <DbConnectionCard key={i} db={db} />
        ))}
      </div>
    </div>
  );
}

function DbConnectionCard({ db }: { db: DbConnection }) {
  const tierColor: Record<string, string> = {
    production: "bg-red-500/10 text-red-400",
    staging: "bg-yellow-500/10 text-yellow-400",
    dev: "bg-blue-500/10 text-blue-400",
    unknown: "bg-zinc-500/10 text-zinc-400",
  };

  return (
    <div className="rounded-md border border-border/50 p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className={`text-xs px-2 py-0.5 rounded-full ${tierColor[db.environment]}`}>{db.environment}</span>
          <span className="font-mono text-sm">{db.database || "(default)"}</span>
        </div>
        {db.matchedAtlasCluster && (
          <span className="text-xs text-muted-foreground">Atlas: {db.matchedAtlasCluster}</span>
        )}
      </div>
      <div className="text-xs text-muted-foreground space-y-1">
        <p>Host: <span className="font-mono text-foreground/70">{db.host}</span></p>
        <p>Source: <span className="font-mono text-foreground/70">{db.secretName}</span> → <span className="font-mono">{db.secretKey}</span></p>
      </div>
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
