import { z } from "zod";

export const createProjectSchema = z.object({
  githubRepoUrl: z.string().url(),
  name: z.string().min(1).max(100),
  type: z.enum(["FRONTEND", "BACKEND", "FULLSTACK", "UNKNOWN"]),
  defaultBranch: z.string().default("main"),
});

export const detectProjectSchema = z.object({
  repoUrl: z.string().url(),
  branch: z.string().min(1),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type DetectProjectInput = z.infer<typeof detectProjectSchema>;

export type DetectProjectResult = {
  type: "FRONTEND" | "BACKEND" | "FULLSTACK" | "UNKNOWN";
  deps: Record<string, string>;
  hasDockerfile: boolean;
  hasVercelConfig: boolean;
};
