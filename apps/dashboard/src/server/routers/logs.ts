import { z } from "zod";
import { router, protectedProcedure } from "../trpc";
import { awsService } from "../services/aws";

export const logsRouter = router({
  getPodLogs: protectedProcedure
    .input(
      z.object({
        clusterName: z.string(),
        namespace: z.string(),
        podName: z.string().optional(),
        containerName: z.string().optional(),
        startTime: z.number(),
        endTime: z.number(),
        filterPattern: z.string().optional(),
        limit: z.number().int().min(1).max(2000).default(500),
      }),
    )
    .query(async ({ input }) => {
      return awsService.getPodLogs(input);
    }),
});
