// Read-only cluster snapshot for the Environments/Projects pages: every Argo
// Application (with owner + labels), ApplicationSets (PR generators), Ingress
// hosts and Deployment images. Non-prod ONLY — this is the one cluster Nebula
// has credentials for; staging/prod are observed through CloudWatch (clusters
// router), never through the kube API. Release-train Applications (§N4) live
// in this Argo too but deploy elsewhere: their destination is captured so the
// Environments grid can leave them to the Release train page. All calls are list/get; RBAC is the
// `nebula-dashboard-read` ClusterRole in twizz-gitops apps/nebula/dashboard.yaml.
import { loadKubeConfig } from "./argo";
import type { LiveApp, LiveAppSet, LiveDeployment, LiveIngress } from "./classify";

const ARGO_NS = process.env.ARGOCD_NAMESPACE ?? "argocd";
const TIMEOUT_MS = 8_000;

export type ClusterSnapshot = {
  reachable: boolean;
  reason?: string;
  apps: LiveApp[];
  appsets: LiveAppSet[];
  ingresses: LiveIngress[];
  deployments: LiveDeployment[];
};

type Obj = { metadata?: { name?: string; namespace?: string; labels?: Record<string, string>; ownerReferences?: Array<{ kind?: string; name?: string }> } };

function withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  return Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS))]);
}

export async function readClusterSnapshot(): Promise<ClusterSnapshot> {
  const empty = { apps: [], appsets: [], ingresses: [], deployments: [] };
  let loaded: Awaited<ReturnType<typeof loadKubeConfig>>;
  try {
    loaded = await loadKubeConfig();
  } catch (e) {
    return { reachable: false, reason: `kubeconfig: ${String(e)}`, ...empty };
  }
  if (!loaded) return { reachable: false, reason: "no in-cluster credentials and no KUBECONFIG", ...empty };
  const { k8s, kc } = loaded;
  const custom = kc.makeApiClient(k8s.CustomObjectsApi);
  const net = kc.makeApiClient(k8s.NetworkingV1Api);
  const apps = kc.makeApiClient(k8s.AppsV1Api);

  try {
    const [appRes, setRes, ingRes, depRes] = await Promise.all([
      withTimeout(custom.listNamespacedCustomObject("argoproj.io", "v1alpha1", ARGO_NS, "applications"), "applications"),
      withTimeout(custom.listNamespacedCustomObject("argoproj.io", "v1alpha1", ARGO_NS, "applicationsets"), "applicationsets"),
      withTimeout(net.listIngressForAllNamespaces(), "ingresses"),
      withTimeout(apps.listDeploymentForAllNamespaces(), "deployments"),
    ]);

    type AppItem = Obj & {
      spec?: { project?: string; destination?: { namespace?: string; server?: string; name?: string }; source?: { repoURL?: string }; sources?: Array<{ repoURL?: string }> };
      status?: { sync?: { status?: string }; health?: { status?: string } };
    };
    const appItems = ((appRes as { body?: { items?: AppItem[] } }).body?.items ?? []) as AppItem[];
    const liveApps: LiveApp[] = appItems.map((a) => {
      const owner = a.metadata?.ownerReferences?.[0];
      const urls = [a.spec?.source?.repoURL, ...(a.spec?.sources ?? []).map((s) => s.repoURL)].filter((u): u is string => !!u);
      return {
        name: a.metadata?.name ?? "",
        namespace: a.spec?.destination?.namespace ?? "",
        project: a.spec?.project ?? "",
        labels: a.metadata?.labels ?? {},
        ownerKind: owner?.kind,
        ownerName: owner?.name,
        sourceRepoUrls: [...new Set(urls)],
        sync: a.status?.sync?.status ?? "Unknown",
        health: a.status?.health?.status ?? "Unknown",
        // a named destination (cluster secret `name`) is still "not in-cluster"
        destination: a.spec?.destination?.server ?? (a.spec?.destination?.name ? `cluster:${a.spec.destination.name}` : undefined),
      };
    });

    type SetItem = Obj & { spec?: { generators?: Array<{ pullRequest?: { github?: { owner?: string; repo?: string } } }> } };
    const setItems = ((setRes as { body?: { items?: SetItem[] } }).body?.items ?? []) as SetItem[];
    const appsets: LiveAppSet[] = setItems.map((s) => {
      const pr = s.spec?.generators?.find((g) => g.pullRequest?.github)?.pullRequest?.github;
      return { name: s.metadata?.name ?? "", prOwner: pr?.owner, prRepo: pr?.repo };
    });

    const ingItems = (ingRes as { body: { items: Array<Obj & { spec?: { rules?: Array<{ host?: string }> } }> } }).body.items;
    const ingresses: LiveIngress[] = ingItems.map((i) => ({
      namespace: i.metadata?.namespace ?? "",
      name: i.metadata?.name ?? "",
      hosts: (i.spec?.rules ?? []).map((r) => r.host).filter((h): h is string => !!h),
    }));

    const depItems = (depRes as { body: { items: Array<Obj & { spec?: { replicas?: number; template?: { spec?: { containers?: Array<{ image?: string }> } } }; status?: { readyReplicas?: number } }> } }).body.items;
    const deployments: LiveDeployment[] = depItems.map((d) => ({
      namespace: d.metadata?.namespace ?? "",
      name: d.metadata?.name ?? "",
      images: (d.spec?.template?.spec?.containers ?? []).map((c) => c.image).filter((x): x is string => !!x),
      ready: d.status?.readyReplicas ?? 0,
      desired: d.spec?.replicas ?? 0,
    }));

    return { reachable: true, apps: liveApps, appsets, ingresses, deployments };
  } catch (e) {
    return { reachable: false, reason: String((e as { message?: string }).message ?? e), ...empty };
  }
}

