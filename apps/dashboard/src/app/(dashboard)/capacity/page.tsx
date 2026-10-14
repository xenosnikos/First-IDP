import type { Metadata } from "next";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { isOperator } from "@/lib/nebula/operators";
import { CapacityView } from "@/components/capacity/capacity-view";

export const metadata: Metadata = { title: "Capacity" };
export const dynamic = "force-dynamic";

// Capacity (docs/NEBULA.md §N5): traffic templates for pods, nodes and the
// Atlas tier. Reads via the `capacity` router; the writes (capacity PR, merge,
// NonProd Atlas tier) are gated and operator-only. Prod is plan/export only.
export default async function CapacityPage() {
  const session = await auth();
  if (!session?.user) redirect("/");
  const login = (session as { login?: string }).login ?? "";
  return <CapacityView operator={isOperator(login)} login={login} />;
}
