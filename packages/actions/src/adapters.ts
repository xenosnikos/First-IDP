import type { Octokit } from "@octokit/rest";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  CreateSecretCommand,
  DeleteSecretCommand,
} from "@aws-sdk/client-secrets-manager";
import { ECRClient, DescribeImagesCommand, paginateDescribeImages } from "@aws-sdk/client-ecr";
import { GITOPS, type GitopsRepo, type ImageInfo, type ImageRegistry, type SecretStore } from "./named-envs";

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
