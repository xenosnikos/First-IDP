const VERCEL_TOKEN = process.env.VERCEL_TOKEN ?? "";
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID ?? "";
const VERCEL_API = "https://api.vercel.com";

async function vercelFetch(path: string, options: RequestInit = {}) {
  const url = new URL(path, VERCEL_API);
  if (VERCEL_TEAM_ID) url.searchParams.set("teamId", VERCEL_TEAM_ID);

  const res = await fetch(url.toString(), {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${VERCEL_TOKEN}`,
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Vercel API ${res.status}: ${body}`);
  }

  return res.json();
}

export type VercelEnvironment = {
  name: string;
  target: string;
  state: string;
  url: string;
  aliases: string[];
  branch?: string;
  commitSha?: string;
  commitMessage?: string;
  creator?: string;
  createdAt: number;
};

export type VercelProjectDetail = {
  id: string;
  name: string;
  framework: string | null;
  linkedRepo: string | null;
  environments: VercelEnvironment[];
};

export class VercelService {
  async createDeployment(
    projectName: string,
    gitSource: { ref: string; repoId: string },
  ): Promise<{ id: string; url: string; readyState: string }> {
    const data = await vercelFetch("/v13/deployments", {
      method: "POST",
      body: JSON.stringify({
        name: projectName,
        gitSource: { type: "github", ref: gitSource.ref, repoId: gitSource.repoId },
      }),
    });
    return { id: data.id, url: `https://${data.url}`, readyState: data.readyState };
  }

  async getDeployment(deploymentId: string): Promise<{
    id: string; url: string; readyState: string; createdAt: number;
  }> {
    const data = await vercelFetch(`/v13/deployments/${deploymentId}`);
    return { id: data.id, url: `https://${data.url}`, readyState: data.readyState, createdAt: data.createdAt };
  }

  async listDeployments(projectId: string, limit = 20): Promise<
    Array<{ id: string; url: string; state: string; createdAt: number; target?: string; meta?: { githubCommitRef?: string } }>
  > {
    const data = await vercelFetch(`/v6/deployments?projectId=${projectId}&limit=${limit}`);
    return (data.deployments ?? []).map((d: any) => ({
      id: d.uid,
      url: `https://${d.url}`,
      state: d.state,
      createdAt: d.createdAt,
      target: d.target,
      meta: d.meta,
    }));
  }

  async listProjects(): Promise<Array<{ id: string; name: string; framework: string | null; linkedRepo: string | null }>> {
    const data = await vercelFetch("/v9/projects?limit=100");
    return (data.projects ?? []).map((p: any) => ({
      id: p.id,
      name: p.name,
      framework: p.framework,
      linkedRepo: p.link?.repo ?? null,
    }));
  }

  async getProjectDetail(projectId: string): Promise<VercelProjectDetail> {
    const data = await vercelFetch(`/v9/projects/${projectId}`);

    const environments: VercelEnvironment[] = [];

    // Extract live environments from the `targets` object
    const targets = data.targets ?? {};
    for (const [targetKey, deploy] of Object.entries(targets) as [string, any][]) {
      const aliases: string[] = (deploy.alias ?? []).map((a: any) =>
        typeof a === "string" ? a : a.domain ?? a,
      );

      // Determine environment name from OIDC claims or target key
      const oidcEnv = deploy.oidcTokenClaims?.environment;
      let envName: string;
      if (oidcEnv === "production") envName = "Production";
      else if (oidcEnv === "staging") envName = "Staging";
      else if (oidcEnv === "preview") envName = "Preview";
      else if (targetKey === "production") envName = "Production";
      else if (targetKey.startsWith("env_")) envName = oidcEnv ? `${oidcEnv.charAt(0).toUpperCase()}${oidcEnv.slice(1)}` : "Custom Environment";
      else envName = targetKey;

      environments.push({
        name: envName,
        target: targetKey,
        state: deploy.readyState ?? "UNKNOWN",
        url: `https://${deploy.url}`,
        aliases: aliases.map((a) => `https://${a}`),
        branch: deploy.meta?.githubCommitRef,
        commitSha: deploy.meta?.githubCommitSha,
        commitMessage: deploy.meta?.githubCommitMessage?.split("\n")[0],
        creator: deploy.creator?.username,
        createdAt: deploy.createdAt ?? 0,
      });
    }

    return {
      id: data.id,
      name: data.name,
      framework: data.framework ?? null,
      linkedRepo: data.link?.repo ?? null,
      environments,
    };
  }
}

export const vercelService = new VercelService();
