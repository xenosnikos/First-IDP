import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { introspectProject, type ProjectIntrospection } from "@/server/services/introspect";
import { Section, ProjectHeader } from "@/components/projects/project-layout";
import { StackDetection } from "@/components/projects/stack-detection";
import { EnvironmentTabs } from "@/components/projects/environment-tabs";
import { DeploymentHistory } from "@/components/projects/deployment-history";

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/");

  const { projectId: repoName } = await params;
  const token = (session as any).accessToken as string;
  const org = process.env.GITHUB_ORG ?? "twizz-app";

  let data: ProjectIntrospection | null = null;
  let error: string | null = null;

  try {
    data = await introspectProject(token, org, repoName);
  } catch (e: any) {
    error = e.message ?? "Failed to introspect project";
  }

  if (!data) {
    return (
      <div className="p-8 max-w-6xl mx-auto space-y-8">
        <Breadcrumb repoName={repoName} />
        <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-4">
          <p className="text-destructive">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-8">
      <Breadcrumb repoName={repoName} />

      <ProjectHeader
        name={data.repo.name}
        type={data.type}
        description={data.repo.description}
        repoName={repoName}
      />

      <Section title="Stack">
        <StackDetection detection={data.detection} repo={data.repo} />
      </Section>

      {data.environments.length > 0 && (
        <Section title={`Environments (${data.environments.length})`}>
          <EnvironmentTabs environments={data.environments} />
        </Section>
      )}

      {data.vercelDeployments.length > 0 && (
        <Section title="Deployment History">
          <DeploymentHistory deployments={data.vercelDeployments} />
        </Section>
      )}
    </div>
  );
}

function Breadcrumb({ repoName }: { repoName: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <Link href="/projects" className="hover:text-foreground">Projects</Link>
      <span>/</span>
      <span className="text-foreground">{repoName}</span>
    </div>
  );
}
