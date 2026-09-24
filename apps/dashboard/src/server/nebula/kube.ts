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
