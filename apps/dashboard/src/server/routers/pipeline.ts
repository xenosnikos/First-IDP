import { z } from "zod";
import { router, protectedProcedure } from "../trpc";
import type { ActionsRun } from "@twizz-idp/core";
import { withGithub } from "../nebula/github-session";

function parseRepoUrl(url: string): { owner: string; repo: string } | null {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

// Read-only over PipelineRun rows. The Argo Workflows engine is gone;
// Phase 3 points this router at GitHub Actions runs (steps/logs come back then).
export const pipelineRouter = router({
  list: protectedProcedure
    .input(z.object({ environmentId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      return ctx.prisma.pipelineRun.findMany({
        where: { environmentId: input.environmentId },
        orderBy: { createdAt: "desc" },
      });
    }),

  // ── GitHub Actions (the CI engine) ────────────────────────────────
  listGithubRuns: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(50).default(30) }).optional())
    .query(async ({ ctx, input }) => {
      const projects = await ctx.prisma.project.findMany({ select: { githubRepoUrl: true } });
      const repos = projects
        .map((p) => parseRepoUrl(p.githubRepoUrl))
        .filter((r): r is { owner: string; repo: string } => r !== null);

      const settled = await Promise.allSettled(
        repos.map((r) => withGithub(ctx.session, (github) => github.listWorkflowRuns(r.owner, r.repo, 15))),
      );
      const runs: ActionsRun[] = settled
        .filter((s): s is PromiseFulfilledResult<ActionsRun[]> => s.status === "fulfilled")
        .flatMap((s) => s.value);

      runs.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
      return runs.slice(0, input?.limit ?? 30);
    }),

  getGithubRun: protectedProcedure
    .input(z.object({ owner: z.string(), repo: z.string(), runId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      return withGithub(ctx.session, (github) => github.getWorkflowRun(input.owner, input.repo, input.runId));
    }),

  getGithubJobLogs: protectedProcedure
    .input(z.object({ owner: z.string(), repo: z.string(), jobId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      return { logs: await withGithub(ctx.session, (github) => github.getJobLogs(input.owner, input.repo, input.jobId)) };
    }),

  listAll: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(30) }).optional())
    .query(async ({ ctx, input }) => {
      return ctx.prisma.pipelineRun.findMany({
        take: input?.limit ?? 30,
        orderBy: { createdAt: "desc" },
        include: {
          environment: {
            include: { project: true },
          },
        },
      });
    }),
});
