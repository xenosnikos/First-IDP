import { describe, expect, it } from "vitest";
import type { NamedEnvManifest } from "@twizz-idp/actions";
import { selectExpired } from "../expiry";

const env = (name: string, expiresAt: string): NamedEnvManifest => ({
  name,
  service: "moly-backend",
  owner: "nick",
  imageTag: "build-75b95f51-a1de-432d-8132-33a2802f622c",
  expiresAt,
  db: { mode: "isolated", generation: 1 },
  kind: "backend",
  frontendOrigins: [],
});

describe("selectExpired", () => {
  const now = new Date("2026-09-07T12:00:00Z");
  it("tears down only envs whose expiresAt is in the past", () => {
    const d = selectExpired([env("old", "2026-09-06T12:00:00Z"), env("fresh", "2026-09-14T00:00:00Z"), env("edge", "2026-09-07T12:00:00Z")], now);
    expect(d).toEqual([
      { name: "old", action: "teardown", expiresAt: "2026-09-06T12:00:00Z", overdueHours: 24 },
      { name: "fresh", action: "keep", reason: "expires 2026-09-14T00:00:00Z" },
      { name: "edge", action: "keep", reason: "expires 2026-09-07T12:00:00Z" },
    ]);
  });
  it("keeps (never tears down) an env with an unparseable date", () => {
    expect(selectExpired([env("broken", "soon")], now)[0]).toMatchObject({ action: "keep", reason: /unparseable/ });
  });
  it("accepts the smoke manifest's second-precision format", () => {
    expect(selectExpired([env("smoke", "2026-09-14T00:00:00Z")], now)[0].action).toBe("keep");
    expect(selectExpired([env("smoke", "2026-09-14T00:00:00Z")], new Date("2026-09-15T00:00:00Z"))[0]).toMatchObject({ action: "teardown", overdueHours: 24 });
  });
});
