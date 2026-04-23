"use client";

import { URL_PATTERNS } from "@twizz-idp/shared";

const TIERS = [
  {
    id: "DEV" as const,
    label: "Development",
    description: "Isolated dev environment with branch-based URL",
    color: "border-blue-500/30 bg-blue-500/5",
    activeColor: "border-blue-500 bg-blue-500/10",
    dot: "bg-blue-500",
  },
  {
    id: "QA" as const,
    label: "QA",
    description: "Testing environment for QA validation",
    color: "border-cyan-500/30 bg-cyan-500/5",
    activeColor: "border-cyan-500 bg-cyan-500/10",
    dot: "bg-cyan-500",
  },
  {
    id: "STAGING" as const,
    label: "Staging",
    description: "Pre-production mirror for final validation",
    color: "border-yellow-500/30 bg-yellow-500/5",
    activeColor: "border-yellow-500 bg-yellow-500/10",
    dot: "bg-yellow-500",
  },
  {
    id: "PRODUCTION" as const,
    label: "Production",
    description: "Live production environment",
    color: "border-red-500/30 bg-red-500/5",
    activeColor: "border-red-500 bg-red-500/10",
    dot: "bg-red-500",
    warning: true,
  },
];

export function StepTier({
  projectName,
  value,
  onChange,
}: {
  projectName: string;
  value: string;
  onChange: (tier: "DEV" | "QA" | "STAGING" | "PRODUCTION") => void;
}) {
  function getUrlPreview(tier: string): string {
    try {
      const patterns = URL_PATTERNS as Record<string, (...args: any[]) => string>;
      const fn = patterns[tier];
      if (!fn) return "";
      if (tier === "DEV") return fn(projectName.toLowerCase(), "branch");
      if (tier === "QA") return fn(projectName.toLowerCase());
      if (tier === "STAGING") return fn(projectName.toLowerCase());
      if (tier === "PREVIEW") return fn(1);
      if (tier === "PRODUCTION") return fn(projectName.toLowerCase());
      return "";
    } catch { return ""; }
  }

  return (
    <div>
      <h3 className="text-lg font-semibold mb-1">Choose Environment</h3>
      <p className="text-sm text-muted-foreground mb-6">
        Select the target environment tier for this deployment.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {TIERS.map((tier) => {
          const isActive = value === tier.id;
          const url = getUrlPreview(tier.id);

          return (
            <button
              key={tier.id}
              onClick={() => onChange(tier.id)}
              className={`rounded-lg border p-4 text-left transition-colors ${
                isActive ? tier.activeColor : `${tier.color} hover:opacity-80`
              }`}
            >
              <div className="flex items-center gap-2.5 mb-2">
                <span className={`w-2.5 h-2.5 rounded-full ${tier.dot}`} />
                <span className="font-semibold text-sm">{tier.label}</span>
                {tier.warning && (
                  <span className="text-[10px] bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded font-medium">
                    CAUTION
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground mb-3">{tier.description}</p>
              {url && (
                <p className="text-xs font-mono text-primary/70 truncate">{url}</p>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
