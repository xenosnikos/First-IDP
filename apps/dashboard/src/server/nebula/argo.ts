import type { ArgoStatus } from "@/lib/nebula/status";

// Live Argo CD Application health for named envs, read straight from the
// cluster (docs/NEBULA.md §4.7: in-cluster at nebula.prv.twizz.com so the
// PASS/FAIL/RUNNING pills are real). Credentials, in order:
//   1. in-cluster service account (KUBERNETES_SERVICE_HOST is set)
//   2. KUBECONFIG file (local dev, e.g. ~/.kube/twizz-nonprod.yaml)
//   3. neither → every env reads UNKNOWN. Never faked.
// Needs RBAC: list applications.argoproj.io in namespace argocd.

const ARGO_NS = process.env.ARGOCD_NAMESPACE ?? "argocd";
const LABEL = "twizz-idp/named-env=true";
const TIMEOUT_MS = 6_000;

type AppItem = {
  metadata?: { name?: string };
  status?: { sync?: { status?: string }; health?: { status?: string } };
};

export type ArgoStatusMap = { reachable: boolean; reason?: string; apps: Record<string, ArgoStatus> };

async function loadKubeConfig() {
  const k8s = await import("@kubernetes/client-node");
  const kc = new k8s.KubeConfig();
  if (process.env.KUBERNETES_SERVICE_HOST) {
    kc.loadFromCluster();
    return { k8s, kc, source: "in-cluster" as const };
  }
  if (process.env.KUBECONFIG) {
    kc.loadFromFile(process.env.KUBECONFIG);
    return { k8s, kc, source: "kubeconfig" as const };
  }
  return null;
}

/** One list call, label-selected, hard-timed. Returns per-Application
 * sync/health keyed by Application name (`env-<name>`). */
export async function readArgoApplications(): Promise<ArgoStatusMap> {
  let loaded: Awaited<ReturnType<typeof loadKubeConfig>>;
  try {
    loaded = await loadKubeConfig();
  } catch (e) {
    return { reachable: false, reason: `kubeconfig: ${String(e)}`, apps: {} };
  }
  if (!loaded) return { reachable: false, reason: "no in-cluster credentials and no KUBECONFIG", apps: {} };

  const { k8s, kc } = loaded;
  const api = kc.makeApiClient(k8s.CustomObjectsApi);
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`argo list timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS));
  try {
    const res = await Promise.race([
      api.listNamespacedCustomObject("argoproj.io", "v1alpha1", ARGO_NS, "applications", undefined, undefined, undefined, undefined, LABEL),
      timeout,
    ]);
    const items = ((res as { body?: { items?: AppItem[] } }).body?.items ?? []) as AppItem[];
    const apps: Record<string, ArgoStatus> = {};
    for (const it of items) {
      const name = it.metadata?.name;
      if (!name) continue;
      apps[name] = { sync: it.status?.sync?.status ?? "Unknown", health: it.status?.health?.status ?? "Unknown" };
    }
    return { reachable: true, apps };
  } catch (e) {
    return { reachable: false, reason: String((e as { message?: string }).message ?? e), apps: {} };
  }
}

/** The status the card shows for one env, given the map. */
export function argoStatusFor(map: ArgoStatusMap, appName: string): ArgoStatus {
  if (!map.reachable) return { sync: null, health: null, unreachable: true };
  return map.apps[appName] ?? { sync: null, health: null };
}
