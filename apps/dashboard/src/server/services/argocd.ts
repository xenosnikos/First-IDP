const ARGOCD_URL = process.env.ARGO_CD_URL ?? "http://localhost:8080";
const ARGOCD_TOKEN = process.env.ARGOCD_AUTH_TOKEN ?? "";

async function argocdFetch(path: string, options: RequestInit = {}) {
  const res = await fetch(`${ARGOCD_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(ARGOCD_TOKEN ? { Authorization: `Bearer ${ARGOCD_TOKEN}` } : {}),
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ArgoCD API ${res.status}: ${body}`);
  }

  return res.json();
}

export class ArgoCDService {
  async createApplication(
    name: string,
    namespace: string,
    repoUrl: string,
    chartPath: string,
    helmValues: Record<string, unknown>,
  ): Promise<void> {
    await argocdFetch("/api/v1/applications", {
      method: "POST",
      body: JSON.stringify({
        metadata: { name, namespace: "argocd" },
        spec: {
          project: "default",
          source: {
            repoURL: repoUrl,
            path: chartPath,
            helm: {
              values: JSON.stringify(helmValues),
            },
          },
          destination: {
            server: "https://kubernetes.default.svc",
            namespace,
          },
          syncPolicy: {
            syncOptions: ["CreateNamespace=true"],
          },
        },
      }),
    });
  }

  async syncApplication(name: string): Promise<void> {
    await argocdFetch(`/api/v1/applications/${name}/sync`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  }

  async getAppStatus(name: string): Promise<{ health: string; sync: string; resources: number }> {
    const data = await argocdFetch(`/api/v1/applications/${name}`);
    return {
      health: data.status?.health?.status ?? "Unknown",
      sync: data.status?.sync?.status ?? "Unknown",
      resources: data.status?.resources?.length ?? 0,
    };
  }

  async deleteApplication(name: string): Promise<void> {
    await argocdFetch(`/api/v1/applications/${name}`, {
      method: "DELETE",
    });
  }
}

export const argoCDService = new ArgoCDService();
