import { describe, expect, it } from "vitest";
import {
  LIFECYCLE_LINK_HOSTS,
  LIFECYCLE_LIMITS,
  LIFECYCLE_SMOKE_ORIGIN_RE,
  lifecycleParsePreviewSmokeOrigin,
  lifecyclePreviewSmokeOrigin,
  lifecycleSafeLink,
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
    const adv = { id: "A", aliases: [], source: "osv", severity: "low", kev: false, summary: "", url: "https://osv.dev/vulnerability/A", affected: [] };
    expect(paths({ ...base, job: "cve", advisories: Array.from({ length: 2000 }, () => adv) })).toEqual([]);
    expect(paths({ ...base, job: "cve", advisories: Array.from({ length: 2001 }, () => adv) })).toEqual(["advisories:too_big"]);
  });

  it("rejects values outside the closed vocabularies and ranges", () => {
    expect(paths({ ...base, components: [{ ...component, tier: "kernel" }] })).toEqual(["components.0.tier:invalid_enum_value"]);
    expect(paths({ ...base, components: [{ ...component, status: "done" }] })).toEqual(["components.0.status:invalid_enum_value"]);
    expect(paths({ ...base, components: [{ ...component, pr: { ...pr, number: 0 } }] })).toEqual(["components.0.pr.number:too_small"]);
    const adv = { id: "A", aliases: [], source: "osv", severity: "low", kev: false, summary: "", url: "https://osv.dev/vulnerability/A", affected: [] };
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
    const ok = { scope: "preview", bundleKey: KEY, targets: [{ name: "twizz-sentinel", baseUrl: "http://twizz-sentinel.env-plo-2611-twizz-sentinel.svc.cluster.local:8090" }] };
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

// ── external review 2026-11-25, idp #9: anything rendered as a link is https on an allowlisted host ──
describe("links: https only, allowlisted hosts, at schema level", () => {
  const adv = { id: "A", aliases: [], source: "osv", severity: "low", kev: false, summary: "", url: "https://osv.dev/vulnerability/A", affected: [] };
  const cs = { id: "cs1", stage: "source", target: "t", domain: "d", tier: "npm-direct", autonomy: "pr", status: "pr-open", rationale: [], componentIds: [] };

  it("lifecycleSafeLink accepts only https on an exact allowlisted host", () => {
    expect(lifecycleSafeLink("https://github.com/twizz-app/twizz-sentinel/pull/41")).toBe("https://github.com/twizz-app/twizz-sentinel/pull/41");
    expect(lifecycleSafeLink("https://osv.dev/vulnerability/GHSA-rv95-896h-c2vc")).not.toBeNull();
    expect(lifecycleSafeLink("https://nodejs.org/en/blog/release/v22.11.0")).not.toBeNull();
    for (const bad of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      " javascript:alert(1)",
      "java\tscript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:x",
      "file:///etc/passwd",
      "http://github.com/a/b/pull/1",
      "//github.com/a/b",
      "/relative",
      "",
      "https://evil.example/login",
      "https://github.com.evil.example/a/b/pull/1",
      "https://evil.example/github.com",
      "https://github.com@evil.example/a",
      "https://user:pw@github.com/a",
      "https://github.com:8443/a",
      "https://sub.github.com/a",
      "https:\\\\github.com/a",
      "https://github.com\\@evil.example/",
      "https://osv.dev/x\ny",
      "https://169.254.169.254/latest/meta-data",
    ]) expect(lifecycleSafeLink(bad), JSON.stringify(bad)).toBeNull();
    expect(lifecycleSafeLink(42)).toBeNull();
    expect(lifecycleSafeLink(null)).toBeNull();
    expect(LIFECYCLE_LINK_HOSTS).toContain("github.com");
  });

  it("a pull request url must be THAT pull request on github.com", () => {
    const at = (url: string, over: Record<string, unknown> = {}) => paths({ ...base, components: [{ ...component, pr: { ...pr, url, ...over } }] });
    expect(at(pr.url)).toEqual([]);
    expect(at("https://GitHub.com/Twizz-App/twizz-sentinel/pull/41")).toEqual([]); // owner/name are case-insensitive on GitHub
    expect(at("javascript:alert(1)")).toContain("components.0.pr.url:custom");
    expect(at("https://evil.example/login")).toContain("components.0.pr.url:custom");
    expect(at("http://github.com/twizz-app/twizz-sentinel/pull/41")).toContain("components.0.pr.url:custom");
    // a real github URL, but of another pull request or repository: the label would lie about where it goes
    expect(at("https://github.com/twizz-app/twizz-sentinel/pull/42")).toEqual(["components.0.pr.url:custom"]);
    expect(at("https://github.com/evil/twizz-sentinel/pull/41")).toEqual(["components.0.pr.url:custom"]);
    expect(at("https://github.com/twizz-app/twizz-sentinel/pull/41/files")).toEqual(["components.0.pr.url:custom"]);
    expect(at(pr.url, { repo: "not a slug" })).toContain("components.0.pr.repo:invalid_string");
    // the same rule wherever a PrRef appears
    expect(paths({ ...base, job: "source", bundles: [{ repo: "r", github: "twizz-app/twizz-sentinel", baseBranch: "main", branch: "plo/bundle/2026-11", headSha: null, included: [{ ...pr, url: "https://evil.example/x" }], conflicts: [{ pr: { ...pr, url: "javascript:1" }, files: [] }], environments: [] }] })).toEqual(["bundles.0.included.0.url:custom", "bundles.0.conflicts.0.pr.url:custom"]);
    expect(paths({ ...base, changeSets: [{ ...cs, pr: { ...pr, url: "data:text/html,x" } }] })).toContain("changeSets.0.pr.url:custom");
  });

  it("an advisory url is https on an advisory host; an escalation url is https on github.com", () => {
    const a = (url: string) => paths({ ...base, job: "cve", advisories: [{ ...adv, url }] });
    expect(a("https://osv.dev/vulnerability/GHSA-xxxx")).toEqual([]);
    expect(a("https://nodejs.org/en/blog/release/v22.11.0")).toEqual([]);
    expect(a("https://github.com/advisories/GHSA-xxxx")).toEqual([]);
    expect(a("https://nvd.nist.gov/vuln/detail/CVE-2026-0001")).toEqual([]);
    for (const bad of ["javascript:alert(document.cookie)", "http://osv.dev/x", "https://osv.dev.evil.example/x", "https://evil.example/osv.dev", "", "osv.dev/x"]) expect(a(bad), bad).toEqual(["advisories.0.url:custom"]);
    const e = (escalationUrl: string) => paths({ ...base, changeSets: [{ ...cs, escalationUrl }] });
    expect(e("https://github.com/twizz-app/platform-lifecycle-orchestrator/issues/12")).toEqual([]);
    for (const bad of ["http://github.com/a/b/issues/1", "https://evil.example/issues/1", "javascript:x"]) expect(e(bad), bad).toEqual(["changeSets.0.escalationUrl:custom"]);
    expect(paths({ ...base, changeSets: [cs] })).toEqual([]); // optional
  });
});

// ── external review 2026-11-25, idp #12 + gitops #3: a smoke target has ONE form per scope ──
//   preview  the env's Service inside the cluster (the public preview host answers 302: SSO gate)
//   stg      the fixed https staging host of the release train
describe("smoke request targets", () => {
  const SVC = "http://twizz-sentinel.env-plo-2611-twizz-sentinel.svc.cluster.local:8090";
  const STG = "https://sentinel-stg.prv.twizz.com";
  const ok = { scope: "preview", bundleKey: KEY, targets: [{ name: "twizz-sentinel", baseUrl: SVC }] };
  const stg = { scope: "stg", bundleKey: KEY, targets: [{ name: "twizz-sentinel", baseUrl: STG }] };

  it("refuses every other scheme, host, port, path or credential — with nothing else wrong in the row", () => {
    expect(parseLifecycleRequestParams("smoke", ok)).toEqual(ok);
    expect(parseLifecycleRequestParams("smoke", stg)).toEqual(stg);
    for (const baseUrl of [
      "file:///etc/passwd",
      "http://169.254.169.254",
      "http://169.254.169.254/latest/meta-data/",
      "https://169.254.169.254",
      "http://plo-2611-twizz-sentinel.prv.twizz.com",
      "https://plo-2611-twizz-sentinel.prv.twizz.com",
      "https://plo-2611-twizz-sentinel.prv.twizz.com/",
      "https://sentinel-stg.prv.twizz.com/health",
      "https://sentinel-stg.prv.twizz.com:8443",
      "https://user:pw@sentinel-stg.prv.twizz.com",
      "https://evil.com/-stg.prv.twizz.com",
      "https://evil.com?-stg.prv.twizz.com",
      "https://a.b-stg.prv.twizz.com",
      "https://prv.twizz.com",
      "https://x-stg.prv.twizz.com.evil.example",
      "https://X-stg.prv.twizz.com",
      "https://argocd.prv.twizz.com",
      "https://nebula.prv.twizz.com",
      "http://dashboard.nebula.svc.cluster.local",
      "http://kubernetes.default.svc.cluster.local:443",
      "http://twizz-sentinel.env-mine.svc.cluster.local:8090",
      "https://twizz-sentinel.env-plo-2611-twizz-sentinel.svc.cluster.local:8090",
      `${SVC}/health`,
      `${SVC}@evil.com`,
      "http://twizz-sentinel.env-plo-2611-twizz-sentinel.svc.cluster.local:80",
      "http://twizz-sentinel.env-plo-2611-twizz-sentinel.svc.cluster.local:0",
      "http://twizz-sentinel.env-plo-2611-twizz-sentinel.svc.cluster.local.evil.example:8090",
      "http://10.0.0.1:8090",
      "gopher://x-stg.prv.twizz.com",
    ]) {
      expect(() => parseLifecycleRequestParams("smoke", { ...ok, targets: [{ name: "twizz-sentinel", baseUrl }] }), `preview ${baseUrl}`).toThrow();
      expect(() => parseLifecycleRequestParams("smoke", { ...stg, targets: [{ name: "twizz-sentinel", baseUrl }] }), `stg ${baseUrl}`).toThrow();
    }
    expect(() => parseLifecycleRequestParams("smoke", { ...ok, targets: [{ name: "a b", baseUrl: SVC }] })).toThrow();
    expect(LIFECYCLE_SMOKE_ORIGIN_RE.test(STG)).toBe(true);
    expect(LIFECYCLE_SMOKE_ORIGIN_RE.test(SVC)).toBe(true);
  });

  it("a target of one scope is never accepted for the other, and a preview Service must be the target's own", () => {
    expect(() => parseLifecycleRequestParams("smoke", { ...ok, targets: stg.targets })).toThrow();
    expect(() => parseLifecycleRequestParams("smoke", { ...stg, targets: ok.targets })).toThrow();
    // `moly-backend` pointed at the sentinel Service (or the env's redis): refused
    expect(() => parseLifecycleRequestParams("smoke", { ...ok, targets: [{ name: "moly-backend", baseUrl: SVC }] })).toThrow();
    expect(() => parseLifecycleRequestParams("smoke", { ...ok, targets: [{ name: "twizz-sentinel", baseUrl: SVC.replace("//twizz-sentinel.", "//redis.") }] })).toThrow();
    // staging evidence never comes from a plo-* host
    expect(() => parseLifecycleRequestParams("smoke", { ...stg, targets: [{ name: "twizz-sentinel", baseUrl: "https://plo-x-stg.prv.twizz.com" }] })).toThrow();
  });

  it("builds and reads back the in-cluster origin of a preview env; port 80 is never written", () => {
    expect(lifecyclePreviewSmokeOrigin("twizz-sentinel", "plo-2611-twizz-sentinel", 8090)).toBe(SVC);
    expect(lifecyclePreviewSmokeOrigin("twizz-admin", "plo-2611-twizz-admin", 80)).toBe("http://twizz-admin.env-plo-2611-twizz-admin.svc.cluster.local");
    expect(lifecycleParsePreviewSmokeOrigin(SVC)).toEqual({ service: "twizz-sentinel", envName: "plo-2611-twizz-sentinel", port: 8090 });
    expect(lifecycleParsePreviewSmokeOrigin("http://twizz-admin.env-plo-2611-twizz-admin.svc.cluster.local")).toEqual({ service: "twizz-admin", envName: "plo-2611-twizz-admin", port: 80 });
    for (const [service, env, port] of [["twizz-sentinel", "mine", 8090], ["Twizz", "plo-2611-x", 8090], ["twizz-sentinel", "plo-2611-x", 0], ["twizz-sentinel", "plo-2611-x", 70000], ["twizz-sentinel", "plo-2611-x", 80.5], ["a.b", "plo-2611-x", 8090]] as const) {
      expect(lifecyclePreviewSmokeOrigin(service, env, port), `${service} ${env} ${port}`).toBeNull();
    }
    expect(lifecycleParsePreviewSmokeOrigin("http://twizz-sentinel.env-plo-2611-x.svc.cluster.local:99999")).toBeNull();
    expect(lifecycleParsePreviewSmokeOrigin(STG)).toBeNull();
  });
});
