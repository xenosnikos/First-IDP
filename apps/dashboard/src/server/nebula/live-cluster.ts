// The live-capacity port (docs/NEBULA.md §N5.2) on EKS-Moly-staging and
// EKS-Moly-Prod: kube API with a fresh EKS token from the dashboard's IRSA
// role (group `nebula-capacity`: deployments/scale + HPAs in default + jobs,
// read deployments/pods/nodes — no `patch deployments`, so no pod-template access) + EKS node-group scaling. Every call is
// hard-timed; nothing here can create or delete a Deployment, Pod or Secret
// (RBAC refuses it even if the code tried).
import { eksAccess, listNodegroups, updateNodegroupScaling } from "@twizz-idp/core";
import type { LiveClusterPort, LiveResources, LiveState, LiveTarget, LiveWorkload } from "@twizz-idp/actions";

const TIMEOUT_MS = 10_000;
const MERGE = { headers: { "Content-Type": "application/merge-patch+json" } };

function withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  return Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS))]);
}

async function clients(cluster: string) {
  const k8s = await import("@kubernetes/client-node");
  const a = await withTimeout(eksAccess(cluster), `EKS auth ${cluster}`);
  const kc = new k8s.KubeConfig();
  kc.loadFromOptions({
    clusters: [{ name: cluster, server: a.server, caData: a.caData, skipTLSVerify: false }],
    users: [{ name: "nebula", token: a.token }],
    contexts: [{ name: cluster, cluster, user: "nebula" }],
    currentContext: cluster,
  });
  return {
    apps: kc.makeApiClient(k8s.AppsV1Api),
    auto: kc.makeApiClient(k8s.AutoscalingV2Api),
    core: kc.makeApiClient(k8s.CoreV1Api),
    apis: kc.makeApiClient(k8s.ApisApi),
  };
}

const cores = (q?: string) => (!q ? 0 : q.endsWith("m") ? Number(q.slice(0, -1)) / 1000 : Number(q));
const gib = (q?: string) => {
  const m = q?.match(/^(\d+(?:\.\d+)?)(Ki|Mi|Gi)?$/);
  if (!m) return 0;
  const n = Number(m[1]);
  return m[2] === "Ki" ? n / 1024 ** 2 : m[2] === "Mi" ? n / 1024 : m[2] === "Gi" ? n : n / 1024 ** 3;
};
const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v));

type DeployItem = {
  metadata?: { name?: string; namespace?: string };
  spec?: { replicas?: number; template?: { spec?: { containers?: Array<{ name?: string; resources?: { requests?: Record<string, unknown>; limits?: Record<string, unknown> } }> } } };
  status?: { readyReplicas?: number };
};
type HpaItem = {
  metadata?: { name?: string };
  spec?: { scaleTargetRef?: { name?: string }; minReplicas?: number; maxReplicas?: number; metrics?: Array<{ resource?: { name?: string; target?: { averageUtilization?: number } } }> };
  status?: { currentReplicas?: number; desiredReplicas?: number };
};

