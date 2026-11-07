// The live-capacity port (docs/NEBULA.md §N5.2) on EKS-Moly-staging and
// EKS-Moly-Prod: kube API with a fresh EKS token from the dashboard's IRSA
// role (group `nebula-capacity`: deployments/scale + HPAs in default + jobs,
// read deployments/pods/nodes — no `patch deployments`, so no pod-template access) + EKS node-group scaling. Every call is
// hard-timed; nothing here can create or delete a Deployment, Pod or Secret
// (RBAC refuses it even if the code tried).
import { eksAccess, listNodegroups, updateNodegroupScaling } from "@twizz-idp/core";
import type { LiveClusterPort, LivePodProblem, LiveResources, LiveState, LiveTarget, LiveWorkload } from "@twizz-idp/actions";

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
  metadata?: { name?: string; namespace?: string; generation?: number };
  spec?: { replicas?: number; template?: { spec?: { containers?: Array<{ name?: string; resources?: { requests?: Record<string, unknown>; limits?: Record<string, unknown> } }> } } };
  status?: { replicas?: number; readyReplicas?: number; updatedReplicas?: number; availableReplicas?: number; unavailableReplicas?: number; observedGeneration?: number };
};
type HpaItem = {
  metadata?: { name?: string };
  spec?: { scaleTargetRef?: { name?: string }; minReplicas?: number; maxReplicas?: number; metrics?: Array<{ resource?: { name?: string; target?: { averageUtilization?: number } } }> };
  status?: { currentReplicas?: number; desiredReplicas?: number };
};

export type PodItem = {
  metadata?: { name?: string; deletionTimestamp?: Date | string; ownerReferences?: Array<{ kind?: string; name?: string }> };
  status?: {
    phase?: string;
    conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>;
    containerStatuses?: Array<{ name?: string; state?: { waiting?: { reason?: string; message?: string } }; lastState?: { terminated?: { reason?: string } }; restartCount?: number }>;
  };
};

const STUCK_WAITING = new Set(["CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull", "CreateContainerConfigError", "CreateContainerError", "InvalidImageName", "RunContainerError"]);
const STUCK_TERMINATING_MS = 5 * 60_000;

/** Pods a resize can strand or reveal: unschedulable, crash/pull loops, stuck terminating
 * (e.g. a PodDisruptionBudget holding a drain). Names + reasons only — never env or logs. */
export function podProblems(namespace: string, items: PodItem[], now = Date.now()): LivePodProblem[] {
  const out: LivePodProblem[] = [];
  for (const p of items ?? []) {
    const pod = p.metadata?.name ?? "";
    const rs = p.metadata?.ownerReferences?.find((o) => o.kind === "ReplicaSet")?.name;
    const workload = rs ? rs.replace(/-[a-z0-9]{6,10}$/, "") : undefined;
    const base = { namespace, pod, ...(workload ? { workload } : {}) };
    const del = p.metadata?.deletionTimestamp ? new Date(p.metadata.deletionTimestamp).getTime() : NaN;
    if (Number.isFinite(del) && now - del > STUCK_TERMINATING_MS) {
      out.push({ ...base, reason: "StuckTerminating", message: `terminating for ${Math.round((now - del) / 60_000)} min (a PodDisruptionBudget or finalizer may be holding it)` });
      continue;
    }
    if (p.status?.phase === "Pending") {
      const sched = p.status.conditions?.find((c) => c.type === "PodScheduled" && c.status === "False");
      if (sched) {
        out.push({ ...base, reason: sched.reason ?? "Unschedulable", message: (sched.message ?? "no node fits this pod").slice(0, 300) });
        continue;
      }
    }
    const waiting = p.status?.containerStatuses?.find((c) => c.state?.waiting?.reason && STUCK_WAITING.has(c.state.waiting.reason));
    if (waiting?.state?.waiting) {
      const last = waiting.lastState?.terminated?.reason;
      out.push({ ...base, reason: waiting.state.waiting.reason!, message: [`container ${waiting.name}`, last ? `last exit: ${last}` : "", waiting.restartCount ? `${waiting.restartCount} restarts` : "", (waiting.state.waiting.message ?? "").slice(0, 200)].filter(Boolean).join(" · ") });
    }
  }
  return out;
}

export function liveClusterPort(t: LiveTarget): LiveClusterPort {
  return {
    async read(): Promise<LiveState> {
      const c = await clients(t.cluster);
      const [perNs, nodesRes, apiGroups, nodegroups, problems] = await Promise.all([
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
        // best effort: a failed pod list must not fail the read (plan/apply don't need it)
        Promise.all(t.namespaces.map((ns) => withTimeout(c.core.listNamespacedPod(ns), `pods/${ns}`).then((r) => podProblems(ns, r.body.items as PodItem[]))))
          .then((p) => ({ problems: p.flat().slice(0, 200) }))
          .catch((e: unknown) => ({ problemsError: e instanceof Error ? e.message : String(e) })),
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
            // rollout completion (capacity_verify): the controller saw this spec, and every replica is updated + available
            rollout: { observed: (d.status?.observedGeneration ?? 0) >= (d.metadata?.generation ?? 0), updated: d.status?.updatedReplicas ?? 0, available: d.status?.availableReplicas ?? 0, total: d.status?.replicas ?? 0, unavailable: d.status?.unavailableReplicas ?? 0 },
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
      type NodeItem = { metadata?: { name?: string; labels?: Record<string, string> }; spec?: { unschedulable?: boolean }; status?: { capacity?: Record<string, string>; conditions?: Array<{ type?: string; status?: string }> } };
      const nodes = ((nodesRes.body.items ?? []) as NodeItem[]).map((n) => ({
        name: n.metadata?.name ?? "",
        nodegroup: n.metadata?.labels?.["eks.amazonaws.com/nodegroup"],
        instanceType: n.metadata?.labels?.["node.kubernetes.io/instance-type"],
        cpuCores: cores(n.status?.capacity?.cpu),
        memGi: Math.round(gib(n.status?.capacity?.memory) * 10) / 10,
        ready: (n.status?.conditions ?? []).some((c) => c.type === "Ready" && c.status === "True"),
        schedulable: !n.spec?.unschedulable,
      }));
      const groups = ((apiGroups.body as { groups?: Array<{ name?: string }> }).groups ?? []).map((g) => g.name);
      return { tier: t.tier, cluster: t.cluster, readAt: new Date().toISOString(), workloads, nodegroups, nodes, metricsServer: groups.includes("metrics.k8s.io"), ...problems };
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
