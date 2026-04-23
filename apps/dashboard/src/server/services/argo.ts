const ARGO_URL = process.env.ARGO_WORKFLOWS_URL ?? "http://localhost:2746";
const ARGO_TOKEN = process.env.ARGO_TOKEN ?? "";

export type WorkflowStep = {
  id: string;
  name: string;
  phase: "Pending" | "Running" | "Succeeded" | "Failed" | "Skipped" | "Error";
  startedAt?: string;
  finishedAt?: string;
  message?: string;
  templateName?: string;
  podName?: string;
};

export type WorkflowStatus = {
  name: string;
  namespace: string;
  phase: "Pending" | "Running" | "Succeeded" | "Failed" | "Error";
  startedAt?: string;
  finishedAt?: string;
  steps: WorkflowStep[];
  outputs?: Record<string, string>;
};

async function argoFetch(path: string, options: RequestInit = {}) {
  const res = await fetch(`${ARGO_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(ARGO_TOKEN ? { Authorization: `Bearer ${ARGO_TOKEN}` } : {}),
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Argo API ${res.status}: ${body}`);
  }

  return res.json();
}

function extractSteps(nodes: Record<string, any> | undefined): WorkflowStep[] {
  if (!nodes) return [];
  return Object.entries(nodes)
    .filter(([, n]: [string, any]) => n.type === "Pod")
    .map(([key, n]: [string, any]) => ({
      id: key,
      name: n.displayName || n.name,
      phase: n.phase ?? "Pending",
      startedAt: n.startedAt,
      finishedAt: n.finishedAt,
      message: n.message,
      templateName: n.templateName,
      podName: n.id, // Argo node ID is also the pod name for Pod-type nodes
    }));
}

export class ArgoService {
  async submitWorkflow(
    templateName: string,
    namespace: string,
    params: Record<string, string>,
  ): Promise<string> {
    const body = {
      namespace: "argo",
      serverDryRun: false,
      workflow: {
        metadata: {
          generateName: `${templateName}-`,
          namespace: "argo",
          labels: { "twizz-idp/template": templateName, "twizz-idp/target-ns": namespace },
        },
        spec: {
          workflowTemplateRef: { name: templateName },
          arguments: {
            parameters: Object.entries(params).map(([name, value]) => ({ name, value })),
          },
        },
      },
    };

    const data = await argoFetch("/api/v1/workflows/argo", {
      method: "POST",
      body: JSON.stringify(body),
    });

    return data.metadata.name;
  }

  async getWorkflow(name: string): Promise<WorkflowStatus> {
    const data = await argoFetch(`/api/v1/workflows/argo/${name}`);

    return {
      name: data.metadata.name,
      namespace: data.metadata.namespace,
      phase: data.status?.phase ?? "Pending",
      startedAt: data.status?.startedAt,
      finishedAt: data.status?.finishedAt,
      steps: extractSteps(data.status?.nodes),
      outputs: data.status?.outputs?.parameters?.reduce(
        (acc: Record<string, string>, p: any) => ({ ...acc, [p.name]: p.value }),
        {},
      ),
    };
  }

  async getWorkflowLogs(name: string, container?: string): Promise<string> {
    const params = new URLSearchParams();
    if (container) params.set("logOptions.container", container);
    params.set("logOptions.follow", "false");

    const res = await fetch(
      `${ARGO_URL}/api/v1/workflows/argo/${name}/log?${params}`,
      {
        headers: ARGO_TOKEN ? { Authorization: `Bearer ${ARGO_TOKEN}` } : {},
      },
    );

    if (!res.ok) return `Failed to fetch logs: ${res.status}`;
    return res.text();
  }

  async getStepLogs(workflowName: string, podName: string): Promise<string> {
    const params = new URLSearchParams();
    params.set("podName", podName);
    params.set("logOptions.container", "main");
    params.set("logOptions.follow", "false");

    const res = await fetch(
      `${ARGO_URL}/api/v1/workflows/argo/${workflowName}/log?${params}`,
      {
        headers: ARGO_TOKEN ? { Authorization: `Bearer ${ARGO_TOKEN}` } : {},
      },
    );

    if (!res.ok) return `Failed to fetch step logs: ${res.status}`;
    return res.text();
  }

  async listWorkflows(labelSelector?: string): Promise<WorkflowStatus[]> {
    const params = new URLSearchParams();
    if (labelSelector) params.set("listOptions.labelSelector", labelSelector);
    params.set("listOptions.limit", "50");

    const data = await argoFetch(`/api/v1/workflows/argo?${params}`);

    return (data.items ?? []).map((wf: any) => ({
      name: wf.metadata.name,
      namespace: wf.metadata.namespace,
      phase: wf.status?.phase ?? "Pending",
      startedAt: wf.status?.startedAt,
      finishedAt: wf.status?.finishedAt,
      steps: extractSteps(wf.status?.nodes),
    }));
  }
}

export const argoService = new ArgoService();
