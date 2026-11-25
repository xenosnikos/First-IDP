import { describe, expect, it } from "vitest";
import {
  LIFECYCLE_LIMITS,
  LifecycleCompleteBody,
  LifecycleSnapshotDoc,
  isLifecycleRequestKind,
  lifecycleIssuePaths,
  parseLifecycleRequestParams,
} from "../lifecycle";

const KEY = "0123456789abcdef".repeat(4);
const pr = { repo: "twizz-app/twizz-sentinel", number: 41, url: "https://github.com/twizz-app/twizz-sentinel/pull/41", branch: "plo/2026-11/npm-minor", headSha: "a".repeat(40), title: "Bump express" };
const component = {
  id: "npm:twizz-sentinel:express",
  tier: "npm-direct",
  domain: "npm-dependency",
  name: "express",
  target: "twizz-sentinel",
  environments: ["staging", "prod"],
  current: "4.19.2",
  desired: "4.21.2",
  latest: "5.1.0",
  bump: "minor",
  status: "pr-open",
  autonomy: "pr",
  reasons: ["minor update available"],
  rollback: "supported",
  pr,
};
const base = {
  schemaVersion: 1,
  job: "plan",
  runId: "2026-11-25T06-00-00Z.plan",
  startedAt: "2026-11-25T06:00:00.000Z",
  finishedAt: "2026-11-25T06:02:10.000Z",
  ok: true,
  schedule: [{ job: "plan", cron: "0 6 * * 1", runner: "nebula", description: "weekly plan", mutates: false }],
  discoveryErrors: [],
};
const paths = (input: unknown) => {
  const r = LifecycleSnapshotDoc.safeParse(input);
  return r.success ? [] : lifecycleIssuePaths(r.error).map((i) => `${i.path}:${i.code}`);
};

