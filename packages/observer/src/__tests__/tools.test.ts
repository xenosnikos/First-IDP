import { describe, expect, it } from "vitest";
import { budgetVerdict, MemoryBudget } from "../budget";
import { normalizeHistory } from "../run";
import { fetchLogs, listPods, logHistogram, OBSERVER_TOOLS } from "../tools";
import { clampWindow, podWithinScope } from "../tools/scope";
import type { ObserverCtx, ObserverDeps, ObserverScope } from "../tools/types";

const scope: ObserverScope = { cluster: "EKS-Moly-Prod", namespace: "jobs", pod: "email-service", from: "2026-09-10T07:00:00.000Z", to: "2026-09-10T07:30:00.000Z" };

function deps(overrides: Partial<ObserverDeps> = {}): ObserverDeps & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async getPodLogs(p) {
      calls.push(p);
      return {
        status: "complete",
        lines: [
          { timestamp: "2026-09-10T07:10:00.000Z", message: "[Nest] 29  - 09/10/2026, 7:10:00 AM   ERROR [TasksService] boom Authorization: Bearer abcDEF123456789xyz", podName: "email-service-deployment-984d98f7b-m5qts", containerName: "email-service" },
          { timestamp: "2026-09-10T07:10:00.001Z", message: "    at TasksService.run (/app/src/x.ts:1:2)", podName: "email-service-deployment-984d98f7b-m5qts", containerName: "email-service" },
          { timestamp: "2026-09-10T07:15:00.000Z", message: "[Nest] 29  - 09/10/2026, 7:15:00 AM   DEBUG [TasksService] Cron running every 15 mins", podName: "email-service-deployment-984d98f7b-m5qts", containerName: "email-service" },
        ],
      };
    },
    async getLogHistogram(p) {
      calls.push(p);
      return { status: "complete", binMinutes: p.binMinutes ?? 15, bins: [{ t: "2026-09-10 07:00:00.000", n: 3 }, { t: "2026-09-10 07:15:00.000", n: 9 }] };
    },
    async getLivePods() {
      return [
        { podName: "email-service-deployment-984d98f7b-m5qts", namespace: "jobs", containerName: "email-service", status: "Running", restarts: 0 },
        { podName: "payment-serv-deployment-59d6764c8f-6674x", namespace: "jobs", containerName: "payment-serv", status: "Running", restarts: 3 },
        { podName: "other-abc12", namespace: "default", containerName: "other", status: "Running", restarts: 0 },
      ];
    },
    ...overrides,
  };
}

const ctx = (d: ObserverDeps, s: ObserverScope = scope): ObserverCtx => ({ scope: s, deps: d, notes: {}, redactions: {} });

describe("scope guard", () => {
  it("clamps offsets inside the window", () => {
    const w = clampWindow(scope, { fromOffsetMin: 10, toOffsetMin: -5 });
    expect(w.from.toISOString()).toBe("2026-09-10T07:10:00.000Z");
    expect(w.to.toISOString()).toBe("2026-09-10T07:25:00.000Z");
    expect(w.clamped).toBe(false);
    const wide = clampWindow(scope, { fromOffsetMin: 0, toOffsetMin: 0 });
    expect(wide.from.toISOString()).toBe(scope.from);
    const inverted = clampWindow(scope, { fromOffsetMin: 29, toOffsetMin: -29 });
    expect(inverted.clamped).toBe(true);
    expect(inverted.to.getTime()).toBeGreaterThan(inverted.from.getTime());
  });

  it("lets the model narrow the pod but never widen it", () => {
    expect(podWithinScope(scope, undefined)).toEqual({ ok: true, pod: "email-service" });
    expect(podWithinScope(scope, "email-service-deployment-984d98f7b-m5qts").ok).toBe(true);
    expect(podWithinScope(scope, "payment-serv").ok).toBe(false);
    expect(podWithinScope({ ...scope, pod: undefined }, "payment-serv")).toEqual({ ok: true, pod: "payment-serv" });
    expect(podWithinScope(scope, 'bad"name').ok).toBe(false);
  });

  it("tool schemas never accept cluster or namespace", () => {
    for (const t of OBSERVER_TOOLS) {
      const r = t.input.safeParse({ cluster: "EKS-Moly-Prod", namespace: "default" });
      expect(r.success, t.name).toBe(false);
    }
  });
});

