import { describe, expect, it } from "vitest";
import {
  LIFECYCLE_TOOLS,
  PREVIEW_STATES,
  SIGNOFF_AUDIT_ACTION,
  buildPreview,
  bundleTargets,
  isBundleImageTag,
  parseSignoffAudit,
  previewEnvName,
  smokeVerdict,
  type LifecycleServiceInput,
  type PreviewInput,
  type PreviewView,
  type PromotionInput,
  type StagingTargetInput,
} from "../lifecycle-model";
import { DAY, HOUR, KEY, NOW, OTHER_KEY, SHA_BACKEND, SHA_SENTINEL, ago, bundle, env, pr, request, smokeRequest, smokeSnap, snap } from "./lifecycle-fixtures";

const SENTINEL = "twizz-app/twizz-sentinel";
const BACKEND = "twizz-app/Moly-backend";
const SERVICES: LifecycleServiceInput[] = [
  { service: "twizz-sentinel", repo: SENTINEL, promotable: true, stagingHost: "sentinel-stg.prv.twizz.com" },
  { service: "moly-backend", repo: BACKEND, promotable: false, stagingHost: null },
  { service: "twizz-admin", repo: "twizz-app/front-admin", promotable: true, stagingHost: "admin-stg.prv.twizz.com" },
];
const ENV_S = "plo-2611-twizz-sentinel";
const ENV_B = "plo-2611-moly-backend";
const TAG_S = `nb-${ENV_S}-${SHA_SENTINEL.slice(0, 12)}`;

const source = (bundles = [bundle(SENTINEL, SHA_SENTINEL), bundle(BACKEND, SHA_BACKEND)], key: string | null = KEY) => snap("source", ago(DAY), { runId: "source-1", bundles, ...(key ? { bundleKey: key } : {}) });
const envsUp = () => [env(ENV_S, SENTINEL, SHA_SENTINEL), env(ENV_B, BACKEND, SHA_BACKEND)];
const stagingOn = (tag: string | null, over: Partial<StagingTargetInput> = {}): StagingTargetInput[] => [
  { service: "twizz-sentinel", host: "sentinel-stg.prv.twizz.com", currentTag: tag, argo: "PASS", error: null, ...over },
  { service: "twizz-admin", host: "admin-stg.prv.twizz.com", currentTag: "main-" + "9".repeat(40), argo: "PASS", error: null },
];
const promotion = (tag = TAG_S): PromotionInput => ({ service: "twizz-sentinel", imageTag: tag, number: 77, url: "https://github.com/TwizzyNicky/twizz-gitops/pull/77", headSha: "d".repeat(40) });

function preview(over: Partial<PreviewInput> = {}): PreviewView {
  return buildPreview({ rows: [source()], requests: [], services: SERVICES, envs: [], promotions: [], staging: stagingOn("main-" + "1".repeat(40)), signoffs: [], now: NOW, ...over });
}
const allowed = (v: PreviewView) => Object.entries(v.actions).filter(([, a]) => a.allowed).map(([k]) => k);
const reason = (a: PreviewView["actions"][keyof PreviewView["actions"]]) => (a.allowed ? "" : a.reason);
const step = (v: PreviewView, key: string) => v.steps.find((s) => s.key === key)?.status;

/** a finished smoke request plus its result snapshot */
function smoked(scope: "preview" | "stg", results: Array<{ ok: boolean }>, key = KEY, minutesAgo = 10) {
  const req = smokeRequest(scope, key, { status: "done", createdAt: ago((minutesAgo + 5) * 60_000), claimedAt: ago((minutesAgo + 2) * 60_000), finishedAt: ago(minutesAgo * 60_000), runId: `smoke-${scope}` });
  return { req, row: smokeSnap(req, scope, key, results, ago(minutesAgo * 60_000)) };
}

