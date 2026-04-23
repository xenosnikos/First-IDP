import { z } from "zod";

export const triggerPipelineSchema = z.object({
  environmentId: z.string().cuid(),
  templateName: z.string().min(1),
  params: z.record(z.string()).optional(),
});

export const pipelineStatusSchema = z.object({
  pipelineRunId: z.string().cuid(),
});

export type TriggerPipelineInput = z.infer<typeof triggerPipelineSchema>;
export type PipelineStatusInput = z.infer<typeof pipelineStatusSchema>;

export type PipelineStep = {
  name: string;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  startedAt?: string;
  completedAt?: string;
  logUrl?: string;
};