describe("LifecycleSnapshotDoc", () => {
  it("accepts a plan, a source, a cve and a smoke snapshot", () => {
    expect(LifecycleSnapshotDoc.parse({ ...base, components: [component], changeSets: [{ id: "cs1", stage: "source", target: "twizz-sentinel", domain: "npm-dependency", tier: "npm-direct", autonomy: "pr", status: "pr-open", rationale: [], componentIds: [component.id], pr }] }).components).toHaveLength(1);
    const source = LifecycleSnapshotDoc.parse({
      ...base,
      job: "source",
      bundles: [{ repo: "twizz-sentinel", github: "twizz-app/twizz-sentinel", baseBranch: "main", branch: "plo/bundle/2026-11", headSha: "b".repeat(40), included: [pr], conflicts: [{ pr, files: ["package-lock.json"] }], environments: ["staging"] }],
      bundleKey: KEY,
    });
    expect(source.bundleKey).toBe(KEY);
    const cve = LifecycleSnapshotDoc.parse({
      ...base,
      job: "cve",
      advisories: [{ id: "GHSA-xxxx", aliases: ["CVE-2026-0001"], source: "osv", severity: "high", cvss: 8.1, kev: true, epss: 0.42, summary: "s", url: "https://osv.dev/GHSA-xxxx", affected: [{ componentId: component.id, name: "express", tier: "npm-direct", target: "twizz-sentinel", version: "4.19.2", fixedIn: null, environments: ["staging"] }] }],
    });
    expect(cve.advisories?.[0].kev).toBe(true);
    const smoke = LifecycleSnapshotDoc.parse({ ...base, job: "smoke", requestId: "cmabc123", smoke: { scope: "stg", bundleKey: KEY, results: [{ name: "health", url: "https://sentinel-stg.prv.twizz.com/health", ok: false, status: null, ms: 10_000, detail: "timeout" }] } });
    expect(smoke.smoke?.results[0].status).toBeNull();
  });

  it("requires the envelope and pins schemaVersion, job and runId", () => {
    expect(paths({})).toEqual(expect.arrayContaining(["schemaVersion:invalid_literal", "job:invalid_type", "runId:invalid_type", "schedule:invalid_type", "discoveryErrors:invalid_type"]));
    expect(paths({ ...base, schemaVersion: 2 })).toEqual(["schemaVersion:invalid_literal"]);
    expect(paths({ ...base, job: "dispatch" })).toEqual(["job:invalid_enum_value"]);
    for (const runId of ["", "a b", "../etc", "x".repeat(121), "run/1"]) expect(paths({ ...base, runId })).toEqual(["runId:invalid_string"]);
    expect(paths({ ...base, runId: "A.b_c-1" })).toEqual([]);
  });

  it("wants ISO instants for startedAt / finishedAt", () => {
    expect(paths({ ...base, startedAt: "yesterday" })).toEqual(["startedAt:invalid_string"]);
    expect(paths({ ...base, finishedAt: "2026-11-25" })).toEqual(["finishedAt:invalid_string"]);
    expect(paths({ ...base, finishedAt: "2026-11-25T07:02:10+01:00" })).toEqual([]);
  });

  it("enforces the hard limits: 2000-char strings, 5000 components, 2000 advisories", () => {
    expect(LIFECYCLE_LIMITS).toEqual({ bodyBytes: 4 * 1024 * 1024, components: 5000, advisories: 2000, stringChars: 2000 });
    expect(paths({ ...base, error: "x".repeat(2000) })).toEqual([]);
    expect(paths({ ...base, error: "x".repeat(2001) })).toEqual(["error:too_big"]);
    expect(paths({ ...base, components: [{ ...component, reasons: ["ok", "y".repeat(2001)] }] })).toEqual(["components.0.reasons.1:too_big"]);
    expect(paths({ ...base, components: [{ ...component, pr: { ...pr, title: "t".repeat(2001) } }] })).toEqual(["components.0.pr.title:too_big"]);
    expect(paths({ ...base, discoveryErrors: [{ domain: "helm", error: "e".repeat(2001) }] })).toEqual(["discoveryErrors.0.error:too_big"]);
    expect(paths({ ...base, components: Array.from({ length: 5000 }, () => component) })).toEqual([]);
    expect(paths({ ...base, components: Array.from({ length: 5001 }, () => component) })).toEqual(["components:too_big"]);
    const adv = { id: "A", aliases: [], source: "osv", severity: "low", kev: false, summary: "", url: "", affected: [] };
    expect(paths({ ...base, job: "cve", advisories: Array.from({ length: 2000 }, () => adv) })).toEqual([]);
    expect(paths({ ...base, job: "cve", advisories: Array.from({ length: 2001 }, () => adv) })).toEqual(["advisories:too_big"]);
  });

  it("rejects values outside the closed vocabularies and ranges", () => {
    expect(paths({ ...base, components: [{ ...component, tier: "kernel" }] })).toEqual(["components.0.tier:invalid_enum_value"]);
    expect(paths({ ...base, components: [{ ...component, status: "done" }] })).toEqual(["components.0.status:invalid_enum_value"]);
    expect(paths({ ...base, components: [{ ...component, pr: { ...pr, number: 0 } }] })).toEqual(["components.0.pr.number:too_small"]);
    const adv = { id: "A", aliases: [], source: "osv", severity: "low", kev: false, summary: "", url: "", affected: [] };
    expect(paths({ ...base, advisories: [{ ...adv, epss: 1.2 }] })).toEqual(["advisories.0.epss:too_big"]);
    expect(paths({ ...base, advisories: [{ ...adv, source: "snyk" }] })).toEqual(["advisories.0.source:invalid_enum_value"]);
    expect(paths({ ...base, bundleKey: "not-a-hash" })).toEqual(["bundleKey:invalid_string"]);
    expect(paths({ ...base, smoke: { scope: "prod", bundleKey: KEY, results: [] } })).toEqual(["smoke.scope:invalid_enum_value"]);
  });

  it("strips unknown keys, so Helm values / run.json data can never be stored", () => {
    const parsed = LifecycleSnapshotDoc.parse({ ...base, data: { helm: { values: { password: "hunter2" } } }, env: { TOKEN: "t" }, components: [{ ...component, meta: { values: "secret" } }] });
    expect(JSON.stringify(parsed)).not.toMatch(/hunter2|TOKEN|secret/);
    expect(Object.keys(parsed)).not.toContain("data");
    expect(Object.keys(parsed.components![0])).not.toContain("meta");
  });

  it("reports issue paths and codes only, never the offending value", () => {
    const r = LifecycleSnapshotDoc.safeParse({ ...base, job: "ghp_SECRETSECRETSECRET", runId: "ghp SECRET" });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issues = lifecycleIssuePaths(r.error);
      expect(JSON.stringify(issues)).not.toContain("SECRET");
      expect(issues.every((i) => Object.keys(i).sort().join() === "code,path")).toBe(true);
      expect(lifecycleIssuePaths(r.error, 1)).toHaveLength(1);
    }
  });
});

