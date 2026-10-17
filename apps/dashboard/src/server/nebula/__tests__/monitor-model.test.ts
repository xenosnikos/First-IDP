import { describe, expect, it } from "vitest";
import { STATUS_WORDS } from "@/lib/nebula/status";
import { MONITOR_TARGETS, combine, deriveSignals, level, qid, recent, snapEnd, staleMs, sumAll, tgLabel, type Series } from "../monitor-model";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const flat = (v: number, n = 10, endMs = NOW - 60_000): Series => Array.from({ length: n }, (_, i) => [endMs - (n - 1 - i) * 60_000, v]);

describe("series maths", () => {
  it("recent() averages the trailing 5 minutes of data", () => {
    const s: Series = [...flat(10, 10, NOW - 6 * 60_000), ...flat(40, 5)];
    expect(recent(s)).toBe(40);
  });
  it("combine() aligns on timestamps and treats a missing side as 0", () => {
    expect(combine([[1, 2], [2, 3]], [[2, 10], [3, 1]], (a, b) => a + b)).toEqual([[1, 2], [2, 13], [3, 1]]);
    expect(sumAll([[[1, 1]], [[1, 2]], undefined])).toEqual([[1, 3]]);
  });
  it("tgLabel() reads the service out of an AWS LB controller target group", () => {
    expect(tgLabel("targetgroup/k8s-default-molyback-af57ae3b98/0123456789abcdef")).toBe("molyback");
    expect(tgLabel("targetgroup/TG-MOLY-API/abc")).toBe("TG-MOLY-API");
  });
  it("qid() always yields a valid CloudWatch id", () => {
    for (const id of [qid("w", 0, "cpu"), qid("tg", 12, "p95"), qid("1x", "a-b")]) expect(id).toMatch(/^[a-z][A-Za-z0-9_]*$/);
  });
});

describe("signals", () => {
  it("levels: OK below watch, WATCH, HOT; UNKNOWN when missing", () => {
    expect([level(10, 70, 85), level(70, 70, 85), level(90, 70, 85), level(undefined, 70, 85)]).toEqual(["OK", "WATCH", "HOT", "UNKNOWN"]);
  });

  it("every signal word is a brand status word", () => {
    const sig = deriveSignals({
      now: NOW,
      traffic: { rps: flat(60), p95: flat(0.2), errPct: flat(0.1) },
      nodes: { cpu: flat(8), mem: flat(14), cpuMax: flat(12) },
      nodegroups: [{ name: "a", desired: 3, max: 5 }],
      workloads: [{ name: "moly-backend-deployment", ready: 30, replicas: 30 }],
      atlas: [{ cluster: "Moly-Prod", cpu: flat(5), conns: flat(1051), connLimit: 32000, targeting: flat(800) }],
    });
    for (const s of sig) expect(STATUS_WORDS).toContain(s.word);
    expect(sig.every((s) => s.word === "OK")).toBe(true);
  });

  it("flags error rate, slow p95, hot nodes, a full node group and short workloads", () => {
    const sig = Object.fromEntries(
      deriveSignals({
        now: NOW,
        traffic: { rps: flat(100), p95: flat(3.5), errPct: flat(2) },
        nodes: { cpu: flat(88), mem: flat(50), cpuMax: flat(95) },
        nodegroups: [{ name: "m5", desired: 5, max: 5 }],
        workloads: [{ name: "api", ready: 10, replicas: 30 }],
        restarts: [{ name: "api", delta: 3 }],
      }).map((s) => [s.key, s]),
    );
    expect(sig.err.word).toBe("WATCH");
    expect(sig.p95.word).toBe("HOT");
    expect(sig.nodecpu.word).toBe("HOT");
    expect(sig.headroom.word).toBe("WATCH");
    expect(sig.headroom.detail).toMatch(/raise max/);
    expect(sig.pods.word).toBe("HOT");
    expect(sig.pods.detail).toMatch(/api 10\/30.*\+3 restart/);
  });

  it("stale data is UNKNOWN, never a reassuring OK", () => {
    const old = flat(5, 10, NOW - 20 * 60_000);
    const sig = deriveSignals({ now: NOW, traffic: { rps: old, p95: old, errPct: old }, nodes: { cpu: old, mem: old, cpuMax: old }, atlas: [{ cluster: "Moly-Prod", cpu: old, conns: old, targeting: old }] });
    expect(sig.map((s) => s.word)).toEqual(["UNKNOWN", "UNKNOWN", "UNKNOWN", "UNKNOWN", "UNKNOWN"]);
  });

  it("database: connections near the tier limit are HOT; query targeting only ever WATCHes", () => {
    const [db] = deriveSignals({ now: NOW, atlas: [{ cluster: "Prod-Shift4", cpu: flat(10), conns: flat(2900), connLimit: 3000, targeting: flat(10) }] }).filter((s) => s.key.startsWith("db-"));
    expect(db.word).toBe("HOT");
    const [scan] = deriveSignals({ now: NOW, atlas: [{ cluster: "Moly-Prod", cpu: flat(10), conns: flat(10), connLimit: 32000, targeting: flat(50_000) }] }).filter((s) => s.key.startsWith("db-"));
    expect(scan.word).toBe("WATCH");
    expect(scan.detail).toMatch(/missing index/);
  });
});

describe("coarse windows", () => {
  it("snap the end to the last complete bucket and widen staleness", () => {
    expect(snapEnd(Date.parse("2026-10-17T12:07:30Z"), 900)).toBe(Date.parse("2026-10-17T12:00:00Z"));
    expect(staleMs(60)).toBe(6 * 60_000);
    expect(staleMs(900)).toBe(33 * 60_000);
  });
  it("a 24h window's last bucket 14 min old is still fresh, and reads that bucket", () => {
    const pts: Series = [[NOW - 29 * 60_000, 10], [NOW - 14 * 60_000, 50]];
    const [rps] = deriveSignals({ now: NOW, period: 900, traffic: { rps: pts, p95: pts, errPct: [[NOW - 14 * 60_000, 0]] } });
    expect(rps.word).toBe("OK");
    expect(rps.value).toBe("50.0 rps");
  });
});

describe("targets", () => {
  it("monitors exactly the two Moly clusters, never NonProd", () => {
    expect(Object.values(MONITOR_TARGETS).map((t) => t.cluster).sort()).toEqual(["EKS-Moly-Prod", "EKS-Moly-staging"]);
  });
});
