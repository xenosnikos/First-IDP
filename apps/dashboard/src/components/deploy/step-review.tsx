"use client";

import type { DeployFormData } from "./deploy-wizard";

const tierColor: Record<string, string> = {
  DEV: "bg-blue-500/15 text-blue-400",
  QA: "bg-cyan-500/15 text-cyan-400",
  STAGING: "bg-yellow-500/15 text-yellow-400",
  PRODUCTION: "bg-red-500/15 text-red-400",
};

export function StepReview({
  form,
  projectName,
}: {
  form: DeployFormData;
  projectName: string;
}) {
  return (
    <div>
      <h3 className="text-lg font-semibold mb-1">Review & Deploy</h3>
      <p className="text-sm text-muted-foreground mb-6">
        Verify the configuration before deploying.
      </p>

      <div className="rounded-lg border border-border divide-y divide-border">
        <Row label="Project" value={projectName} />
        <Row label="Branch" value={form.branch} mono>
          <span className="text-muted-foreground ml-2">({form.commitSha.slice(0, 7)})</span>
        </Row>
        <Row label="Environment">
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${tierColor[form.tier] ?? ""}`}>
            {form.tier}
          </span>
        </Row>
        <Row label="Replicas" value={String(form.replicas)} />
        <Row label="CPU Limit" value={form.cpuLimit} mono />
        <Row label="Memory Limit" value={form.memLimit} mono />
        <Row label="DB Strategy" value={form.dbStrategy} />
        {form.secretSet && <Row label="Secret Set" value={form.secretSet} mono />}
      </div>

      {form.tier === "PRODUCTION" && (
        <div className="mt-4 rounded-lg bg-red-500/10 border border-red-500/20 p-3 flex items-start gap-2">
          <svg className="w-4 h-4 text-red-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
          <p className="text-sm text-red-400">
            You are deploying to <strong>production</strong>. This will affect live users.
          </p>
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  mono,
  children,
}: {
  label: string;
  value?: string;
  mono?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between px-4 py-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={mono ? "font-mono" : "font-medium"}>
        {value}
        {children}
      </span>
    </div>
  );
}