describe("names and tags", () => {
  it("previewEnvName is plo-<yymm>-<service>, at most 24 chars, a valid env name", () => {
    expect(previewEnvName("plo/bundle/2026-11", "twizz-sentinel")).toBe("plo-2611-twizz-sentinel");
    expect(previewEnvName("plo/bundle/2027-01", "Moly_Backend")).toBe("plo-2701-moly-backend");
    const long = previewEnvName("plo/bundle/2026-11", "a-very-long-service-name-indeed");
    expect(long).toBe("plo-2611-a-very-long-ser");
    expect(long.length).toBeLessThanOrEqual(24);
    expect(previewEnvName("plo/bundle/2026-11", "abcdefghijklmn-opq")).toBe("plo-2611-abcdefghijklmn"); // no trailing dash after the cut
    for (const s of ["twizz-sentinel", "moly-backend", "twizz-admin", "frontend", "business"]) expect(previewEnvName("plo/bundle/2026-11", s)).toMatch(/^[a-z][a-z0-9-]{2,23}$/);
  });

  it("previewEnvName refuses anything that is not a bundle branch or has no usable name", () => {
    for (const b of ["main", "plo/2026-11/cs-1", "plo/bundle/2026-1", "plo/bundle/2026-11/x", "plo/bundle/latest"]) expect(() => previewEnvName(b, "svc")).toThrow(/not a bundle branch/);
    expect(() => previewEnvName("plo/bundle/2026-11", "___")).toThrow(/no usable name/);
  });

  it("isBundleImageTag accepts only the central builder's tag of a plo env at that commit", () => {
    expect(isBundleImageTag(TAG_S, SHA_SENTINEL)).toBe(true);
    expect(isBundleImageTag(TAG_S, SHA_BACKEND)).toBe(false);
    expect(isBundleImageTag(`nb-my-env-${SHA_SENTINEL.slice(0, 12)}`, SHA_SENTINEL)).toBe(false);
    expect(isBundleImageTag(`main-${SHA_SENTINEL}`, SHA_SENTINEL)).toBe(false);
    expect(isBundleImageTag(`${TAG_S}-extra`, SHA_SENTINEL)).toBe(false);
    expect(isBundleImageTag(null, SHA_SENTINEL)).toBe(false);
    expect(isBundleImageTag(TAG_S, "not-a-sha")).toBe(false);
    expect(isBundleImageTag("nb-plo-.*-", ".*")).toBe(false);
  });

  it("bundleTargets maps repositories to registry services, case-insensitively", () => {
    const t = bundleTargets([bundle("TWIZZ-APP/moly-BACKEND", SHA_BACKEND), bundle("twizz-app/lolygram-discover", SHA_SENTINEL), bundle(SENTINEL, null), bundle("twizz-app/front-admin", "abc123"), bundle(SENTINEL, SHA_SENTINEL, { branch: "feature/x" })], SERVICES);
    expect(t.map((x) => [x.service?.service ?? null, x.previewable, x.envName])).toEqual([
      ["moly-backend", true, "plo-2611-moly-backend"],
      [null, false, null],
      ["twizz-sentinel", false, null],
      ["twizz-admin", false, null],
      ["twizz-sentinel", false, null],
    ]);
    expect(t[1].note).toMatch(/no preview route in Nebula/);
    expect(t[2].note).toMatch(/nothing could be bundled/);
    expect(t[3].note).toMatch(/not a full commit sha/);
    expect(t[4].note).toMatch(/not a bundle branch/);
  });
});

describe("parseSignoffAudit", () => {
  const row = (over: Partial<Parameters<typeof parseSignoffAudit>[0]> = {}) => ({ action: SIGNOFF_AUDIT_ACTION, actor: "nick", allowed: true, resource: JSON.stringify({ bundleKey: KEY }), detail: { result: "{}", summary: "Sign off" }, createdAt: ago(HOUR), ...over });

  it("reads a completed gate row", () => {
    expect(SIGNOFF_AUDIT_ACTION).toBe("nebula.lifecycle_signoff");
    expect(LIFECYCLE_TOOLS.signoff).toBe("lifecycle_signoff");
    expect(parseSignoffAudit(row())).toEqual({ bundleKey: KEY, actor: "nick", at: ago(HOUR) });
  });

  it("ignores denials, errors, other tools and malformed rows", () => {
    expect(parseSignoffAudit(row({ allowed: false, detail: { reason: "operators only" } }))).toBeNull();
    // the gate audits a THROWN action as allowed=true with detail.error
    expect(parseSignoffAudit(row({ detail: { error: "Error: staging smoke has not passed" } }))).toBeNull();
    expect(parseSignoffAudit(row({ detail: { result: "{}", error: "x" } }))).toBeNull();
    expect(parseSignoffAudit(row({ detail: null }))).toBeNull();
    expect(parseSignoffAudit(row({ detail: ["result"] }))).toBeNull();
    expect(parseSignoffAudit(row({ detail: { summary: "no result" } }))).toBeNull();
    expect(parseSignoffAudit(row({ action: "nebula.lifecycle_deploy_stg" }))).toBeNull();
    expect(parseSignoffAudit(row({ action: "mcp.intent.lifecycle_signoff" }))).toBeNull();
    expect(parseSignoffAudit(row({ resource: null }))).toBeNull();
    expect(parseSignoffAudit(row({ resource: "not json" }))).toBeNull();
    expect(parseSignoffAudit(row({ resource: JSON.stringify({ key: KEY }) }))).toBeNull();
    expect(parseSignoffAudit(row({ resource: JSON.stringify({ bundleKey: "short" }) }))).toBeNull();
    expect(parseSignoffAudit(row({ resource: "null" }))).toBeNull();
  });
});

