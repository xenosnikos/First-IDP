import { describe, expect, it } from "vitest";
import type { BuildRun, NamedEnvManifest } from "@twizz-idp/actions";
import { decideBuild, pendingKeepAlive } from "../builds";
import { selectExpired } from "../expiry";

const NOW = new Date("2026-09-10T12:10:00Z");
const m = (over: Partial<NamedEnvManifest["build"]> = {}, startedAt = "2026-09-10T12:00:00.000Z"): NamedEnvManifest => ({
  name: "x",
  kind: "backend",
  service: "twizz-sentinel",
  owner: "o",
  expiresAt: "2026-09-17T12:00:00.000Z",
  db: { mode: "none", generation: 0 },
  frontendOrigins: [],
  source: { repo: "twizz-app/twizz-sentinel", ref: "main", sha: "a".repeat(40) },
  build: { status: "PENDING", expectedTag: "nb-x-aaaaaaaaaaaa", startedAt, ...over },
});
const run = (over: Partial<BuildRun> = {}): BuildRun => ({ id: 7, url: "https://gh/runs/7", status: "in_progress", createdAt: "2026-09-10T12:00:30Z", ...over });

describe("decideBuild", () => {
  it("attaches a found run, waits while running, fails after the no-run grace", () => {
    expect(decideBuild(m(), run(), false, NOW)).toEqual({ action: "attach-run", runId: 7, runUrl: "https://gh/runs/7" });
    expect(decideBuild(m({ status: "RUNNING", runId: 7 }), run(), false, NOW).action).toBe("wait");
    expect(decideBuild(m(), null, false, new Date("2026-09-10T12:02:00Z")).action).toBe("wait");
    expect(decideBuild(m(), null, false, NOW)).toMatchObject({ action: "fail", reason: expect.stringMatching(/no workflow run/) });
  });
  it("promotes only when the run succeeded AND the tag is in ECR", () => {
    const done = run({ status: "completed", conclusion: "success" });
    expect(decideBuild(m({ status: "RUNNING", runId: 7 }), done, true, NOW)).toEqual({ action: "promote", imageTag: "nb-x-aaaaaaaaaaaa", runUrl: "https://gh/runs/7" });
    expect(decideBuild(m({ status: "RUNNING", runId: 7 }), done, false, NOW)).toMatchObject({ action: "fail", reason: expect.stringMatching(/not in ECR/) });
    expect(decideBuild(m({ status: "RUNNING", runId: 7 }), run({ status: "completed", conclusion: "failure" }), true, NOW)).toMatchObject({ action: "fail", reason: "build failure" });
  });
  it("times out a run after 45 min, leaves FAIL alone, drops a stale PASS copy", () => {
    expect(decideBuild(m({ status: "RUNNING", runId: 7 }, "2026-09-10T11:00:00.000Z"), run(), false, NOW)).toMatchObject({ action: "fail", reason: expect.stringMatching(/45 min/) });
    expect(decideBuild(m({ status: "FAIL" }), null, false, NOW).action).toBe("wait");
    expect(decideBuild(m({ status: "PASS" }), null, false, NOW).action).toBe("retry-delete");
  });
});

describe("expiry with pending envs", () => {
  it("keeps a young in-flight build even if expired, tears down stale pending", () => {
    const expired = { ...m(), expiresAt: "2026-09-10T11:00:00.000Z" };
    expect(pendingKeepAlive(expired, NOW)).toBe(true);
    expect(selectExpired([], NOW, [expired])[0].action).toBe("keep");
    const old = { ...m({}, "2026-09-10T08:00:00.000Z"), expiresAt: "2026-09-10T11:00:00.000Z" };
    expect(selectExpired([], NOW, [old])[0].action).toBe("teardown");
    const failed = { ...m({ status: "FAIL" }), expiresAt: "2026-09-10T11:00:00.000Z" };
    expect(selectExpired([], NOW, [failed])[0].action).toBe("teardown");
  });
});
