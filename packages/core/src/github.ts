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
      language: r.language ?? null,
      defaultBranch: r.default_branch ?? "main",
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