describe("tools", () => {
  it("fetch_logs queries in seconds within scope, compacts and redacts", async () => {
    const d = deps();
    const out = await fetchLogs.run({ fromOffsetMin: 5, limit: 100 }, ctx(d));
    const q = d.calls[0] as { startTime: number; endTime: number; podName?: string; limit: number };
    expect(q.startTime).toBe(Math.floor(Date.parse("2026-09-10T07:05:00Z") / 1000));
    expect(q.endTime).toBe(Math.floor(Date.parse("2026-09-10T07:30:00Z") / 1000));
    expect(q.podName).toBe("email-service");
    expect(out).toContain("query complete");
    expect(out).toContain("[ERROR ×1");
    expect(out).toContain("[REDACTED:bearer]");
    expect(out).not.toContain("abcDEF123456789xyz");
    expect(out).toContain("query status: complete");
  });

  it("fetch_logs refuses to widen the pod and rejects unsafe regex", async () => {
    const d = deps();
    expect(await fetchLogs.run({ pod: "payment-serv" }, ctx(d))).toContain("outside the selected scope");
    expect(await fetchLogs.run({ filter: "(a+)+" }, ctx(d))).toContain("filter rejected");
    expect(d.calls).toHaveLength(0);
  });

  it("fetch_logs says timeout is not 'no logs'", async () => {
    const d = deps({ async getPodLogs() { return { status: "timeout", lines: [] }; } });
    const out = await fetchLogs.run({}, ctx(d));
    expect(out).toContain("TIMED OUT");
    expect(out).toContain("query status: timeout");
  });

  it("errorsOnly keeps error records with their frames and drops debug", async () => {
    const out = await fetchLogs.run({ errorsOnly: true }, ctx(deps()));
    expect(out).toContain("[ERROR ×1");
    expect(out).not.toContain("[DEBUG");
    expect(out).toContain("at TasksService.run");
  });

  it("log_histogram and list_pods stay inside the namespace/pod scope", async () => {
    const d = deps();
    const h = await logHistogram.run({ binMinutes: 15 }, ctx(d));
    expect(h).toContain("total=12 peak=9");
    const pods = await listPods.run({}, ctx(d));
    expect(pods).toContain("email-service-deployment");
    expect(pods).not.toContain("payment-serv");
    expect(pods).not.toContain("other-abc12");
    const all = await listPods.run({}, ctx(d, { ...scope, pod: undefined }));
    expect(all).toContain("payment-serv");
  });
});

describe("budget + history", () => {
  it("denies per-actor first, then globally", () => {
    expect(budgetVerdict({ runsToday: 1, actorRunsToday: 0, dailyCap: 40, perActorCap: 15 }).word).toBe("PASS");
    expect(budgetVerdict({ runsToday: 1, actorRunsToday: 15, dailyCap: 40, perActorCap: 15 }).reason).toMatch(/you have used/);
    expect(budgetVerdict({ runsToday: 40, actorRunsToday: 1, dailyCap: 40, perActorCap: 15 }).reason).toMatch(/Nebula has used/);
  });

  it("MemoryBudget counts per day and actor", async () => {
    const b = new MemoryBudget(2, 3);
    expect(await b.tryConsume("a")).toBe(true);
    expect(await b.tryConsume("a")).toBe(true);
    expect(await b.tryConsume("a")).toBe(false);
    expect(await b.tryConsume("b")).toBe(true);
    expect(await b.tryConsume("c")).toBe(false); // global cap 3
  });

  it("normalizes history: bounded, alternating, starts with user", () => {
    const h = normalizeHistory([
      { role: "assistant", content: "orphan" },
      { role: "user", content: "q1" },
      { role: "user", content: "q1b" },
      { role: "assistant", content: "a1" },
    ]);
    expect(h[0]).toEqual({ role: "user", content: "q1\n\nq1b" });
    expect(h).toHaveLength(2);
    const many = normalizeHistory(Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `t${i}` }) as const));
    expect(many[0].content).toBe("[earlier turns omitted]");
    expect(many.length).toBeLessThanOrEqual(14);
    expect(normalizeHistory([{ role: "user", content: "x".repeat(9000) }])[0].content).toHaveLength(8002);
  });
});
