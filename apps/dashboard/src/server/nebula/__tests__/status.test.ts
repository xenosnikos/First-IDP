import { describe, expect, it } from "vitest";
import { STATUS_WORDS, argoWord, fmtDuration, toneOf, ttlWord } from "@/lib/nebula/status";

describe("argoWord — Argo Application → honest word", () => {
  it("Healthy + Synced → PASS", () => {
    expect(argoWord({ sync: "Synced", health: "Healthy" })).toEqual({ word: "PASS", detail: "Synced · Healthy" });
  });
  it("Progressing → RUNNING", () => {
    expect(argoWord({ sync: "Synced", health: "Progressing" }).word).toBe("RUNNING");
    expect(argoWord({ sync: "OutOfSync", health: "Progressing" }).word).toBe("RUNNING");
  });
  it("Healthy but still syncing (new image landing) → RUNNING, not PASS", () => {
    expect(argoWord({ sync: "OutOfSync", health: "Healthy" }).word).toBe("RUNNING");
  });
  it("Degraded / Missing → FAIL", () => {
    expect(argoWord({ sync: "Synced", health: "Degraded" }).word).toBe("FAIL");
    expect(argoWord({ sync: "Synced", health: "Missing" }).word).toBe("FAIL");
  });
  it("cluster unreachable → UNKNOWN, never faked", () => {
    expect(argoWord({ sync: null, health: null, unreachable: true })).toEqual({ word: "UNKNOWN", detail: "cluster unreachable" });
  });
  it("manifest exists but no Application yet → PENDING", () => {
    expect(argoWord({ sync: null, health: null }).word).toBe("PENDING");
  });
  it("Suspended / Unknown health → UNKNOWN", () => {
    expect(argoWord({ sync: "Synced", health: "Suspended" }).word).toBe("UNKNOWN");
    expect(argoWord({ sync: "Unknown", health: "Unknown" }).word).toBe("UNKNOWN");
  });
});

describe("ttlWord — expiry → word + countdown", () => {
  const now = new Date("2026-09-07T12:00:00Z");
  it("past → EXPIRED", () => {
    expect(ttlWord("2026-09-07T10:30:00Z", now)).toEqual({ word: "EXPIRED", remaining: "1h 30m ago" });
  });
  it("< 24h → EXPIRING", () => {
    expect(ttlWord("2026-09-08T02:00:00Z", now)).toEqual({ word: "EXPIRING", remaining: "in 14h 0m" });
  });
  it(">= 24h → no pill, plain countdown", () => {
    expect(ttlWord("2026-09-13T00:00:00Z", now)).toEqual({ word: null, remaining: "in 5d 12h" });
  });
  it("garbage → UNKNOWN", () => {
    expect(ttlWord("not-a-date", now).word).toBe("UNKNOWN");
  });
  it("fmtDuration", () => {
    expect(fmtDuration(90_000)).toBe("1m");
    expect(fmtDuration(3 * 3_600_000 + 5 * 60_000)).toBe("3h 5m");
  });
});

describe("brand: every word has exactly one tone; Ember only for the human gate", () => {
  it("all words map", () => {
    for (const w of STATUS_WORDS) expect(["ion", "pass", "fail", "pending", "ember", "muted"]).toContain(toneOf(w));
  });
  it("AWAITING HUMAN is the only Ember word", () => {
    expect(STATUS_WORDS.filter((w) => toneOf(w) === "ember")).toEqual(["AWAITING HUMAN"]);
  });
});
