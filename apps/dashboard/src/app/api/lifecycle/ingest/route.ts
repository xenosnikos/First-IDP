// POST /api/lifecycle/ingest — one PLO snapshot (docs/NEBULA.md §N9).
// Machine endpoint: bearer LIFECYCLE_INGEST_TOKEN, no session, deliberately
// NOT in the middleware matcher. All logic (auth, 4 MB cap before parsing,
// Zod, idempotent store, retention, AuditLog) is in server/nebula/lifecycle-ingest.
import { prisma } from "@twizz-idp/db";
import { handleIngest, prismaLifecycleStore } from "@/server/nebula/lifecycle-ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return handleIngest(req, { store: prismaLifecycleStore(prisma) });
}
