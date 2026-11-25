import { describe, expect, it } from "vitest";
import { argoStatusFor, toArgoStatus } from "../argo";
import { argoRunsImage } from "../lifecycle-model";

// external review 2026-11-25, idp #3 / gitops #6: Synced + Healthy says nothing about WHICH image an
// Application runs. For the minutes between a gitops change and Argo's next poll it still describes the
// previous one — so what Nebula reads of an Application includes the images its pods run and when its
// last sync finished.
describe("toArgoStatus", () => {
  const ECR = "848281935985.dkr.ecr.eu-west-1.amazonaws.com";
  const app = (status: Record<string, unknown>) => ({ metadata: { name: "staging-twizz-sentinel" }, status });

  it("reads sync, health, the live images and the finish time of the last successful sync", () => {
    const s = toArgoStatus(
      app({
        sync: { status: "Synced", revision: "abc" },
        health: { status: "Healthy" },
        summary: { images: [`${ECR}/twizz-sentinel:main-old`, "redis:7-alpine"] },
        operationState: { phase: "Succeeded", finishedAt: "2026-11-25T10:00:00Z" },
      }),
    );
    expect(s).toEqual({ sync: "Synced", health: "Healthy", images: [`${ECR}/twizz-sentinel:main-old`, "redis:7-alpine"], operationFinishedAt: "2026-11-25T10:00:00Z" });
    // the lag window: gitops already names the new tag, Argo still reports the old pods
    expect(argoRunsImage(s.images, "twizz-sentinel", "nb-plo-2611-twizz-sentinel-a1a1a1a1a1a1")).toBe(false);
    expect(argoRunsImage(s.images, "twizz-sentinel", "main-old")).toBe(true);
  });

  it("a sync that is running, failed or absent has no finish time; missing or malformed images are no images", () => {
    expect(toArgoStatus(app({ sync: { status: "Synced" }, health: { status: "Healthy" }, operationState: { phase: "Running", finishedAt: "2026-11-25T10:00:00Z" } })).operationFinishedAt).toBeNull();
    expect(toArgoStatus(app({ operationState: { phase: "Failed", finishedAt: "2026-11-25T10:00:00Z" } })).operationFinishedAt).toBeNull();
    expect(toArgoStatus(app({ operationState: { phase: "Succeeded", finishedAt: "not a date" } })).operationFinishedAt).toBeNull();
    expect(toArgoStatus(app({ sync: { status: "Synced" }, health: { status: "Healthy" } }))).toEqual({ sync: "Synced", health: "Healthy", images: [], operationFinishedAt: null });
    expect(toArgoStatus(app({ summary: { images: "nope" } })).images).toEqual([]);
    expect(toArgoStatus(app({ summary: { images: ["a:1", 7, null, ""] } })).images).toEqual(["a:1"]);
    expect(toArgoStatus({})).toEqual({ sync: "Unknown", health: "Unknown", images: [], operationFinishedAt: null });
  });

  it("an unreachable cluster or an unknown Application reports nothing that could pass for a rollout", () => {
    const none = argoStatusFor({ reachable: true, apps: {} }, "staging-twizz-sentinel");
    expect(argoRunsImage(none.images, "twizz-sentinel", "t")).toBe(false);
    const down = argoStatusFor({ reachable: false, reason: "timeout", apps: {} }, "staging-twizz-sentinel");
    expect(down).toMatchObject({ unreachable: true });
    expect(argoRunsImage(down.images, "twizz-sentinel", "t")).toBe(false);
  });
});
