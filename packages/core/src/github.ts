import { Octokit } from "@octokit/rest";
import type { WorkflowStep } from "@twizz-idp/shared";

export type ActionsRun = {
  id: number;
  owner: string;
  repo: string;
  workflowName: string;
  runNumber: number;
  event: string;
  branch: string | null;
  sha: string;
  status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  htmlUrl: string;
  startedAt: string | null;
  completedAt: string | null;
};

function mapRunStatus(status: string | null, conclusion: string | null): ActionsRun["status"] {
  if (status === "queued" || status === "waiting" || status === "pending") return "PENDING";
  if (status === "in_progress") return "RUNNING";
  if (conclusion === "success") return "SUCCEEDED";
  if (conclusion === "cancelled" || conclusion === "skipped") return "CANCELLED";
  if (conclusion) return "FAILED";
  return "PENDING";
}

function mapJobPhase(status: string | null, conclusion: string | null): WorkflowStep["phase"] {
  if (status === "queued" || status === "waiting" || status === "pending") return "Pending";
  if (status === "in_progress") return "Running";
  if (conclusion === "success") return "Succeeded";
  if (conclusion === "skipped") return "Skipped";
  if (conclusion === "cancelled") return "Error";
  if (conclusion) return "Failed";
  return "Pending";
}

export type Repo = {
  id: number;
  name: string;
  fullName: string;
  url: string;
  language: string | null;
  defaultBranch: string;
  updatedAt: string;
  /** Last push — the honest "activity" signal for a picker. */
  pushedAt: string;
  private: boolean;
};

export type Branch = { name: string; sha: string; protected?: boolean };

export type BranchHead = { sha: string; committedAt: string | null; message: string; author: string | null };

export type TreeEntry = { path: string; type: "blob" | "tree"; size?: number };

/** Directories nobody wants to configure from; dropped from `listTree`. */
export const TREE_SKIP_RE = /(^|\/)(node_modules|\.git|dist|build|\.next|coverage|\.turbo|vendor|__pycache__)(\/|$)/;
/** Binary-ish extensions the Configurator never needs to read. */
export const BINARY_EXT_RE = /\.(png|jpe?g|gif|webp|svg|ico|pdf|zip|gz|tgz|tar|woff2?|ttf|otf|eot|mp[34]|mov|wasm|jar|class|so|dylib|dll|exe|bin|lock)$/i;
export const FILE_CONTENT_CAP = 256 * 1024;

export class GitHubService {
  private octokit: Octokit;

  constructor(accessToken: string) {
    this.octokit = new Octokit({ auth: accessToken });
  }

  /** Every non-archived repo in the org (paginated; the org has > 100). */
  async listOrgRepos(org: string): Promise<Repo[]> {
    const data = await this.octokit.paginate(this.octokit.repos.listForOrg, { org, sort: "pushed", per_page: 100, type: "all" });
    return data
      .filter((r) => !r.archived && !r.disabled)
      .map((r) => ({
        id: r.id,
        name: r.name,
        fullName: r.full_name,
        url: r.html_url,
        language: r.language ?? null,
        defaultBranch: r.default_branch ?? "main",
        updatedAt: r.updated_at ?? "",
        pushedAt: r.pushed_at ?? r.updated_at ?? "",
        private: r.private,
      }));
  }

