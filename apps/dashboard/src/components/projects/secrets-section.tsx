import type { SecretEntry } from "@/server/services/aws";

export function SecretsSection({ secrets }: { secrets: SecretEntry[] }) {
  if (secrets.length === 0) return null;

  return (
    <div className="space-y-4">
      {secrets.map((s) => (
        <SecretCard key={s.name} secret={s} />
      ))}
    </div>
  );
}

function SecretCard({ secret }: { secret: SecretEntry }) {
  const env = secret.name.toLowerCase().includes("prod") ? "production"
    : secret.name.toLowerCase().includes("staging") ? "staging"
    : secret.name.toLowerCase().includes("dev") ? "dev" : "shared";

  const envColor: Record<string, string> = {
    production: "bg-red-500/10 text-red-400",
    staging: "bg-yellow-500/10 text-yellow-400",
    dev: "bg-blue-500/10 text-blue-400",
    shared: "bg-zinc-500/10 text-zinc-400",
  };

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
    <div className="rounded-md border border-border/50 p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="font-mono text-sm font-medium">{secret.name}</span>
        <span className={`text-xs px-2 py-0.5 rounded-full ${envColor[env]}`}>{env}</span>
      </div>
      <div className="space-y-1.5">
        {rows.map(({ key, display, isSensitive, isUri }) => (
          <div key={key} className="flex items-start gap-3 text-xs">
            <span className="font-mono text-muted-foreground min-w-[180px] shrink-0">{key}</span>
            <span className={`font-mono break-all ${
              isSensitive ? "text-yellow-500/70" : isUri ? "text-blue-400/70" : "text-foreground/60"
            }`}>{display}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
