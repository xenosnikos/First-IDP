import { z } from "zod";
import { router, protectedProcedure } from "../trpc";
import { lifecycleAdvisories, lifecycleHistory, lifecycleOverview, lifecyclePreview } from "../nebula/lifecycle";

// Lifecycle (docs/NEBULA.md §N9). QUERIES ONLY: what the Platform Lifecycle
// Orchestrator last reported (schedule, tiers, advisories, the bundle preview
// and its history), read from the snapshots PLO POSTs to /api/lifecycle/ingest.
// Any signed-in user may read it. Every sub-source failure is returned as
// data (`{ error }`), never thrown. The operator writes (request a run, create
// the preview, smoke, deploy to staging, sign off) are gated in `actions`.
export const lifecycleRouter = router({
  /** Header counts, schedule with next runs, tiers and stale flags.
   * `components: false` returns the per-tier counts without the rows. */
  overview: protectedProcedure
    .input(z.object({ components: z.boolean().default(true) }).optional())
    .query(({ ctx, input }) => lifecycleOverview(ctx.prisma, { components: input?.components ?? true })),

  /** The latest CVE scan: KEV first, with "new since the last scan". */
  advisories: protectedProcedure.query(({ ctx }) => lifecycleAdvisories(ctx.prisma)),

  /** The bundle's preview state machine, its envs, smoke results and what may be done next. */
  preview: protectedProcedure.query(({ ctx }) => lifecyclePreview(ctx.prisma)),

  /** Recent snapshots and on-demand requests, newest first. */
  history: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }).optional())
    .query(({ ctx, input }) => lifecycleHistory(ctx.prisma, input?.limit ?? 50)),
});