  /** Branches, paginated, optionally filtered by a case-insensitive substring
   * and capped. Exact matches sort first so a typed name is always visible. */
  async listBranches(owner: string, repo: string, opts: { q?: string; limit?: number } = {}): Promise<Branch[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 500, 2000));
    const q = opts.q?.trim().toLowerCase();
    const out: Branch[] = [];
    for await (const page of this.octokit.paginate.iterator(this.octokit.repos.listBranches, { owner, repo, per_page: 100 })) {
      for (const b of page.data) {
        if (q && !b.name.toLowerCase().includes(q)) continue;
        out.push({ name: b.name, sha: b.commit.sha, protected: b.protected });
      }
      if (!q && out.length >= limit) break;
    }
    if (q) out.sort((a, b) => Number(b.name.toLowerCase() === q) - Number(a.name.toLowerCase() === q) || a.name.localeCompare(b.name));
    return out.slice(0, limit);
  }

  /** The commit a branch points at right now (pinned by the spin-up flow). */
  async getBranchHead(owner: string, repo: string, branch: string): Promise<BranchHead> {
    const { data } = await this.octokit.repos.getBranch({ owner, repo, branch });
    return {
      sha: data.commit.sha,
      committedAt: data.commit.commit.committer?.date ?? data.commit.commit.author?.date ?? null,
      message: (data.commit.commit.message ?? "").split("\n")[0].slice(0, 200),
      author: data.commit.author?.login ?? data.commit.commit.author?.name ?? null,
    };
  }

  /** Recursive tree at a commit, without vendored/build dirs and binaries.
   * `truncated` is GitHub's own flag (very large repos) OR our cap. */
  async listTree(owner: string, repo: string, sha: string, opts: { maxEntries?: number } = {}): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
    const max = opts.maxEntries ?? 3000;
    const { data } = await this.octokit.git.getTree({ owner, repo, tree_sha: sha, recursive: "1" });
    const entries: TreeEntry[] = [];
    for (const e of data.tree) {
      if (!e.path || (e.type !== "blob" && e.type !== "tree")) continue;
      if (TREE_SKIP_RE.test(e.path)) continue;
      if (e.type === "blob" && BINARY_EXT_RE.test(e.path)) continue;
      entries.push({ path: e.path, type: e.type, ...(e.size != null ? { size: e.size } : {}) });
      if (entries.length >= max) break;
    }
    return { entries, truncated: !!data.truncated || entries.length >= max };
  }

  /** File text at a ref, or null when absent / not a file / over the cap. */
  async getFileContent(owner: string, repo: string, path: string, ref: string): Promise<string | null> {
    try {
      const { data } = await this.octokit.repos.getContent({ owner, repo, path, ref });
      if (Array.isArray(data) || data.type !== "file") return null;
      if (data.size > FILE_CONTENT_CAP) return null;
      if (data.encoding === "base64") return Buffer.from(data.content, "base64").toString("utf-8");
      // >1 MB files come back with encoding "none"; capped above anyway
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

  async listWorkflowRuns(owner: string, repo: string, limit = 20): Promise<ActionsRun[]> {
    const { data } = await this.octokit.actions.listWorkflowRunsForRepo({
      owner,
      repo,
      per_page: limit,
    });

    return data.workflow_runs.map((r) => ({
      id: r.id,
      owner,
      repo,
      workflowName: r.name ?? r.display_title,
      runNumber: r.run_number,
      event: r.event,
      branch: r.head_branch,
      sha: r.head_sha,
      status: mapRunStatus(r.status, r.conclusion),
      htmlUrl: r.html_url,
      startedAt: r.run_started_at ?? r.created_at,
      completedAt: r.status === "completed" ? r.updated_at : null,
    }));
  }

  /** A run's jobs mapped onto the DAG-step shape the pipeline UI renders. */
  async getWorkflowRun(owner: string, repo: string, runId: number) {
    const [{ data: run }, { data: jobs }] = await Promise.all([
      this.octokit.actions.getWorkflowRun({ owner, repo, run_id: runId }),
      this.octokit.actions.listJobsForWorkflowRun({ owner, repo, run_id: runId, per_page: 50 }),
    ]);

    const steps: WorkflowStep[] = jobs.jobs.map((j) => ({
      id: String(j.id),
      name: j.name,
      phase: mapJobPhase(j.status, j.conclusion),
      startedAt: j.started_at ?? undefined,
      finishedAt: j.completed_at ?? undefined,
      message: j.conclusion ?? undefined,
    }));

    return {
      id: run.id,
      workflowName: run.name ?? run.display_title,
      runNumber: run.run_number,
      branch: run.head_branch,
      sha: run.head_sha,
      status: mapRunStatus(run.status, run.conclusion),
      htmlUrl: run.html_url,
      startedAt: run.run_started_at ?? run.created_at,
      completedAt: run.status === "completed" ? run.updated_at : null,
      steps,
    };
  }

  async getJobLogs(owner: string, repo: string, jobId: number): Promise<string> {
    try {
      const res = await this.octokit.actions.downloadJobLogsForWorkflowRun({
        owner,
        repo,
        job_id: jobId,
      });
      return typeof res.data === "string" ? res.data : String(res.data);
    } catch {
      return "Logs not available yet (job may still be starting).";
    }
  }
}
