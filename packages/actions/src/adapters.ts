import type { Octokit } from "@octokit/rest";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  CreateSecretCommand,
  PutSecretValueCommand,
  DeleteSecretCommand,
} from "@aws-sdk/client-secrets-manager";
import { ECRClient, DescribeImagesCommand, paginateDescribeImages } from "@aws-sdk/client-ecr";
import {
  GITOPS,
  type BuildDispatcher,
  type BuildInputs,
  type BuildRun,
  type FileChange,
  type GitopsRepo,
  type ImageInfo,
  type ImageRegistry,
  type SecretStore,
} from "./named-envs";
import type { PromotionPr, PromotionRepo } from "./promote";

/** GitHub Contents API over TwizzyNicky/twizz-gitops. Each put/delete is one
 * commit on `main` — Argo CD's git generator picks it up on its next poll. */
export class GithubGitops implements GitopsRepo {
  constructor(private readonly gh: Octokit, private readonly repo = GITOPS) {}

  async getFile(path: string) {
    try {
      const { data } = await this.gh.repos.getContent({ owner: this.repo.owner, repo: this.repo.repo, path, ref: this.repo.branch });
      if (Array.isArray(data) || data.type !== "file") return null;
      return { content: Buffer.from(data.content, "base64").toString("utf8"), sha: data.sha };
    } catch (e) {
      if ((e as { status?: number }).status === 404) return null;
      throw e;
    }
  }

  async putFile(path: string, content: string, message: string, sha?: string) {
    await this.gh.repos.createOrUpdateFileContents({
      owner: this.repo.owner,
      repo: this.repo.repo,
      branch: this.repo.branch,
      path,
      message,
      content: Buffer.from(content, "utf8").toString("base64"),
      ...(sha ? { sha } : {}),
    });
  }

  async deleteFile(path: string, message: string, sha: string) {
    await this.gh.repos.deleteFile({ owner: this.repo.owner, repo: this.repo.repo, branch: this.repo.branch, path, message, sha });
  }

  async listDir(path: string) {
    try {
      const { data } = await this.gh.repos.getContent({ owner: this.repo.owner, repo: this.repo.repo, path, ref: this.repo.branch });
      if (!Array.isArray(data)) return [];
      return data.filter((d) => d.type === "file").map((d) => d.name);
    } catch (e) {
      if ((e as { status?: number }).status === 404) return [];
      throw e;
    }
  }

  /** Several files in ONE commit on `main` via the Git Data API, so a
   * promotion (delete pending + create deployable) or a teardown (manifest +
   * values) can never land half-done. One retry on a non-fast-forward. */
  async commit(changes: FileChange[], message: string): Promise<string> {
    if (changes.length === 0) throw new Error("commit: no changes");
    const { owner, repo, branch } = this.repo;
    const attempt = async (): Promise<string> => {
      const { data: ref } = await this.gh.git.getRef({ owner, repo, ref: `heads/${branch}` });
      const baseSha = ref.object.sha;
      const tree = await Promise.all(
        changes.map(async (c) => {
          if (c.content === null) return { path: c.path, mode: "100644" as const, type: "blob" as const, sha: null };
          const { data: blob } = await this.gh.git.createBlob({ owner, repo, content: c.content, encoding: "utf-8" });
          return { path: c.path, mode: "100644" as const, type: "blob" as const, sha: blob.sha };
        }),
      );
      const { data: newTree } = await this.gh.git.createTree({ owner, repo, base_tree: baseSha, tree });
      const { data: commit } = await this.gh.git.createCommit({ owner, repo, message, tree: newTree.sha, parents: [baseSha] });
      await this.gh.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: commit.sha });
      return commit.sha;
    };
    try {
      return await attempt();
    } catch (e) {
      if ((e as { status?: number }).status === 422) return attempt();
      throw e;
    }
  }
}

/** The central builder: workflow_dispatch on twizz-idp's nebula-build.yml and
 * run correlation by the workflow's `run-name` (display_title). */
export class GithubBuilds implements BuildDispatcher {
  constructor(
    private readonly gh: Octokit,
    private readonly wf = { owner: "xenosnikos", repo: "First-IDP", workflow: "nebula-build.yml", ref: "main" },
  ) {}

