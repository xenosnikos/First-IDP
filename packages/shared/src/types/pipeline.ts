import { z } from "zod";

export const pipelineStatusSchema = z.object({
  pipelineRunId: z.string().cuid(),
});

export type PipelineStatusInput = z.infer<typeof pipelineStatusSchema>;

/** A single step in a pipeline run (Argo historically; GitHub Actions jobs going forward). */
export type WorkflowStep = {
  id: string;
  name: string;
  phase: "Pending" | "Running" | "Succeeded" | "Failed" | "Skipped" | "Error";
  startedAt?: string;
  finishedAt?: string;
  message?: string;
  templateName?: string;
  podName?: string;
};

export type PipelineStep = {
  name: string;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  startedAt?: string;
  completedAt?: string;
  logUrl?: string;
};