describe("request params + complete body", () => {
  it("plan and cve take no params (strict)", () => {
    expect(parseLifecycleRequestParams("plan", {})).toEqual({});
    expect(parseLifecycleRequestParams("cve", {})).toEqual({});
    expect(() => parseLifecycleRequestParams("plan", { stage: "prod", execute: true })).toThrow();
    expect(() => parseLifecycleRequestParams("cve", null)).toThrow();
  });

  it("smoke needs a scope, a sha256 bundle key and at least one URL target", () => {
    const ok = { scope: "preview", bundleKey: KEY, targets: [{ name: "twizz-sentinel", baseUrl: "https://plo-2611-twizz-sentinel.prv.twizz.com" }] };
    expect(parseLifecycleRequestParams("smoke", ok)).toEqual(ok);
    expect(() => parseLifecycleRequestParams("smoke", { ...ok, scope: "prod" })).toThrow();
    expect(() => parseLifecycleRequestParams("smoke", { ...ok, bundleKey: "abc" })).toThrow();
    expect(() => parseLifecycleRequestParams("smoke", { ...ok, targets: [] })).toThrow();
    expect(() => parseLifecycleRequestParams("smoke", { ...ok, targets: [{ name: "x", baseUrl: "not a url" }] })).toThrow();
    expect(() => parseLifecycleRequestParams("smoke", { ...ok, targets: [{ name: "x", baseUrl: "https://a.prv.twizz.com", headers: { authorization: "x" } }] })).toThrow();
    expect(() => parseLifecycleRequestParams("smoke", { ...ok, command: "rm -rf /" })).toThrow();
  });

  it("knows the request kinds", () => {
    expect(["plan", "cve", "smoke"].every(isLifecycleRequestKind)).toBe(true);
    expect(["source", "run", "", "PLAN"].some(isLifecycleRequestKind)).toBe(false);
  });

  it("complete body is {ok, error?, runId?} and nothing else", () => {
    expect(LifecycleCompleteBody.parse({ ok: true, runId: "r-1" })).toEqual({ ok: true, runId: "r-1" });
    expect(LifecycleCompleteBody.parse({ ok: false, error: "boom" })).toEqual({ ok: false, error: "boom" });
    expect(LifecycleCompleteBody.safeParse({}).success).toBe(false);
    expect(LifecycleCompleteBody.safeParse({ ok: "yes" }).success).toBe(false);
    expect(LifecycleCompleteBody.safeParse({ ok: true, status: "done" }).success).toBe(false);
    expect(LifecycleCompleteBody.safeParse({ ok: false, error: "e".repeat(2001) }).success).toBe(false);
    expect(LifecycleCompleteBody.safeParse({ ok: true, runId: "bad id" }).success).toBe(false);
  });
});
