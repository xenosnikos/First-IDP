import { z } from "zod";
import { environmentTierSchema } from "./environment";

export const createReleaseSchema = z.object({
  projectId: z.string().cuid(),
  version: z.string().min(1),
  targetTier: environmentTierSchema,
  serviceIds: z.array(z.string().cuid()).min(1),
});

export const promoteReleaseSchema = z.object({
  releaseId: z.string().cuid(),
  targetTier: environmentTierSchema,
});

export const releaseCheckOverrideSchema = z.object({
  checkId: z.string().cuid(),
  reason: z.string().min(10, "Override reason must be at least 10 characters"),
});

export type CreateReleaseInput = z.infer<typeof createReleaseSchema>;
export type PromoteReleaseInput = z.infer<typeof promoteReleaseSchema>;
export type ReleaseCheckOverrideInput = z.infer<typeof releaseCheckOverrideSchema>;