describe("smokeVerdict", () => {
  it("none before any request; running while pending or claimed", () => {
    expect(smokeVerdict("preview", KEY, [], [])).toMatchObject({ verdict: "none", request: null });
    expect(smokeVerdict("preview", KEY, [smokeRequest("preview", KEY)], [])).toMatchObject({ verdict: "running", detail: expect.stringMatching(/plo-dispatch/) });
    expect(smokeVerdict("preview", KEY, [smokeRequest("preview", KEY, { status: "claimed" })], []).verdict).toBe("running");
  });

  it("pass only when the result came back for that request and every check passed", () => {
    const { req, row } = smoked("preview", [{ ok: true }, { ok: true }]);
    expect(smokeVerdict("preview", KEY, [req], [row])).toMatchObject({ verdict: "pass", runId: row.runId, detail: "2 of 2 checks passed" });
    const mixed = smoked("preview", [{ ok: true }, { ok: false }]);
    expect(smokeVerdict("preview", KEY, [mixed.req], [mixed.row])).toMatchObject({ verdict: "fail", detail: "1 of 2 checks failed" });
    expect(smokeVerdict("preview", KEY, [mixed.req], [mixed.row]).results).toHaveLength(2);
  });

  it("fails closed on anything short of a clean pass", () => {
    const done = smokeRequest("preview", KEY, { status: "done" });
    // completed, but no snapshot for it
    expect(smokeVerdict("preview", KEY, [done], [])).toMatchObject({ verdict: "fail", detail: expect.stringMatching(/no smoke result was received/) });
    // a passing snapshot that belongs to ANOTHER request does not count
    const other = smoked("preview", [{ ok: true }]);
    expect(smokeVerdict("preview", KEY, [done], [other.row]).verdict).toBe("fail");
    // a snapshot without a request id does not count
    expect(smokeVerdict("preview", KEY, [done], [snap("smoke", ago(1000), { smoke: { scope: "preview", bundleKey: KEY, results: [{ name: "a", url: "u", ok: true, status: 200, ms: 1, detail: "" }] } })]).verdict).toBe("fail");
    // zero checks is not a pass
    expect(smokeVerdict("preview", KEY, [done], [smokeSnap(done, "preview", KEY, [])])).toMatchObject({ verdict: "fail", detail: "the smoke run checked nothing" });
    // the job said ok=false although every check is green
    expect(smokeVerdict("preview", KEY, [done], [smokeSnap(done, "preview", KEY, [{ ok: true }], ago(1000), { ok: false, error: "crashed after checks" })])).toMatchObject({ verdict: "fail", detail: expect.stringMatching(/crashed after checks/) });
    // the result names another scope or another bundle
    expect(smokeVerdict("preview", KEY, [done], [smokeSnap(done, "stg", KEY, [{ ok: true }])]).verdict).toBe("fail");
    expect(smokeVerdict("preview", KEY, [done], [smokeSnap(done, "preview", OTHER_KEY, [{ ok: true }])]).verdict).toBe("fail");
    // the request itself failed (dispatch crashed or timed out)
    expect(smokeVerdict("preview", KEY, [smokeRequest("preview", KEY, { status: "failed", error: "claimed but not completed within 2 h" })], [])).toMatchObject({ verdict: "fail", detail: expect.stringMatching(/within 2 h/) });
    expect(smokeVerdict("preview", KEY, [smokeRequest("preview", KEY, { status: "weird" })], []).verdict).toBe("none");
  });

  it("an expired request is no evidence either way", () => {
    expect(smokeVerdict("preview", KEY, [smokeRequest("preview", KEY, { status: "expired" })], [])).toMatchObject({ verdict: "none", detail: expect.stringMatching(/expired/) });
  });

  it("the LATEST request decides: a re-run suspends an older pass", () => {
    const old = smoked("preview", [{ ok: true }], KEY, 60);
    const rerun = smokeRequest("preview", KEY, { createdAt: ago(60_000) });
    expect(smokeVerdict("preview", KEY, [old.req], [old.row]).verdict).toBe("pass");
    expect(smokeVerdict("preview", KEY, [old.req, rerun], [old.row]).verdict).toBe("running");
    const failedRerun = smoked("preview", [{ ok: false }], KEY, 5);
    expect(smokeVerdict("preview", KEY, [failedRerun.req, old.req], [old.row, failedRerun.row]).verdict).toBe("fail");
  });

  it("keeps scopes and bundles apart, and ignores requests with unparseable params", () => {
    const stg = smoked("stg", [{ ok: true }]);
    const otherBundle = smoked("preview", [{ ok: true }], OTHER_KEY);
    const rows = [stg.row, otherBundle.row];
    const reqs = [stg.req, otherBundle.req, request("smoke", { params: { scope: "preview", bundleKey: KEY } }), request("plan", { status: "done" })];
    expect(smokeVerdict("preview", KEY, reqs, rows).verdict).toBe("none");
    expect(smokeVerdict("stg", KEY, reqs, rows).verdict).toBe("pass");
    expect(smokeVerdict("preview", OTHER_KEY, reqs, rows).verdict).toBe("pass");
  });
});

