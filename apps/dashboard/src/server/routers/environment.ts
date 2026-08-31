import { z } from "zod";
import { router, protectedProcedure } from "../trpc";

// Read-only: environments are created and destroyed by GitOps (Argo CD
// ApplicationSets reacting to PRs), never from the dashboard.
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
});
