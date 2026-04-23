"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";
import { StepBranch } from "./step-branch";
import { StepTier } from "./step-tier";
import { StepResources } from "./step-resources";
import { StepReview } from "./step-review";

export type DeployFormData = {
  branch: string;
  commitSha: string;
  tier: "DEV" | "QA" | "STAGING" | "PRODUCTION" | "";
  replicas: number;
  cpuLimit: string;
  memLimit: string;
  dbStrategy: "CLONE" | "SHARED" | "NONE";
  secretSet: string;
};

const STEPS = ["Branch", "Environment", "Resources", "Review"] as const;

export function DeployWizard({
  projectId,
  projectName,
  owner,
}: {
  projectId: string;
  projectName: string;
  owner: string;
}) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<DeployFormData>({
    branch: "",
    commitSha: "",
    tier: "",
    replicas: 1,
    cpuLimit: "500m",
    memLimit: "512Mi",
    dbStrategy: "SHARED",
    secretSet: "",
  });

  const createEnv = trpc.environment.create.useMutation({
    onSuccess: (data) => {
      router.push(`/pipelines/${data.pipelineRunId}`);
    },
  });

  const canNext =
    step === 0 ? form.branch !== "" && form.commitSha !== ""
    : step === 1 ? form.tier !== ""
    : step === 2 ? true
    : true;

  function handleDeploy() {
    if (form.tier === "") return;
    createEnv.mutate({
      projectId,
      branch: form.branch,
      commitSha: form.commitSha,
      tier: form.tier as any,
      replicas: form.replicas,
      cpuLimit: form.cpuLimit,
      memLimit: form.memLimit,
      dbStrategy: form.dbStrategy,
      secretSet: form.secretSet || undefined,
    });
  }

  return (
    <div className="max-w-3xl mx-auto">
      {/* Step indicator */}
      <div className="flex items-center gap-2 mb-8">
        {STEPS.map((label, i) => (
          <div key={label} className="flex items-center gap-2">
            <button
              onClick={() => i < step && setStep(i)}
              disabled={i > step}
              className={`flex items-center gap-2 text-sm font-medium transition-colors ${
                i === step ? "text-primary" : i < step ? "text-foreground cursor-pointer" : "text-muted-foreground/40"
              }`}
            >
              <span className={`w-7 h-7 rounded-full flex items-center justify-center text-xs border ${
                i === step ? "border-primary bg-primary/10 text-primary"
                : i < step ? "border-green-500 bg-green-500/10 text-green-400"
                : "border-border text-muted-foreground/40"
              }`}>
                {i < step ? (
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                ) : (
                  i + 1
                )}
              </span>
              {label}
            </button>
            {i < STEPS.length - 1 && (
              <div className={`w-8 h-px ${i < step ? "bg-green-500/50" : "bg-border"}`} />
            )}
          </div>
        ))}
      </div>

      {/* Step content */}
      <div className="rounded-lg border border-border bg-card p-6">
        {step === 0 && (
          <StepBranch
            owner={owner}
            repo={projectName}
            value={{ branch: form.branch, commitSha: form.commitSha }}
            onChange={(branch, commitSha) => setForm({ ...form, branch, commitSha })}
          />
        )}
        {step === 1 && (
          <StepTier
            projectName={projectName}
            value={form.tier}
            onChange={(tier) => setForm({ ...form, tier })}
          />
        )}
        {step === 2 && (
          <StepResources
            value={form}
            onChange={(updates) => setForm({ ...form, ...updates })}
          />
        )}
        {step === 3 && (
          <StepReview form={form} projectName={projectName} />
        )}
      </div>

      {/* Error */}
      {createEnv.error && (
        <div className="mt-4 rounded-lg bg-destructive/10 border border-destructive/20 p-3">
          <p className="text-destructive text-sm">{createEnv.error.message}</p>
        </div>
      )}

      {/* Navigation */}
      <div className="flex items-center justify-between mt-6">
        <button
          onClick={() => setStep(Math.max(0, step - 1))}
          disabled={step === 0}
          className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Back
        </button>

        {step < STEPS.length - 1 ? (
          <button
            onClick={() => setStep(step + 1)}
            disabled={!canNext}
            className="px-6 py-2.5 text-sm font-medium rounded-lg bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Continue
          </button>
        ) : (
          <button
            onClick={handleDeploy}
            disabled={createEnv.isPending}
            className="px-6 py-2.5 text-sm font-medium rounded-lg bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-60"
          >
            {createEnv.isPending ? "Deploying..." : "Deploy"}
          </button>
        )}
      </div>
    </div>
  );
}
