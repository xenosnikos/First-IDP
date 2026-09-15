import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "../trpc";
import { observerStatus } from "../nebula/observer";
import { configuratorStatus } from "../nebula/configurator";

// Observer status only. The run itself streams over /api/observer (a Route
// Handler) because tRPC's batch link cannot stream tokens. Queries only.
export const observerRouter = router({
  status: protectedProcedure.query(async ({ ctx }) => {
    const login = (ctx.session as { login?: string }).login;
    if (!login) throw new TRPCError({ code: "UNAUTHORIZED", message: "no GitHub login on session" });
    return observerStatus(ctx.prisma, login);
  }),

  /** Configurator budget/config words (runs stream via /api/configurator). */
  configuratorStatus: protectedProcedure.query(async ({ ctx }) => {
    const login = (ctx.session as { login?: string }).login;
    if (!login) throw new TRPCError({ code: "UNAUTHORIZED", message: "no GitHub login on session" });
    return configuratorStatus(ctx.prisma, login);
  }),
});
