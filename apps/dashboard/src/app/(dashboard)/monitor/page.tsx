import type { Metadata } from "next";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { isOperator } from "@/lib/nebula/operators";
import { MonitorView } from "@/components/monitor/monitor-view";

export const metadata: Metadata = { title: "Monitor" };
export const dynamic = "force-dynamic";

// Monitor (docs/NEBULA.md §N6): prod + staging at a glance, refreshed every
// minute. Read-only for everyone signed in; resizing links to /capacity.
// `?tier=staging|production` opens that tier (linked from /lifecycle → Environments).
export default async function MonitorPage({ searchParams }: { searchParams: Promise<{ tier?: string | string[] }> }) {
  const session = await auth();
  if (!session?.user) redirect("/");
  const login = (session as { login?: string }).login ?? "";
  const { tier } = await searchParams;
  return <MonitorView operator={isOperator(login)} initialTier={tier === "staging" ? "staging" : "production"} />;
}
