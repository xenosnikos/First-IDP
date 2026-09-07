import type { Metadata } from "next";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { isOperator } from "@/lib/nebula/operators";
import { EnvironmentsGrid } from "@/components/environments/environments-grid";

export const metadata: Metadata = { title: "Environments" };
export const dynamic = "force-dynamic";

// Nebula's Environments surface: one preview card per named env in
// twizz-gitops/named-envs, with live Argo health read in-cluster. Reads via
// tRPC actions.listEnvs; writes via the gated actions router.
export default async function EnvironmentsPage() {
  const session = await auth();
  if (!session?.user) redirect("/");
  const login = (session as { login?: string }).login ?? "";
  return <EnvironmentsGrid operator={isOperator(login)} login={login} />;
}
