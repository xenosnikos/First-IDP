import { describe, expect, it } from "vitest";
import { archiveQueryPlan } from "../archive";

const base = { env: "prod" as const, from: "2026-11-05T23:00:00Z", to: "2026-11-06T01:00:00Z" };

describe("archiveQueryPlan", () => {
  it("binds every caller value as a parameter, quoting strings and not the epoch bounds", () => {
    const p = archiveQueryPlan({ ...base, contains: "it's 50%_x", pod: "twizz-sentinel" });
    expect(p.days).toEqual(["2026-11-05", "2026-11-06"]);
    expect(p.sql).not.toContain("it");
    expect(p.sql).not.toContain("twizz-sentinel");
    expect(p.sql.match(/\?/g)?.length).toBe(p.params.length);
    expect(p.params).toEqual([
      "'prod'", "'2026-11-05'", "'2026-11-06'",
      String(Date.parse(base.from)), String(Date.parse(base.to)),
      "'%it''s 50\\%\\_x%'", "'twizz-sentinel%'",
    ]);
  });
  it("caps the limit and rejects bad shapes", () => {
    expect(archiveQueryPlan({ ...base, limit: 99999 }).sql).toMatch(/LIMIT 1000$/);
    expect(archiveQueryPlan(base).sql).toMatch(/LIMIT 200$/);
    expect(() => archiveQueryPlan({ ...base, env: "dev" as never })).toThrow(/env/);
    expect(() => archiveQueryPlan({ ...base, to: "2026-11-20T00:00:00Z" })).toThrow(/7 days/);
    expect(() => archiveQueryPlan({ ...base, to: base.from })).toThrow(/to > from/);
    expect(() => archiveQueryPlan({ ...base, contains: "ab" })).toThrow(/contains/);
    expect(() => archiveQueryPlan({ ...base, pod: "x' OR 1=1" })).toThrow(/pod/);
  });
});
