import type { Metadata } from "next";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { isOperator } from "@/lib/nebula/operators";
import { ReleaseTrain } from "@/components/releases/release-train";

export const metadata: Metadata = { title: "Release train" };
export const dynamic = "force-dynamic";

// The release train (docs/NEBULA.md §N4): previews → staging for the services
// on it (twizz-sentinel + the admin frontend). Reads via actions.listReleaseTrain;
// the two writes (open the promotion PR, merge it) are gated, operator-only.
export default async function ReleasesPage() {
  const session = await auth();
  if (!session?.user) redirect("/");
  const login = (session as { login?: string }).login ?? "";
  return <ReleaseTrain operator={isOperator(login)} login={login} />;
}
