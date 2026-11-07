import { describe, expect, it } from "vitest";
import { podProblems, type PodItem } from "../live-cluster";

const NOW = Date.parse("2026-11-07T08:00:00Z");
const rs = (name: string) => [{ kind: "ReplicaSet", name }];

describe("podProblems", () => {
  it("flags unschedulable pods with the scheduler's message and the owning deployment", () => {
    const items: PodItem[] = [
      { metadata: { name: "moly-backend-deployment-7f9c6d5b8-abcde", ownerReferences: rs("moly-backend-deployment-7f9c6d5b8") }, status: { phase: "Pending", conditions: [{ type: "PodScheduled", status: "False", reason: "Unschedulable", message: "0/5 nodes are available: 5 Insufficient cpu." }] } },
    ];
    expect(podProblems("default", items, NOW)).toEqual([
      { namespace: "default", pod: "moly-backend-deployment-7f9c6d5b8-abcde", workload: "moly-backend-deployment", reason: "Unschedulable", message: "0/5 nodes are available: 5 Insufficient cpu." },
    ]);
  });

  it("flags crash / image-pull loops, not normal starts", () => {
    const items: PodItem[] = [
      { metadata: { name: "a", ownerReferences: rs("alert-service-5d8f7c9b6") }, status: { phase: "Running", containerStatuses: [{ name: "app", state: { waiting: { reason: "CrashLoopBackOff", message: "back-off 5m0s" } }, lastState: { terminated: { reason: "OOMKilled" } }, restartCount: 7 }] } },
      { metadata: { name: "b" }, status: { phase: "Pending", containerStatuses: [{ name: "app", state: { waiting: { reason: "ContainerCreating" } } }] } },
    ];
    const r = podProblems("default", items, NOW);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ workload: "alert-service", reason: "CrashLoopBackOff" });
    expect(r[0].message).toMatch(/OOMKilled/);
    expect(r[0].message).toMatch(/7 restarts/);
  });

  it("flags pods terminating for more than 5 minutes (a drain held by a PDB), not ones just stopping", () => {
    const items: PodItem[] = [
      { metadata: { name: "old", deletionTimestamp: new Date(NOW - 12 * 60_000).toISOString() }, status: { phase: "Running" } },
      { metadata: { name: "fresh", deletionTimestamp: new Date(NOW - 30_000).toISOString() }, status: { phase: "Running" } },
    ];
    const r = podProblems("jobs", items, NOW);
    expect(r.map((p) => [p.pod, p.reason])).toEqual([["old", "StuckTerminating"]]);
  });
});
