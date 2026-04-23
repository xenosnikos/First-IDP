import { z } from "zod";
import { router, protectedProcedure } from "../trpc";
import { createReleaseSchema, promoteReleaseSchema } from "@twizz-idp/shared";
import { PIPELINE_TEMPLATES, CHECK_IDS } from "@twizz-idp/shared";
import { argoService } from "../services/argo";

export const releaseRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    return ctx.prisma.release.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        project: true,
        services: true,
        checks: true,
        _count: { select: { checks: true } },
      },
    });
  }),

  get: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      return ctx.prisma.release.findUniqueOrThrow({
        where: { id: input.id },
        include: {
          project: true,
          services: true,
          document: { include: { sections: { orderBy: { sortOrder: "asc" } } } },
          checks: { orderBy: { createdAt: "asc" } },
        },
      });
    }),

  create: protectedProcedure
    .input(createReleaseSchema)
    .mutation(async ({ ctx, input }) => {
      const release = await ctx.prisma.release.create({
        data: {
          projectId: input.projectId,
          version: input.version,
          targetTier: input.targetTier,
          status: "DRAFT",
        },
      });

      // Seed check entries for all defined checks
      await ctx.prisma.releaseCheck.createMany({
        data: CHECK_IDS.map((check) => ({
          releaseId: release.id,
          checkId: check.id,
          gateLevel: check.gate as any,
          status: "PENDING",
        })),
      });

      return release;
    }),

  promote: protectedProcedure
    .input(promoteReleaseSchema)
    .mutation(async ({ ctx, input }) => {
      // Verify all P0 checks passed
      const p0Checks = await ctx.prisma.releaseCheck.findMany({
        where: { releaseId: input.releaseId, gateLevel: "P0" },
      });

      const failedP0 = p0Checks.filter((c) => c.status === "FAIL");
      if (failedP0.length > 0) {
        throw new Error(
          `Cannot promote: ${failedP0.length} P0 checks failed (${failedP0.map((c) => c.checkId).join(", ")})`,
        );
      }

      const release = await ctx.prisma.release.findUniqueOrThrow({
        where: { id: input.releaseId },
        include: { services: true },
      });

      // Submit promotion workflow
      const imageUri = release.services[0]?.imageUri ?? "latest";
      const targetNamespace = input.targetTier.toLowerCase();

      await argoService.submitWorkflow(
        PIPELINE_TEMPLATES.PROMOTE_RELEASE,
        targetNamespace,
        {
          releaseId: release.id,
          sourceNamespace: release.sourceEnvId ?? "",
          targetTier: input.targetTier,
          targetNamespace,
          imageUri,
        },
      );

      return ctx.prisma.release.update({
        where: { id: input.releaseId },
        data: { targetTier: input.targetTier, status: "CHECKS_RUNNING" },
      });
    }),

  rollback: protectedProcedure
    .input(z.object({ releaseId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.prisma.release.update({
        where: { id: input.releaseId },
        data: { status: "ROLLED_BACK" },
      });
    }),
});