describe("the preview state machine", () => {
  it("knows exactly the contract's states", () => {
    expect(PREVIEW_STATES).toEqual(["no-bundle", "bundle-ready", "preview-requested", "preview-up", "smoke-preview-pass", "smoke-preview-fail", "stg-requested", "stg-deployed", "smoke-stg-pass", "smoke-stg-fail", "awaiting-signoff", "signed-off"]);
  });

  it("no-bundle: nothing reported, no key, or nothing bundled — and nothing may be done", () => {
    const cases: Array<[PreviewView, RegExp]> = [
      [preview({ rows: [] }), /no source run has reported/],
      [preview({ rows: [source([bundle(SENTINEL, SHA_SENTINEL)], null)] }), /produced no bundle/],
      [preview({ rows: [source([bundle(SENTINEL, null), bundle(BACKEND, null)])] }), /bundled nothing/],
      [preview({ rows: [source([])] }), /bundled nothing/],
    ];
    for (const [v, why] of cases) {
      expect(v.state).toBe("no-bundle");
      expect(v.detail).toMatch(why);
      expect(allowed(v)).toEqual([]);
      expect(v.steps.every((s) => s.status === "todo")).toBe(true);
    }
    expect(preview({ rows: [] })).toMatchObject({ bundleKey: null, key12: null, sourceRun: null, signoff: null });
  });

  it("bundle-ready: a bundle exists and no preview env does", () => {
    const v = preview();
    expect(v).toMatchObject({ state: "bundle-ready", bundleKey: KEY, key12: KEY.slice(0, 12), sourceRun: { runId: "source-1", ok: true } });
    expect(allowed(v)).toEqual(["createPreview"]);
    expect(v.bundles.map((b) => [b.service, b.previewable, b.promotable, b.envName, b.env])).toEqual([
      ["twizz-sentinel", true, true, ENV_S, null],
      ["moly-backend", true, false, ENV_B, null],
    ]);
    expect(v.bundles[1].staging).toBeNull();
    expect(step(v, "bundle-ready")).toBe("current");
    expect(reason(v.actions.smokePreview)).toMatch(/not all up/);
    expect(reason(v.actions.signoff)).toMatch(/staging is not running this bundle/);
  });

  it("preview-requested: some env exists but not every one is up", () => {
    const building = preview({ envs: [env(ENV_S, SENTINEL, SHA_SENTINEL, { build: "building", imageTag: null, argo: null })] });
    expect(building).toMatchObject({ state: "preview-requested", detail: "0 of 2 preview envs up" });
    // one bundled service still has no env: creating the rest is allowed
    expect(allowed(building)).toEqual(["createPreview"]);
    const oneUp = preview({ envs: [env(ENV_S, SENTINEL, SHA_SENTINEL), env(ENV_B, BACKEND, SHA_BACKEND, { build: "building", imageTag: null, argo: null })] });
    expect(oneUp).toMatchObject({ state: "preview-requested", detail: "1 of 2 preview envs up" });
    expect(allowed(oneUp)).toEqual([]);
    expect(reason(oneUp.actions.createPreview)).toMatch(/already has a preview env/);
  });

  it("a failed build and an unconfirmed env hold it at preview-requested, with the reason shown", () => {
    const failed = preview({ envs: [env(ENV_S, SENTINEL, SHA_SENTINEL), env(ENV_B, BACKEND, SHA_BACKEND, { build: "failed", imageTag: null, argo: null, buildReason: "docker build exited 1" })] });
    expect(failed.state).toBe("preview-requested");
    expect(failed.blockers).toContain(`${ENV_B}: build failed (docker build exited 1)`);
    for (const argo of ["RUNNING", "FAIL", "UNKNOWN", "PENDING", null] as const) {
      const v = preview({ envs: [env(ENV_S, SENTINEL, SHA_SENTINEL), env(ENV_B, BACKEND, SHA_BACKEND, { argo })] });
      expect(v.state).toBe("preview-requested");
      expect(v.blockers.join("\n")).toMatch(new RegExp(`${ENV_B}: Argo reports ${argo ?? "nothing"} — not confirmed up`));
      expect(v.actions.smokePreview.allowed).toBe(false);
    }
  });

  it("preview-up: every expected env is deployable and Argo says PASS", () => {
    const v = preview({ envs: envsUp() });
    expect(v.state).toBe("preview-up");
    expect(allowed(v)).toEqual(["smokePreview"]);
    expect(v.bundles.every((b) => b.env?.up)).toBe(true);
    expect([step(v, "bundle-ready"), step(v, "preview-requested"), step(v, "preview-up"), step(v, "smoke-preview")]).toEqual(["done", "done", "current", "todo"]);
  });

  it("only counts envs built from THIS bundle: prefix, repository, commit and not expired", () => {
    const wrong = [
      env("my-sentinel-test", SENTINEL, SHA_SENTINEL), // not a plo- env
      env(ENV_S, SENTINEL, "0".repeat(40)), // last month's commit
      env(ENV_S, "twizz-app/front-admin", SHA_SENTINEL), // another repository
      env(ENV_S, SENTINEL, SHA_SENTINEL, { expiresAt: ago(60_000).toISOString() }), // expired, about to be reaped
      env(ENV_S, SENTINEL, SHA_SENTINEL, { sourceRepo: null, sourceSha: null }), // a release-image env
    ];
    for (const e of wrong) expect(preview({ envs: [e] }).state).toBe("bundle-ready");
    // repository names compare case-insensitively
    expect(preview({ envs: [env(ENV_S, "Twizz-App/TWIZZ-sentinel", SHA_SENTINEL)] }).state).toBe("preview-requested");
  });

  it("prefers a deployable env over a failed one for the same bundle", () => {
    const v = preview({ envs: [env("plo-2611-twizz-sentinel", SENTINEL, SHA_SENTINEL, { build: "failed", imageTag: null }), env("plo-2611-twizz-sent2", SENTINEL, SHA_SENTINEL), env(ENV_B, BACKEND, SHA_BACKEND)] });
    expect(v.state).toBe("preview-up");
    expect(v.bundles[0].env?.name).toBe("plo-2611-twizz-sent2");
  });

  it("a smoke run in flight keeps the state and blocks a second one", () => {
    const v = preview({ envs: envsUp(), requests: [smokeRequest("preview", KEY)] });
    expect(v.state).toBe("preview-up");
    expect(v.smoke.preview.verdict).toBe("running");
    expect(allowed(v)).toEqual([]);
    expect(reason(v.actions.smokePreview)).toMatch(/already in flight/);
  });

  it("smoke-preview-pass → the staging deploy opens up", () => {
    const { req, row } = smoked("preview", [{ ok: true }]);
    const v = preview({ envs: envsUp(), requests: [req], rows: [source(), row] });
    expect(v.state).toBe("smoke-preview-pass");
    expect(allowed(v).sort()).toEqual(["deployStg", "smokePreview"]);
    expect(step(v, "smoke-preview")).toBe("current");
    expect(reason(v.actions.signoff)).toMatch(/staging is not running this bundle/);
  });

  it("smoke-preview-fail → re-run allowed, staging deploy refused", () => {
    const { req, row } = smoked("preview", [{ ok: true }, { ok: false }]);
    const v = preview({ envs: envsUp(), requests: [req], rows: [source(), row] });
    expect(v).toMatchObject({ state: "smoke-preview-fail", detail: "1 of 2 checks failed" });
    expect(step(v, "smoke-preview")).toBe("failed");
    expect(allowed(v)).toEqual(["smokePreview"]);
    expect(reason(v.actions.deployStg)).toMatch(/preview smoke for this bundle has not passed/);
  });

  it("a recorded preview pass survives the preview envs expiring, but there is then nothing to promote", () => {
    const { req, row } = smoked("preview", [{ ok: true }]);
    const v = preview({ envs: [], requests: [req], rows: [source(), row] });
    expect(v.state).toBe("smoke-preview-pass");
    expect(v.actions.deployStg).toEqual({ allowed: false, reason: "no built preview image for twizz-sentinel (the preview env is gone or not built)" });
  });

  it("stg-requested: an open promotion PR carries this bundle's image", () => {
    const { req, row } = smoked("preview", [{ ok: true }]);
    const v = preview({ envs: envsUp(), requests: [req], rows: [source(), row], promotions: [promotion()] });
    expect(v.state).toBe("stg-requested");
    expect(v.bundles[0].staging).toMatchObject({ deployed: false, promotion: { number: 77 }, host: "sentinel-stg.prv.twizz.com" });
    expect(reason(v.actions.deployStg)).toMatch(/already promoted or deployed/);
    expect(reason(v.actions.smokeStg)).toMatch(/not running this bundle yet/);
    // a promotion of some OTHER image is not this bundle's
    expect(preview({ envs: envsUp(), requests: [req], rows: [source(), row], promotions: [promotion("main-" + "3".repeat(40))] }).state).toBe("smoke-preview-pass");
  });

  it("stg-requested while gitops is on the image but Argo has not confirmed the rollout", () => {
    const { req, row } = smoked("preview", [{ ok: true }]);
    for (const argo of ["RUNNING", "FAIL", "UNKNOWN", "PENDING", null] as const) {
      const v = preview({ envs: envsUp(), requests: [req], rows: [source(), row], staging: stagingOn(TAG_S, { argo }) });
      expect(v.state).toBe("stg-requested");
      expect(v.blockers.join("\n")).toMatch(/twizz-sentinel staging: gitops is on the bundle image but Argo reports/);
      expect(v.actions.smokeStg.allowed).toBe(false);
      expect(v.actions.signoff.allowed).toBe(false);
    }
  });

  it("stg-deployed: gitops is on the bundle image and Argo says PASS", () => {
    const { req, row } = smoked("preview", [{ ok: true }]);
    const v = preview({ envs: envsUp(), requests: [req], rows: [source(), row], staging: stagingOn(TAG_S) });
    expect(v.state).toBe("stg-deployed");
    expect(v.bundles[0].staging).toMatchObject({ deployed: true, currentTag: TAG_S });
    expect(allowed(v).sort()).toEqual(["smokePreview", "smokeStg"]);
    expect([step(v, "stg-requested"), step(v, "stg-deployed"), step(v, "smoke-stg")]).toEqual(["done", "current", "todo"]);
  });

  it("smoke-stg-fail holds the sign-off back", () => {
    const p = smoked("preview", [{ ok: true }], KEY, 60);
    const s = smoked("stg", [{ ok: false }], KEY, 5);
    const v = preview({ envs: envsUp(), requests: [p.req, s.req], rows: [source(), p.row, s.row], staging: stagingOn(TAG_S) });
    expect(v.state).toBe("smoke-stg-fail");
    expect(step(v, "smoke-stg")).toBe("failed");
    expect(v.actions.signoff).toEqual({ allowed: false, reason: "the latest staging smoke for this bundle has not passed" });
    expect(v.actions.smokeStg.allowed).toBe(true);
  });

  it("awaiting-signoff: staging runs the bundle and the latest staging smoke passed", () => {
    const p = smoked("preview", [{ ok: true }], KEY, 60);
    const s = smoked("stg", [{ ok: true }, { ok: true }], KEY, 5);
    const v = preview({ envs: envsUp(), requests: [p.req, s.req], rows: [source(), p.row, s.row], staging: stagingOn(TAG_S) });
    expect(v.state).toBe("awaiting-signoff");
    expect(v.actions.signoff).toEqual({ allowed: true });
    expect([step(v, "smoke-stg"), step(v, "awaiting-signoff"), step(v, "signed-off")]).toEqual(["done", "current", "todo"]);
    expect(v.signoff).toBeNull();
  });

  it("the sign-off is withdrawn when the evidence stops holding", () => {
    const p = smoked("preview", [{ ok: true }], KEY, 60);
    const s = smoked("stg", [{ ok: true }], KEY, 5);
    const base = { envs: envsUp(), requests: [p.req, s.req], rows: [source(), p.row, s.row] };
    // staging has moved on to another image since the smoke passed
    const moved = preview({ ...base, staging: stagingOn("main-" + "7".repeat(40)) });
    expect(moved.state).toBe("smoke-preview-pass");
    expect(moved.actions.signoff.allowed).toBe(false);
    // a re-run of the staging smoke is in flight
    const rerun = preview({ ...base, requests: [...base.requests, smokeRequest("stg", KEY, { createdAt: ago(30_000) })], staging: stagingOn(TAG_S) });
    expect(rerun.state).toBe("stg-deployed");
    expect(rerun.actions.signoff.allowed).toBe(false);
    expect(rerun.actions.smokeStg.allowed).toBe(false);
    // a staging smoke pass alone, with staging never on the bundle, is not enough
    expect(preview({ ...base, staging: stagingOn(null) }).actions.signoff.allowed).toBe(false);
  });

  it("signed-off: one successful sign-off row for THIS bundle ends the flow", () => {
    const p = smoked("preview", [{ ok: true }], KEY, 60);
    const s = smoked("stg", [{ ok: true }], KEY, 5);
    const input = { envs: envsUp(), requests: [p.req, s.req], rows: [source(), p.row, s.row], staging: stagingOn(TAG_S) };
    const other = preview({ ...input, signoffs: [{ bundleKey: OTHER_KEY, actor: "igor", at: ago(HOUR) }] });
    expect(other.state).toBe("awaiting-signoff");
    const v = preview({ ...input, signoffs: [{ bundleKey: KEY, actor: "igor", at: ago(60_000) }, { bundleKey: KEY, actor: "nick", at: ago(30_000) }] });
    expect(v).toMatchObject({ state: "signed-off", detail: "signed off by igor", signoff: { by: "igor", at: ago(60_000).toISOString() } });
    expect(allowed(v)).toEqual([]);
    for (const a of Object.values(v.actions)) expect(reason(a)).toBe("this bundle is already signed off");
    expect(v.steps.every((x) => x.status === "done")).toBe(true);
    // it stays signed off after the envs are reaped and staging moves on
    expect(preview({ ...input, envs: [], staging: stagingOn("main-" + "5".repeat(40)), signoffs: [{ bundleKey: KEY, actor: "igor", at: ago(60_000) }] }).state).toBe("signed-off");
  });

  it("no service on the release train: the preview smoke alone leads to the sign-off", () => {
    const rows = [source([bundle(BACKEND, SHA_BACKEND)])];
    const up = [env(ENV_B, BACKEND, SHA_BACKEND)];
    const before = preview({ rows, envs: up });
    expect(before.state).toBe("preview-up");
    expect(before.steps.filter((s) => s.status === "skipped").map((s) => s.key)).toEqual(["stg-requested", "stg-deployed", "smoke-stg"]);
    expect(reason(before.actions.deployStg)).toBe("no bundled service is on the release train: no staging route in Nebula (deploys via the repo's own pipeline on merge)");
    expect(reason(before.actions.smokeStg)).toMatch(/no bundled service has a staging route/);
    expect(reason(before.actions.signoff)).toBe("the latest preview smoke for this bundle has not passed");
    const { req, row } = smoked("preview", [{ ok: true }]);
    const after = preview({ rows: [...rows, row], envs: up, requests: [req] });
    expect(after.state).toBe("awaiting-signoff");
    expect(after.detail).toMatch(/nothing here has a staging route/);
    expect(allowed(after).sort()).toEqual(["signoff", "smokePreview"]);
    const failed = smoked("preview", [{ ok: false }], KEY, 1);
    expect(preview({ rows: [...rows, row, failed.row], envs: up, requests: [req, failed.req] }).state).toBe("smoke-preview-fail");
  });

  it("a new bundle starts over: no evidence carries across bundle keys", () => {
    const p = smoked("preview", [{ ok: true }], OTHER_KEY, 60);
    const s = smoked("stg", [{ ok: true }], OTHER_KEY, 5);
    const v = preview({ envs: envsUp(), requests: [p.req, s.req], rows: [source(), p.row, s.row], staging: stagingOn(TAG_S), signoffs: [{ bundleKey: OTHER_KEY, actor: "nick", at: ago(HOUR) }] });
    // staging happens to run this bundle's image, but nothing was smoked or signed for this key
    expect(v.state).toBe("stg-deployed");
    expect(v.smoke).toMatchObject({ preview: { verdict: "none" }, stg: { verdict: "none" } });
    expect(v.signoff).toBeNull();
    expect(v.actions.signoff.allowed).toBe(false);
  });

  it("uses the newest successful source run; a failed newer run does not move the bundle", () => {
    const good = source();
    const failed = snap("source", ago(HOUR), { ok: false, error: "git push rejected", bundleKey: OTHER_KEY, bundles: [bundle(SENTINEL, "e".repeat(40))] });
    expect(preview({ rows: [good, failed] })).toMatchObject({ bundleKey: KEY, sourceRun: { runId: "source-1" } });
  });

  it("fails closed when the named envs cannot be read", () => {
    const v = preview({ envs: null, sourceErrors: ["named envs could not be read: GitHub 502"] });
    expect(v.state).toBe("bundle-ready");
    expect(v.blockers).toContain("named envs could not be read: GitHub 502");
    expect(v.actions.createPreview).toEqual({ allowed: false, reason: "the named-env manifests could not be read" });
    expect(v.actions.smokePreview.allowed).toBe(false);
  });

  it("fails closed when staging or the promotion PRs cannot be read", () => {
    const p = smoked("preview", [{ ok: true }], KEY, 60);
    const s = smoked("stg", [{ ok: true }], KEY, 5);
    const base = { envs: envsUp(), requests: [p.req, s.req], rows: [source(), p.row, s.row] };
    const unknown = preview({ ...base, staging: null });
    expect(unknown.state).toBe("smoke-preview-pass");
    expect(unknown.blockers).toContain("twizz-sentinel staging: staging state could not be read");
    expect(unknown.actions.deployStg).toEqual({ allowed: false, reason: "staging state could not be read" });
    expect(unknown.actions.signoff.allowed).toBe(false);
    expect(preview({ ...base, promotions: null }).actions.deployStg).toEqual({ allowed: false, reason: "staging state could not be read" });
    // one service's values file failed to read
    const partial = preview({ ...base, staging: stagingOn(TAG_S, { error: "GitHub 404", currentTag: null }) });
    expect(partial.state).toBe("smoke-preview-pass");
    expect(partial.blockers).toContain("twizz-sentinel staging: GitHub 404");
    // the service is missing from the staging read altogether
    expect(preview({ ...base, staging: [] }).bundles[0].staging).toMatchObject({ deployed: false, error: "no staging target reported for this service" });
  });

  it("reports what cannot be previewed, and conflicts, without hiding them", () => {
    const rows = [source([bundle(SENTINEL, SHA_SENTINEL, { conflicts: [{ pr: pr(SENTINEL, 9), files: ["package-lock.json"] }, { pr: pr(SENTINEL, 11), files: ["a"] }] }), bundle("twizz-app/lolygram-discover", SHA_BACKEND), bundle(BACKEND, null)])];
    const v = preview({ rows });
    expect(v.state).toBe("bundle-ready");
    expect(v.blockers).toEqual(["2 pull requests could not be merged into the bundle (conflicts)", "twizz-app/lolygram-discover: not a Nebula registry service: no preview route in Nebula"]);
    expect(v.bundles.map((b) => b.previewable)).toEqual([true, false, false]);
    // only the previewable bundle is expected to come up
    expect(preview({ rows, envs: [env(ENV_S, SENTINEL, SHA_SENTINEL)] }).state).toBe("preview-up");
  });

  it("a bundle with nothing Nebula can preview offers no action at all", () => {
    const v = preview({ rows: [source([bundle("twizz-app/lolygram-discover", SHA_BACKEND)])] });
    expect(v.state).toBe("bundle-ready");
    expect(v.detail).toMatch(/nothing in it can be previewed/);
    expect(allowed(v)).toEqual([]);
    expect(reason(v.actions.signoff)).toBe("no bundled repository maps to a Nebula service");
    expect(reason(v.actions.createPreview)).toBe("no bundled repository maps to a Nebula service");
  });

  it("every state it can return is one of the contract's states", () => {
    const p = smoked("preview", [{ ok: true }], KEY, 60);
    const views = [preview({ rows: [] }), preview(), preview({ envs: envsUp() }), preview({ envs: envsUp(), requests: [p.req], rows: [source(), p.row] }), preview({ envs: envsUp(), requests: [p.req], rows: [source(), p.row], staging: stagingOn(TAG_S) })];
    for (const v of views) {
      expect(PREVIEW_STATES).toContain(v.state);
      expect(v.steps.map((s) => s.key)).toEqual(["bundle-ready", "preview-requested", "preview-up", "smoke-preview", "stg-requested", "stg-deployed", "smoke-stg", "awaiting-signoff", "signed-off"]);
    }
  });
});
