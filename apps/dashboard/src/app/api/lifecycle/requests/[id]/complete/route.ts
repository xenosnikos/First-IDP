// POST /api/lifecycle/requests/:id/complete — plo-dispatch reports the result
// of a request it claimed (docs/NEBULA.md §N9). Machine endpoint: bearer
// LIFECYCLE_INGEST_TOKEN, no session, NOT in the middleware matcher.
// Logic is in server/nebula/lifecycle-ingest.
import { prisma } from "@twizz-idp/db";
import { handleComplete, prismaLifecycleStore } from "@/server/nebula/lifecycle-ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  return handleComplete(req, id, { store: prismaLifecycleStore(prisma) });
}