// ── Capacity (docs/NEBULA.md §N5): HPAs, nodes and NodePools on non-prod ──
// Same read-only credentials; needs get/list on horizontalpodautoscalers,
// nodes and karpenter.sh nodepools (nebula-dashboard-read).

export type CapacityKube = {
  reachable: boolean;
  reason?: string;
  hpas: Array<{ namespace: string; name: string; min: number; max: number; current: number; desired: number; cpuTarget?: number }>;
  nodes: Array<{ name: string; pool?: string; capacityType?: string; instanceType?: string; cpu: number; memoryGi: number }>;
  nodePools: Array<{ name: string; limitCpu?: string; limitMemory?: string; usedCpu?: string; usedMemory?: string }>;
};

function cores(q?: string): number {
  if (!q) return 0;
  return q.endsWith("m") ? Number(q.slice(0, -1)) / 1000 : Number(q);
}

function gib(q?: string): number {
  if (!q) return 0;
  const m = q.match(/^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti)?$/);
  if (!m) return 0;
  const n = Number(m[1]);
  return m[2] === "Ki" ? n / 1024 ** 2 : m[2] === "Mi" ? n / 1024 : m[2] === "Ti" ? n * 1024 : m[2] === "Gi" ? n : n / 1024 ** 3;
}

export async function readCapacityKube(): Promise<CapacityKube> {
  const empty = { hpas: [], nodes: [], nodePools: [] };
  let loaded: Awaited<ReturnType<typeof loadKubeConfig>>;
  try {
    loaded = await loadKubeConfig();
  } catch (e) {
    return { reachable: false, reason: `kubeconfig: ${String(e)}`, ...empty };
  }
  if (!loaded) return { reachable: false, reason: "no in-cluster credentials and no KUBECONFIG", ...empty };
  const { k8s, kc } = loaded;
  const auto = kc.makeApiClient(k8s.AutoscalingV2Api);
  const core = kc.makeApiClient(k8s.CoreV1Api);
  const custom = kc.makeApiClient(k8s.CustomObjectsApi);
  // each list fails on its own (RBAC may lag the code): partial data beats none
  const settle = <T>(p: Promise<T>, what: string) => withTimeout(p, what).then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, e: `${what}: ${String((e as { message?: string }).message ?? e)}` }));
  const [hpaR, nodeR, poolR] = await Promise.all([
    settle(auto.listHorizontalPodAutoscalerForAllNamespaces(), "hpas"),
    settle(core.listNode(), "nodes"),
    settle(custom.listClusterCustomObject("karpenter.sh", "v1", "nodepools"), "nodepools"),
  ]);
  const errors = [hpaR, nodeR, poolR].filter((r) => !r.ok).map((r) => (r as { e: string }).e);

  type Hpa = Obj & { spec?: { minReplicas?: number; maxReplicas?: number; metrics?: Array<{ resource?: { name?: string; target?: { averageUtilization?: number } } }> }; status?: { currentReplicas?: number; desiredReplicas?: number } };
  const hpas = hpaR.ok
    ? ((hpaR.v as { body: { items: Hpa[] } }).body.items ?? []).map((h) => ({
        namespace: h.metadata?.namespace ?? "",
        name: h.metadata?.name ?? "",
        min: h.spec?.minReplicas ?? 1,
        max: h.spec?.maxReplicas ?? 1,
        current: h.status?.currentReplicas ?? 0,
        desired: h.status?.desiredReplicas ?? 0,
        cpuTarget: h.spec?.metrics?.find((m) => m.resource?.name === "cpu")?.resource?.target?.averageUtilization,
      }))
    : [];

  type Node = Obj & { status?: { capacity?: Record<string, string> } };
  const nodes = nodeR.ok
    ? ((nodeR.v as { body: { items: Node[] } }).body.items ?? []).map((n) => {
        const l = n.metadata?.labels ?? {};
        return {
          name: n.metadata?.name ?? "",
          pool: l["karpenter.sh/nodepool"],
          capacityType: l["karpenter.sh/capacity-type"],
          instanceType: l["node.kubernetes.io/instance-type"],
          cpu: cores(n.status?.capacity?.cpu),
          memoryGi: Math.round(gib(n.status?.capacity?.memory) * 10) / 10,
        };
      })
    : [];

  type Pool = Obj & { spec?: { limits?: Record<string, string> }; status?: { resources?: Record<string, string> } };
  const nodePools = poolR.ok
    ? (((poolR.v as { body?: { items?: Pool[] } }).body?.items ?? []) as Pool[]).map((p) => ({
        name: p.metadata?.name ?? "",
        limitCpu: p.spec?.limits?.cpu,
        limitMemory: p.spec?.limits?.memory,
        usedCpu: p.status?.resources?.cpu,
        usedMemory: p.status?.resources?.memory,
      }))
    : [];

  return { reachable: errors.length < 3, reason: errors.length ? errors.join("; ") : undefined, hpas, nodes, nodePools };
}
