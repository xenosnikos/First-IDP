import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "../trpc";
import { observerStatus } from "../nebula/observer";

// Observer status only. The run itself streams over /api/observer (a Route
// Handler) because tRPC's batch link cannot stream tokens. Queries only.
export const observerRouter = router({
  status: protectedProcedure.query(async ({ ctx }) => {
    const login = (ctx.session as { login?: string }).login;
    if (!login) throw new TRPCError({ code: "UNAUTHORIZED", message: "no GitHub login on session" });
    return observerStatus(ctx.prisma, login);
  }),
});
