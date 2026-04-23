import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { introspectAllEnvironments } from "@/server/services/introspect";
import { EnvironmentMap } from "@/components/environments/environment-map";

export default async function EnvironmentsPage() {
  const session = await auth();
  if (!session?.user) redirect("/");

  const token = (session as any).accessToken as string;
  const org = process.env.GITHUB_ORG ?? "twizz-app";

  let data: Awaited<ReturnType<typeof introspectAllEnvironments>> | null = null;
  let error: string | null = null;

  try {
    data = await introspectAllEnvironments(token, org);
  } catch (e: any) {
    error = e.message ?? "Failed to load environments";
  }

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Environments</h1>
        <p className="text-muted-foreground mt-1">
          All services across all environment tiers
        </p>
      </div>

      {error && (
        <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-4 mb-6">
          <p className="text-destructive text-sm">{error}</p>
        </div>
      )}

      {data && <EnvironmentMap data={data} />}
    </div>
  );
}
