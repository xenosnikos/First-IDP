import type { Metadata } from "next";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { isOperator } from "@/lib/nebula/operators";
import { LifecycleView } from "@/components/lifecycle/lifecycle-view";

export const metadata: Metadata = { title: "Lifecycle" };
export const dynamic = "force-dynamic";

// Lifecycle (docs/NEBULA.md §N9): what the Platform Lifecycle Orchestrator
// reports — the schedule, what is outdated per tier, the CVE watch, and the
// monthly bundle's way through preview, smoke, staging and the human sign-off.
// Reads via the `lifecycle` router; the five writes are gated, operator-only.
export default async function LifecyclePage() {
  const session = await auth();
  if (!session?.user) redirect("/");
  const login = (session as { login?: string }).login ?? "";
  return <LifecycleView operator={isOperator(login)} login={login} />;
}
