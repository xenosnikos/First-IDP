import { NextResponse } from "next/server";

// Liveness/readiness for the in-cluster deployment (nebula.prv.twizz.com).
// Deliberately dependency-free: a DB or GitHub outage must not restart pods —
// the Environments page reports those honestly per row instead.
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ status: "ok", service: "nebula", ts: new Date().toISOString() }, { headers: { "cache-control": "no-store" } });
}