  displayTitle(i: Pick<BuildInputs, "envName" | "service" | "sha">): string {
    return `nebula-build ${i.envName} ${i.service} ${i.sha}`;
  }

  async dispatch(inputs: BuildInputs): Promise<void> {
    await this.gh.actions.createWorkflowDispatch({
      owner: this.wf.owner,
      repo: this.wf.repo,
      workflow_id: this.wf.workflow,
      ref: this.wf.ref,
      inputs: {
        repo: inputs.repo,
        ref: inputs.ref,
        sha: inputs.sha,
        service: inputs.service,
        envName: inputs.envName,
        dockerfile: inputs.dockerfile,
        context: inputs.context,
        buildArgs: JSON.stringify(inputs.buildArgs),
        target: inputs.target ?? "",
      },
    });
  }

  private toRun(r: { id: number; html_url: string; status: string | null; conclusion: string | null; created_at: string }): BuildRun {
    const status = r.status === "completed" ? "completed" : r.status === "in_progress" ? "in_progress" : "queued";
    return { id: r.id, url: r.html_url, status, conclusion: r.conclusion ?? undefined, createdAt: r.created_at };
  }

  async findRun(q: { displayTitle: string; createdAfter: Date }): Promise<BuildRun | null> {
    const { data } = await this.gh.actions.listWorkflowRuns({
      owner: this.wf.owner,
      repo: this.wf.repo,
      workflow_id: this.wf.workflow,
      event: "workflow_dispatch",
      created: `>=${q.createdAfter.toISOString()}`,
      per_page: 50,
    });
    const match = data.workflow_runs
      .filter((r) => (r.display_title ?? r.name) === q.displayTitle)
      .sort((a, b) => b.run_number - a.run_number)[0];
    return match ? this.toRun(match) : null;
  }

  async getRun(runId: number): Promise<BuildRun> {
    const { data } = await this.gh.actions.getWorkflowRun({ owner: this.wf.owner, repo: this.wf.repo, run_id: runId });
    return this.toRun(data);
  }
}

export class SecretsManagerStore implements SecretStore {
  constructor(private readonly sm: SecretsManagerClient) {}

  async getJson(name: string) {
    const res = await this.sm.send(new GetSecretValueCommand({ SecretId: name }));
    if (!res.SecretString) throw new Error(`secret ${name} has no string value`);
    return JSON.parse(res.SecretString) as Record<string, string>;
  }

  async createJson(name: string, value: Record<string, string>, tags: Record<string, string>) {
    await this.sm.send(
      new CreateSecretCommand({
        Name: name,
        SecretString: JSON.stringify(value),
        Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
      }),
    );
  }

  async putJson(name: string, value: Record<string, string>) {
    await this.sm.send(new PutSecretValueCommand({ SecretId: name, SecretString: JSON.stringify(value) }));
  }

  async deleteNow(name: string) {
    await this.sm.send(new DeleteSecretCommand({ SecretId: name, ForceDeleteWithoutRecovery: true }));
  }
}

export class EcrRegistry implements ImageRegistry {
  constructor(private readonly ecr: ECRClient) {}

  async describeTag(repo: string, tag: string): Promise<ImageInfo | null> {
    try {
      const res = await this.ecr.send(new DescribeImagesCommand({ repositoryName: repo, imageIds: [{ imageTag: tag }] }));
      const d = res.imageDetails?.[0];
      if (!d) return null;
      return { tags: d.imageTags ?? [], pushedAt: d.imagePushedAt, digest: d.imageDigest };
    } catch (e) {
      if ((e as { name?: string }).name === "ImageNotFoundException") return null;
      throw e;
    }
  }

  async listImages(repo: string): Promise<ImageInfo[]> {
    const out: ImageInfo[] = [];
    for await (const page of paginateDescribeImages(
      { client: this.ecr, pageSize: 1000 },
      { repositoryName: repo, filter: { tagStatus: "TAGGED" } },
    )) {
      for (const d of page.imageDetails ?? []) {
        out.push({ tags: d.imageTags ?? [], pushedAt: d.imagePushedAt, digest: d.imageDigest });
      }
    }
    return out;
  }
}

