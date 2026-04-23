import { z } from "zod";

export const environmentTierSchema = z.enum([
  "DEV",
  "QA",
  "STAGING",
  "PREVIEW",
  "PRODUCTION",
]);

export const dbStrategySchema = z.enum(["CLONE", "SHARED", "NONE"]);

export const createEnvironmentSchema = z.object({
  projectId: z.string().cuid(),
  tier: environmentTierSchema,
  branch: z.string().min(1),
  commitSha: z.string().min(7).max(40),
  dbStrategy: dbStrategySchema.default("SHARED"),
  secretSet: z.string().optional(),
  replicas: z.number().int().min(1).max(10).default(1),
  cpuLimit: z.string().default("500m"),
  memLimit: z.string().default("512Mi"),
});

export const teardownEnvironmentSchema = z.object({
  envId: z.string().cuid(),
});

export type CreateEnvironmentInput = z.infer<typeof createEnvironmentSchema>;
export type TeardownEnvironmentInput = z.infer<typeof teardownEnvironmentSchema>;
export type EnvironmentTier = z.infer<typeof environmentTierSchema>;
export type DbStrategy = z.infer<typeof dbStrategySchema>;
