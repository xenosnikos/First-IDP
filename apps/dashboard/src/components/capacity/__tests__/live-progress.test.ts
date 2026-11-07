import { describe, expect, it } from "vitest";
import { progressHeadline } from "../live-progress";

type Check = NonNullable<Parameters<typeof progressHeadline>[0]>;
const check = (verdict: Check["verdict"], issues: Check["issues"] = []): Check => ({ verdict, workloads: [], nodegroups: [], issues });

describe("progressHeadline", () => {
  it("PENDING before the first read, UNKNOWN when reads fail", () => {
    expect(progressHeadline(undefined, 0, false).word).toBe("PENDING");
    expect(progressHeadline(undefined, 0, true).word).toBe("UNKNOWN");
  });
  it("PASS on READY, FAIL on MISMATCH", () => {
    expect(progressHeadline(check("READY"), 1000, false).word).toBe("PASS");
    expect(progressHeadline(check("MISMATCH"), 1000, false).word).toBe("FAIL");
  });
  it("RUNNING while converging; WATCH when slow or blocked", () => {
    expect(progressHeadline(check("PROGRESSING"), 60_000, false).word).toBe("RUNNING");
    expect(progressHeadline(check("PROGRESSING"), 11 * 60_000, false).word).toBe("WATCH");
    expect(progressHeadline(check("PROGRESSING", [{ kind: "pod", subject: "x", reason: "Unschedulable", message: "m" }]), 60_000, false).word).toBe("WATCH");
    // a pod stopping slowly alone doesn't escalate early
    expect(progressHeadline(check("PROGRESSING", [{ kind: "pod", subject: "x", reason: "StuckTerminating", message: "m" }]), 60_000, false).word).toBe("RUNNING");
  });
});