export function liveClusterPort(t: LiveTarget): LiveClusterPort {
  return {
    async read(): Promise<LiveState> {
      const c = await clients(t.cluster);
      const [perNs, nodesRes, apiGroups, nodegroups] = await Promise.all([
        Promise.all(
          t.namespaces.map(async (ns) => {
            const [d, h] = await Promise.all([
              withTimeout(c.apps.listNamespacedDeployment(ns), `deployments/${ns}`),
              withTimeout(c.auto.listNamespacedHorizontalPodAutoscaler(ns), `hpas/${ns}`),
            ]);
            return { ns, deployments: (d.body.items ?? []) as DeployItem[], hpas: (h.body.items ?? []) as HpaItem[] };
          }),
        ),
        withTimeout(c.core.listNode(), "nodes"),
        withTimeout(c.apis.getAPIVersions(), "api groups"),
        withTimeout(listNodegroups(t.cluster), "node groups"),
      ]);
      const workloads: LiveWorkload[] = perNs.flatMap(({ ns, deployments, hpas }) =>
        deployments.map((d) => {
          const name = d.metadata?.name ?? "";
          const ct = d.spec?.template?.spec?.containers?.[0];
          const r = ct?.resources ?? {};
          const resources: LiveResources = {
            ...(r.requests ? { requests: { cpu: str(r.requests.cpu), memory: str(r.requests.memory) } } : {}),
            ...(r.limits ? { limits: { cpu: str(r.limits.cpu), memory: str(r.limits.memory) } } : {}),
          };
          const h = hpas.find((x) => x.spec?.scaleTargetRef?.name === name);
          return {
            namespace: ns,
            name,
            replicas: d.spec?.replicas ?? 0,
            ready: d.status?.readyReplicas ?? 0,
            container: ct?.name ?? name,
            resources,
            cpuRequestsOnAll: (d.spec?.template?.spec?.containers ?? []).every((c) => !!c.resources?.requests?.cpu),
            ...(h
              ? {
                  hpa: {
                    min: h.spec?.minReplicas ?? 1,
                    max: h.spec?.maxReplicas ?? 1,
                    targetCPU: h.spec?.metrics?.find((m) => m.resource?.name === "cpu")?.resource?.target?.averageUtilization,
                    current: h.status?.currentReplicas,
                    desired: h.status?.desiredReplicas,
                  },
                }
              : {}),
          };
        }),
      );
      type NodeItem = { metadata?: { name?: string; labels?: Record<string, string> }; status?: { capacity?: Record<string, string> } };
      const nodes = ((nodesRes.body.items ?? []) as NodeItem[]).map((n) => ({
        name: n.metadata?.name ?? "",
        nodegroup: n.metadata?.labels?.["eks.amazonaws.com/nodegroup"],
        instanceType: n.metadata?.labels?.["node.kubernetes.io/instance-type"],
        cpuCores: cores(n.status?.capacity?.cpu),
        memGi: Math.round(gib(n.status?.capacity?.memory) * 10) / 10,
      }));
      const groups = ((apiGroups.body as { groups?: Array<{ name?: string }> }).groups ?? []).map((g) => g.name);
      return { tier: t.tier, cluster: t.cluster, readAt: new Date().toISOString(), workloads, nodegroups, nodes, metricsServer: groups.includes("metrics.k8s.io") };
    },

    async scale(namespace, name, replicas) {
      const c = await clients(t.cluster);
      await withTimeout(c.apps.patchNamespacedDeploymentScale(name, namespace, { spec: { replicas } }, undefined, undefined, undefined, undefined, undefined, MERGE), `scale ${namespace}/${name}`);
    },

    async upsertHpa(namespace, name, a, exists) {
      const c = await clients(t.cluster);
      const spec = {
        scaleTargetRef: { apiVersion: "apps/v1", kind: "Deployment", name },
        minReplicas: a.min,
        maxReplicas: a.max,
        metrics: [{ type: "Resource", resource: { name: "cpu", target: { type: "Utilization", averageUtilization: a.targetCPU } } }],
      };
      if (exists) {
        await withTimeout(c.auto.patchNamespacedHorizontalPodAutoscaler(name, namespace, { spec }, undefined, undefined, undefined, undefined, undefined, MERGE), `hpa ${namespace}/${name}`);
      } else {
        const body = { apiVersion: "autoscaling/v2", kind: "HorizontalPodAutoscaler", metadata: { name, namespace, labels: { "app.kubernetes.io/managed-by": "nebula-capacity" } }, spec };
        await withTimeout(c.auto.createNamespacedHorizontalPodAutoscaler(namespace, body), `create hpa ${namespace}/${name}`);
      }
    },

    async updateNodegroup(name, size) {
      await withTimeout(updateNodegroupScaling(t.cluster, name, size), `node group ${name}`);
    },
  };
}
