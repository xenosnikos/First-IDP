"use client";

import type { DeployFormData } from "./deploy-wizard";

const CPU_OPTIONS = ["250m", "500m", "1000m", "2000m"];
const MEM_OPTIONS = ["256Mi", "512Mi", "1Gi", "2Gi"];
const DB_STRATEGIES = [
  { id: "SHARED" as const, label: "Shared", desc: "Use shared database for this tier" },
  { id: "CLONE" as const, label: "Clone", desc: "Clone production data into isolated DB" },
  { id: "NONE" as const, label: "None", desc: "No database provisioning" },
];

export function StepResources({
  value,
  onChange,
}: {
  value: DeployFormData;
  onChange: (updates: Partial<DeployFormData>) => void;
}) {
  return (
    <div>
      <h3 className="text-lg font-semibold mb-1">Configure Resources</h3>
      <p className="text-sm text-muted-foreground mb-6">
        Set resource limits and database strategy.
      </p>

      <div className="space-y-6">
        {/* Replicas */}
        <div>
          <label className="text-sm font-medium mb-2 block">Replicas</label>
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={1}
              max={10}
              value={value.replicas}
              onChange={(e) => onChange({ replicas: Number(e.target.value) })}
              className="flex-1 accent-primary"
            />
            <span className="w-8 text-center font-mono text-sm">{value.replicas}</span>
          </div>
        </div>

        {/* CPU + Memory */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-sm font-medium mb-2 block">CPU Limit</label>
            <div className="flex gap-1.5">
              {CPU_OPTIONS.map((opt) => (
                <button
                  key={opt}
                  onClick={() => onChange({ cpuLimit: opt })}
                  className={`flex-1 px-2 py-2 text-xs font-mono rounded-md border transition-colors ${
                    value.cpuLimit === opt
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border hover:border-primary/30"
                  }`}
                >
                  {opt}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-sm font-medium mb-2 block">Memory Limit</label>
            <div className="flex gap-1.5">
              {MEM_OPTIONS.map((opt) => (
                <button
                  key={opt}
                  onClick={() => onChange({ memLimit: opt })}
                  className={`flex-1 px-2 py-2 text-xs font-mono rounded-md border transition-colors ${
                    value.memLimit === opt
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border hover:border-primary/30"
                  }`}
                >
                  {opt}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Database strategy */}
        <div>
          <label className="text-sm font-medium mb-2 block">Database Strategy</label>
          <div className="grid grid-cols-3 gap-2">
            {DB_STRATEGIES.map((s) => (
              <button
                key={s.id}
                onClick={() => onChange({ dbStrategy: s.id })}
                className={`rounded-lg border p-3 text-left transition-colors ${
                  value.dbStrategy === s.id
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-primary/30"
                }`}
              >
                <p className="text-sm font-medium">{s.label}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{s.desc}</p>
              </button>
            ))}
          </div>
        </div>

        {/* Secret set */}
        <div>
          <label className="text-sm font-medium mb-2 block">Secret Set (optional)</label>
          <input
            type="text"
            value={value.secretSet}
            onChange={(e) => onChange({ secretSet: e.target.value })}
            placeholder="e.g. prod/moly/backend"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm font-mono placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <p className="text-xs text-muted-foreground mt-1">
            AWS Secrets Manager key to inject as environment variables
          </p>
        </div>
      </div>
    </div>
  );
}
