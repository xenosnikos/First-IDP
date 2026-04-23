import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { DeployWizard } from "@/components/deploy/deploy-wizard";

export default async function DeployPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/");

  const { projectId: repoName } = await params;
  const org = process.env.GITHUB_ORG ?? "twizz-app";

  // For now, projectId in the URL is the repo name.
  // The wizard needs a CUID projectId for the environment.create mutation.
  // We'll pass the repo name and org so the wizard can use listBranches,
  // and the projectId will be resolved during deployment.

  return (
    <div className="p-8">
      <div className="max-w-3xl mx-auto mb-8">
        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-6">
          <Link href="/projects" className="hover:text-foreground">Projects</Link>
          <span>/</span>
          <Link href={`/projects/${repoName}`} className="hover:text-foreground">{repoName}</Link>
          <span>/</span>
          <span className="text-foreground">Deploy</span>
        </div>
        <h1 className="text-2xl font-bold">Deploy {repoName}</h1>
        <p className="text-muted-foreground mt-1">
          Configure and deploy this service to an environment.
        </p>
      </div>

      <DeployWizard
        projectId=""
        projectName={repoName}
        owner={org}
      />
    </div>
  );
}
