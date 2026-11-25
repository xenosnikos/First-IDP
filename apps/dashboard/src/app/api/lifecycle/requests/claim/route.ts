// POST /api/lifecycle/requests/claim — the plo-dispatch CronJob takes the
// oldest pending on-demand request (docs/NEBULA.md §N9). Machine endpoint:
// bearer LIFECYCLE_INGEST_TOKEN, no session, NOT in the middleware matcher.
// Logic (auth, expiry, the atomic claim, AuditLog) is in server/nebula/lifecycle-ingest.
import { prisma } from "@twizz-idp/db";
import { handleClaim, prismaLifecycleStore } from "@/server/nebula/lifecycle-ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return handleClaim(req, { store: prismaLifecycleStore(prisma) });
}
