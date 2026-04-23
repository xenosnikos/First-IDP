import { z } from "zod";
import { router, protectedProcedure } from "../trpc";
import { triggerPipelineSchema, pipelineStatusSchema } from "@twizz-idp/shared";
import { argoService } from "../services/argo";

export const pipelineRouter = router({
  trigger: protectedProcedure
    .input(triggerPipelineSchema)
    .mutation(async ({ ctx, input }) => {
      const workflowName = await argoService.submitWorkflow(
        input.templateName,
        "argo",
        input.params ?? {},
      );

      return ctx.prisma.pipelineRun.create({
        data: {
          environmentId: input.environmentId,
          argoWorkflowName: workflowName,
          status: "RUNNING",
          startedAt: new Date(),
        },
      });
    }),

  getStatus: protectedProcedure
    .input(pipelineStatusSchema)
    .query(async ({ ctx, input }) => {
      const run = await ctx.prisma.pipelineRun.findUniqueOrThrow({
        where: { id: input.pipelineRunId },
        include: {
          environment: {
            include: { project: true, deployConfig: true },
          },
        },
      });

      // Poll live status from Argo
      let workflow;
      try {
        workflow = await argoService.getWorkflow(run.argoWorkflowName);
      } catch {
        // Argo unreachable -- return DB state
        return {
          ...run,
          steps: [],
          outputs: undefined,
        };
      }

      // Sync status back to DB
      const dbStatus = workflow.phase === "Succeeded" ? "SUCCEEDED"
        : workflow.phase === "Failed" || workflow.phase === "Error" ? "FAILED"
        : workflow.phase === "Running" ? "RUNNING"
        : "PENDING";

      if (run.status !== dbStatus) {
        await ctx.prisma.pipelineRun.update({
          where: { id: run.id },
          data: {
            status: dbStatus as any,
            completedAt: workflow.finishedAt ? new Date(workflow.finishedAt) : undefined,
          },
        });
      }

      return {
        ...run,
        status: dbStatus,
        steps: workflow.steps,
        outputs: workflow.outputs,
      };
    }),

  getStepLogs: protectedProcedure
    .input(z.object({
      pipelineRunId: z.string().cuid(),
      stepId: z.string(),
    }))
    .query(async ({ ctx, input }) => {
      const run = await ctx.prisma.pipelineRun.findUniqueOrThrow({
        where: { id: input.pipelineRunId },
      });

      // Get workflow to resolve stepId -> podName
      const workflow = await argoService.getWorkflow(run.argoWorkflowName);
      const step = workflow.steps.find((s) => s.id === input.stepId);

      if (!step?.podName) {
        return { logs: "Step not found or not yet started." };
      }

      const logs = await argoService.getStepLogs(run.argoWorkflowName, step.podName);
      return { logs };
    }),

  getLogs: protectedProcedure
    .input(z.object({ pipelineRunId: z.string().cuid(), stepName: z.string().optional() }))
    .query(async ({ ctx, input }) => {
      const run = await ctx.prisma.pipelineRun.findUniqueOrThrow({
        where: { id: input.pipelineRunId },
      });

      const logs = await argoService.getWorkflowLogs(
        run.argoWorkflowName,
        input.stepName,
      );

      return { logs };
    }),

  list: protectedProcedure
    .input(z.object({ environmentId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      return ctx.prisma.pipelineRun.findMany({
        where: { environmentId: input.environmentId },
        orderBy: { createdAt: "desc" },
      });
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
