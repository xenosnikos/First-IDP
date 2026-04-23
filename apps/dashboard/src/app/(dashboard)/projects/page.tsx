import { auth } from "@/lib/auth";
import { GitHubService } from "@/server/services/github";
import Link from "next/link";
import { redirect } from "next/navigation";

export default async function ProjectsPage() {
  const session = await auth();
  if (!session?.user) redirect("/");

  const token = (session as any).accessToken as string;
  const github = new GitHubService(token);
  const org = process.env.GITHUB_ORG ?? "twizz-app";

  let repos: Awaited<ReturnType<typeof github.listOrgRepos>> = [];
  let error: string | null = null;

  try {
    repos = await github.listOrgRepos(org);
  } catch (e: any) {
    error = e.message ?? "Failed to fetch repos";
  }

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold">Projects</h1>
          <p className="text-muted-foreground mt-1">
            {repos.length} repositories in <span className="font-medium text-foreground">{org}</span>
          </p>
        </div>
      </div>

      {error && (
        <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-4 mb-6">
          <p className="text-destructive text-sm">{error}</p>
        </div>
      )}

      <div className="grid gap-4">
        {repos.map((repo) => (
          <Link
            key={repo.id}
            href={`/projects/${repo.name}`}
            className="block rounded-lg border border-border bg-card p-5 hover:border-primary/50 transition-colors"
          >
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-3">
                  <h2 className="font-semibold text-lg">{repo.name}</h2>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${
                    repo.private
                      ? "bg-yellow-500/10 text-yellow-500"
                      : "bg-green-500/10 text-green-500"
                  }`}>
                    {repo.private ? "Private" : "Public"}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground mt-1">{repo.fullName}</p>
              </div>
              <div className="flex items-center gap-4 text-sm text-muted-foreground">
                {repo.language && (
                  <span className="flex items-center gap-1.5">
                    <span className="w-3 h-3 rounded-full bg-primary/60" />
                    {repo.language}
                  </span>
                )}
                <span>
                  {new Date(repo.updatedAt).toLocaleDateString()}
                </span>
              </div>
            </div>
            <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
              <span>Branch: <span className="text-foreground">{repo.defaultBranch}</span></span>
            </div>
          </Link>
        ))}

        {repos.length === 0 && !error && (
          <div className="text-center py-12 text-muted-foreground">
            No repositories found in {org}
          </div>
        )}
      </div>
    </div>
  );
}