/** Promotion PRs on TwizzyNicky/twizz-gitops (docs/NEBULA.md §N4): a
 * branch off `main` carrying the values bump, a PR into `main`, a sha-guarded
 * squash merge. Reads use the default branch; the platform token does the writes. */
export class GithubPromotions implements PromotionRepo {
  constructor(private readonly gh: Octokit, private readonly repo = GITOPS) {}

  private toPr(p: { number: number; html_url: string; title: string; head: { ref: string; sha: string }; user: { login: string } | null; created_at: string; state: string; merged_at?: string | null }): PromotionPr {
    return {
      number: p.number,
      url: p.html_url,
      title: p.title,
      branch: p.head.ref,
      headSha: p.head.sha,
      author: p.user?.login ?? "unknown",
      createdAt: p.created_at,
      state: p.merged_at ? "merged" : p.state === "open" ? "open" : "closed",
    };
  }

  async readFile(path: string) {
    try {
      const { data } = await this.gh.repos.getContent({ owner: this.repo.owner, repo: this.repo.repo, path, ref: this.repo.branch });
      if (Array.isArray(data) || data.type !== "file") return null;
      return { content: Buffer.from(data.content, "base64").toString("utf8"), sha: data.sha };
    } catch (e) {
      if ((e as { status?: number }).status === 404) return null;
      throw e;
    }
  }

  async openPr(input: { branch: string; files: Record<string, string>; title: string; body: string }) {
    const { owner, repo, branch: base } = this.repo;
    const { data: baseRef } = await this.gh.git.getRef({ owner, repo, ref: `heads/${base}` });
    let parentSha = baseRef.object.sha;
    let exists = false;
    try {
      const { data: r } = await this.gh.git.getRef({ owner, repo, ref: `heads/${input.branch}` });
      parentSha = r.object.sha;
      exists = true;
    } catch (e) {
      if ((e as { status?: number }).status !== 404) throw e;
    }
    const tree = await Promise.all(
      Object.entries(input.files).map(async ([path, content]) => ({
        path,
        mode: "100644" as const,
        type: "blob" as const,
        sha: (await this.gh.git.createBlob({ owner, repo, content, encoding: "utf-8" })).data.sha,
      })),
    );
    const { data: newTree } = await this.gh.git.createTree({ owner, repo, base_tree: parentSha, tree });
    const { data: commit } = await this.gh.git.createCommit({ owner, repo, message: input.title, tree: newTree.sha, parents: [parentSha] });
    if (exists) await this.gh.git.updateRef({ owner, repo, ref: `heads/${input.branch}`, sha: commit.sha, force: true });
    else await this.gh.git.createRef({ owner, repo, ref: `refs/heads/${input.branch}`, sha: commit.sha });
    const { data: pr } = await this.gh.pulls.create({ owner, repo, title: input.title, head: input.branch, base, body: input.body });
    return { number: pr.number, url: pr.html_url, headSha: commit.sha };
  }

  async listOpenPrs(branchPrefix: string) {
    const { owner, repo, branch: base } = this.repo;
    const { data } = await this.gh.pulls.list({ owner, repo, state: "open", base, per_page: 100 });
    return data.filter((p) => p.head.ref.startsWith(branchPrefix)).map((p) => this.toPr(p));
  }

  async getPr(number: number) {
    try {
      const { data } = await this.gh.pulls.get({ owner: this.repo.owner, repo: this.repo.repo, pull_number: number });
      return this.toPr(data);
    } catch (e) {
      if ((e as { status?: number }).status === 404) return null;
      throw e;
    }
  }

  async mergePr(number: number, opts: { title: string; sha: string }) {
    const { owner, repo } = this.repo;
    const { data: pr } = await this.gh.pulls.get({ owner, repo, pull_number: number });
    const { data } = await this.gh.pulls.merge({ owner, repo, pull_number: number, merge_method: "squash", sha: opts.sha, commit_title: opts.title });
    if (!data.merged) throw new Error(`GitHub refused the merge of #${number}: ${data.message}`);
    // best effort: the branch has no further use
    await this.gh.git.deleteRef({ owner, repo, ref: `heads/${pr.head.ref}` }).catch(() => {});
    return { sha: data.sha };
  }
}
