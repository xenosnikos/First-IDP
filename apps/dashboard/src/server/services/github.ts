import { Octokit } from "@octokit/rest";

type Repo = {
  id: number;
  name: string;
  fullName: string;
  url: string;
  language: string | null;
  defaultBranch: string;
  updatedAt: string;
  private: boolean;
};

type Branch = { name: string; sha: string };

export class GitHubService {
  private octokit: Octokit;

  constructor(accessToken: string) {
    this.octokit = new Octokit({ auth: accessToken });
  }

  async listOrgRepos(org: string): Promise<Repo[]> {
    const { data } = await this.octokit.repos.listForOrg({
      org,
      sort: "updated",
      per_page: 100,
      type: "all",
    });

    return data.map((r) => ({
      id: r.id,
      name: r.name,
      fullName: r.full_name,
      url: r.html_url,
      language: r.language,
      defaultBranch: r.default_branch,
      updatedAt: r.updated_at ?? "",
      private: r.private,
    }));
  }

  async listBranches(owner: string, repo: string): Promise<Branch[]> {
    const { data } = await this.octokit.repos.listBranches({
      owner,
      repo,
      per_page: 100,
    });

    return data.map((b) => ({
      name: b.name,
      sha: b.commit.sha,
    }));
  }

  async getFileContent(owner: string, repo: string, path: string, ref: string): Promise<string | null> {
    try {
      const { data } = await this.octokit.repos.getContent({
        owner,
        repo,
        path,
        ref,
      });

      if ("content" in data && data.encoding === "base64") {
        return Buffer.from(data.content, "base64").toString("utf-8");
      }
      return null;
    } catch {
      return null;
    }
  }

  async detectProjectType(owner: string, repo: string, branch: string) {
    const [dockerfile, vercelJson, packageJsonRaw] = await Promise.all([
      this.getFileContent(owner, repo, "Dockerfile", branch),
      this.getFileContent(owner, repo, "vercel.json", branch),
      this.getFileContent(owner, repo, "package.json", branch),
    ]);

    const hasDockerfile = dockerfile !== null;
    const hasVercelConfig = vercelJson !== null;

    let deps: Record<string, string> = {};
    if (packageJsonRaw) {
      try {
        const pkg = JSON.parse(packageJsonRaw);
        deps = { ...pkg.dependencies, ...pkg.devDependencies };
      } catch { /* ignore parse errors */ }
    }

    let type: "FRONTEND" | "BACKEND" | "FULLSTACK" | "UNKNOWN" = "UNKNOWN";
    if (hasDockerfile && hasVercelConfig) type = "FULLSTACK";
    else if (hasDockerfile) type = "BACKEND";
    else if (hasVercelConfig || deps["next"] || deps["react"]) type = "FRONTEND";

    return { type, deps, hasDockerfile, hasVercelConfig };
  }

  async getCommits(owner: string, repo: string, base: string, head: string) {
    const { data } = await this.octokit.repos.compareCommits({
      owner,
      repo,
      base,
      head,
    });

    return data.commits.map((c) => ({
      sha: c.sha,
      message: c.commit.message,
      author: c.commit.author?.name ?? "unknown",
      date: c.commit.author?.date ?? "",
    }));
  }
}
