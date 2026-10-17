import { z } from "zod";
import { router, protectedProcedure } from "../trpc";
import { monitorSnapshot } from "../nebula/monitor";
import { MONITOR_TIERS, MONITOR_WINDOWS } from "../nebula/monitor-model";

// Monitor (docs/NEBULA.md §N6). QUERIES ONLY: one consolidated snapshot per
// Moly cluster (traffic, CPU/memory, pods, node headroom, database). Any
// signed-in user may read it; resizing is on /capacity (operators, gated).
export const monitorRouter = router({
  snapshot: protectedProcedure
    .input(z.object({ tier: z.enum(MONITOR_TIERS), window: z.enum(MONITOR_WINDOWS) }))
    .query(({ input }) => monitorSnapshot(input.tier, input.window)),
});
