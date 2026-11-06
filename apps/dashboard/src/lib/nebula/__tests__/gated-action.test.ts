import { describe, expect, it } from "vitest";
import { TRPCClientError } from "@trpc/client";
import { mayHaveWritten, responseLost } from "../use-gated-action";

// A dropped confirm (browser "Failed to fetch", nginx 499, proxy 502/504) must never read as
// FAIL: the server keeps running the action (2026-11-06: prod resized while the UI said FAIL).
describe("responseLost", () => {
  it("is true for a network failure", () => {
    expect(responseLost(new TRPCClientError("Failed to fetch", { cause: new TypeError("Failed to fetch") }))).toBe(true);
    expect(responseLost(new TypeError("Failed to fetch"))).toBe(true);
    expect(responseLost(undefined)).toBe(true);
  });
  it("is false for a tRPC error response from the server", () => {
    const e = TRPCClientError.from({ error: { message: "FORBIDDEN", code: -32003, data: { code: "FORBIDDEN", httpStatus: 403 } } });
    expect(responseLost(e)).toBe(false);
  });
});

describe("mayHaveWritten", () => {
  it("refreshes after done or unknown, not after error/denied", () => {
    expect(mayHaveWritten({ kind: "done", result: {} })).toBe(true);
    expect(mayHaveWritten({ kind: "unknown", message: "Failed to fetch" })).toBe(true);
    expect(mayHaveWritten({ kind: "error", message: "x" })).toBe(false);
    expect(mayHaveWritten({ kind: "denied", reason: "x" })).toBe(false);
  });
});
