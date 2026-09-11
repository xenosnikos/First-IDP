// Pure decision table for the build-watcher (docs/NEBULA.md §N3.7). One
// pending manifest + what GitHub/ECR say → one action. No I/O here.
import type { BuildRun, NamedEnvManifest } from "@twizz-idp/actions";

export const NO_RUN_GRACE_MS = 3 * 60_000;
export const RUN_TIMEOUT_MS = 45 * 60_000;

export type BuildDecision =
  | { action: "attach-run"; runId: number; runUrl: string }
  | { action: "promote"; imageTag: string; runUrl?: string }
  | { action: "fail"; reason: string; runUrl?: string }
  | { action: "wait"; reason: string }
  | { action: "retry-delete"; reason: string };

export function decideBuild(m: NamedEnvManifest, run: BuildRun | null, imageExists: boolean, now: Date): BuildDecision {
  const b = m.build;
  if (!b) return { action: "fail", reason: "pending manifest has no build block" };
  const age = now.getTime() - Date.parse(b.startedAt);
  if (b.status === "PASS") return { action: "retry-delete", reason: "already promoted; pending copy left behind" };
  if (b.status === "FAIL") return { action: "wait", reason: "failed; waiting for a rebuild or expiry" };
  if (!run) {
    if (b.runId != null) return { action: "wait", reason: `run ${b.runId} not readable yet` };
    if (age > NO_RUN_GRACE_MS) return { action: "fail", reason: `no workflow run appeared within ${NO_RUN_GRACE_MS / 60_000} min of dispatch` };
    return { action: "wait", reason: "waiting for the run to appear" };
  }
  if (b.runId == null) return { action: "attach-run", runId: run.id, runUrl: run.url };
  if (run.status !== "completed") {
    if (age > RUN_TIMEOUT_MS) return { action: "fail", reason: `build still running after ${RUN_TIMEOUT_MS / 60_000} min`, runUrl: run.url };
    return { action: "wait", reason: `run ${run.id} ${run.status}` };
  }
  if (run.conclusion !== "success") return { action: "fail", reason: `build ${run.conclusion ?? "ended without a conclusion"}`, runUrl: run.url };
  if (!imageExists) return { action: "fail", reason: `build succeeded but ${b.expectedTag} is not in ECR`, runUrl: run.url };
  return { action: "promote", imageTag: b.expectedTag, runUrl: run.url };
}

/** Pending envs are torn down when expired, unless a build is genuinely in flight. */
export function pendingKeepAlive(m: NamedEnvManifest, now: Date): boolean {
  const b = m.build;
  if (!b) return false;
  return (b.status === "PENDING" || b.status === "RUNNING") && now.getTime() - Date.parse(b.startedAt) < 2 * 3_600_000;
}
