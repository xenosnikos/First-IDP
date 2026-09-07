import * as k8s from "@kubernetes/client-node";
import { PREVIEW_LABEL, type ArgoAppInfo, type NamespaceInfo } from "./orphans";

export interface KubeClient {
  listPreviewNamespaces(): Promise<NamespaceInfo[]>;
  listArgoApplications(): Promise<ArgoAppInfo[]>;
  deleteNamespace(name: string): Promise<void>;
}

/** @kubernetes/client-node 0.22: loadFromDefault() = in-cluster when the
 * service-account env is present, else $KUBECONFIG / ~/.kube/config. */
export function realKubeClient(): KubeClient {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  const core = kc.makeApiClient(k8s.CoreV1Api);
  const custom = kc.makeApiClient(k8s.CustomObjectsApi);

  return {
    async listPreviewNamespaces() {
      const res = await core.listNamespace(undefined, undefined, undefined, undefined, `${PREVIEW_LABEL}=true`);
      return res.body.items.map((ns) => ({
        name: ns.metadata?.name ?? "",
        labels: ns.metadata?.labels ?? {},
        createdAt: ns.metadata?.creationTimestamp ? new Date(ns.metadata.creationTimestamp) : undefined,
      }));
    },
    async listArgoApplications() {
      const res = await custom.listNamespacedCustomObject("argoproj.io", "v1alpha1", "argocd", "applications");
      const items = ((res.body as { items?: Array<{ metadata?: { name?: string; labels?: Record<string, string> } }> }).items ?? []);
      return items.map((a) => ({ name: a.metadata?.name ?? "", labels: a.metadata?.labels ?? {} }));
    },
    async deleteNamespace(name: string) {
      await core.deleteNamespace(name);
    },
  };
}
