import { deploymentOf } from "@twizz-idp/observer/logs";

export { deploymentOf };

/** Group pod names by their owner (Deployment/StatefulSet/DaemonSet) by name shape. */
export function groupPodsByDeployment<T extends { podName: string }>(pods: T[]): Array<{ deployment: string; pods: T[] }> {
  const map = new Map<string, T[]>();
  for (const p of pods) {
    const d = deploymentOf(p.podName);
    map.set(d, [...(map.get(d) ?? []), p]);
  }
  return [...map.entries()].map(([deployment, ps]) => ({ deployment, pods: ps })).sort((a, b) => a.deployment.localeCompare(b.deployment));
}
