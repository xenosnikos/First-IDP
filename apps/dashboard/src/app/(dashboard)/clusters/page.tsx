import type { Metadata } from "next";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { ClustersView } from "@/components/clusters/clusters-view";

export const metadata: Metadata = { title: "Clusters" };
export const dynamic = "force-dynamic";

// Clusters = pods + logs across all three clusters; observe-only for
// staging/QA and prod (docs/NEBULA.md §N3.4). Reads via tRPC clusters.*
// (queries only, CloudWatch Container Insights); no write exists here.
export default async function ClustersPage() {
  const session = await auth();
  if (!session?.user) redirect("/");
  return <ClustersView />;
}
