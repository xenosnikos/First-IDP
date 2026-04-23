import { z } from "zod";
import { router, protectedProcedure } from "../trpc";
import { createEnvironmentSchema, teardownEnvironmentSchema } from "@twizz-idp/shared";
import { PIPELINE_TEMPLATES, URL_PATTERNS } from "@twizz-idp/shared";
import { argoService } from "../services/argo";

export const environmentRouter = router({
  list: protectedProcedure
    .input(z.object({ projectId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      return ctx.prisma.environment.findMany({
        where: { projectId: input.projectId },
        orderBy: { createdAt: "desc" },
        include: { deployConfig: true, databaseConfig: true },
      });
    }),

  get: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      return ctx.prisma.environment.findUniqueOrThrow({
        where: { id: input.id },
        include: {
          deployConfig: true,
          databaseConfig: true,
          pipelineRuns: { orderBy: { createdAt: "desc" }, take: 5 },
          project: true,
        },
      });
    }),

  create: protectedProcedure
    .input(createEnvironmentSchema)
    .mutation(async ({ ctx, input }) => {
      const project = await ctx.prisma.project.findUniqueOrThrow({
        where: { id: input.projectId },
      });

      const sanitizedBranch = input.branch.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
      const namespace = `${input.tier.toLowerCase()}-${project.name}-${sanitizedBranch}`;
      const serviceHost = URL_PATTERNS[input.tier](project.name, sanitizedBranch);

      const environment = await ctx.prisma.environment.create({
        data: {
          projectId: input.projectId,
          tier: input.tier,
          namespace,
          deployConfig: {
            create: {
              branch: input.branch,
              commitSha: input.commitSha,
              replicas: input.replicas,
              cpuLimit: input.cpuLimit,
              memLimit: input.memLimit,
              secretSetName: input.secretSet,
            },
          },
          databaseConfig: {
            create: { strategy: input.dbStrategy },
          },
        },
        include: { deployConfig: true, databaseConfig: true },
      });

      // Trigger Argo Workflow
      const workflowName = await argoService.submitWorkflow(
        PIPELINE_TEMPLATES.BACKEND_DEPLOY,
        namespace,
        {
          repo: project.githubRepoUrl.replace("https://github.com/", ""),
          branch: input.branch,
          commitSha: input.commitSha,
          env: input.tier.toLowerCase(),
          namespace,
          dbStrategy: input.dbStrategy.toLowerCase(),
          secretSetName: input.secretSet ?? "",
          replicas: String(input.replicas),
          cpuLimit: input.cpuLimit,
          memLimit: input.memLimit,
          serviceHost,
        },
      );

      // Record pipeline run
      const pipelineRun = await ctx.prisma.pipelineRun.create({
        data: {
          environmentId: environment.id,
          argoWorkflowName: workflowName,
          status: "RUNNING",
          startedAt: new Date(),
        },
      });

      return { ...environment, pipelineRunId: pipelineRun.id };
    }),

  delete: protectedProcedure
    .input(teardownEnvironmentSchema)
    .mutation(async ({ ctx, input }) => {
      const env = await ctx.prisma.environment.findUniqueOrThrow({
        where: { id: input.envId },
        include: { deployConfig: true },
      });

      // TODO: Submit teardown workflow (helm uninstall + namespace delete)
      // For now just mark as destroying
      return ctx.prisma.environment.update({
        where: { id: input.envId },
        data: { status: "DESTROYING" },
      });
    }),
});
