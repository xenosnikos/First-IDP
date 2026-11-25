import { describe, expect, it } from "vitest";
import { LIFECYCLE_ENVIRONMENTS, LIFECYCLE_TIERS, type LifecycleEnvironmentCoverage, type LifecycleTier } from "@twizz-idp/shared";
import type { NamedEnvManifest } from "@twizz-idp/actions";
import { observationLine } from "@/lib/nebula/lifecycle";
import { STATUS_WORDS, argoWord } from "@/lib/nebula/status";
import { argoStatusFor } from "../argo";
import { toPreviewEnv } from "../lifecycle";
import { buildPreview, type LifecycleServiceInput, type PreviewInput } from "../lifecycle-model";
import { ENV_WORD_RANK, MAX_ENV_CHANGE_SETS, buildEnvironments, changeSetWord, countComponents, tierCoverage, worstWord, type CoverageHistoryRow, type EnvironmentView, type EnvironmentsInput } from "../lifecycle-environments";
import { DAY, HOUR, KEY, NOW, PREVIEW_SVC, SHA_BACKEND, SHA_SENTINEL, advisory, affects, ago, bundle, component, env, pr, smokeRequest, smokeSnap, snap } from "./lifecycle-fixtures";

const SENTINEL = "twizz-app/twizz-sentinel";
const BACKEND = "twizz-app/Moly-backend";
const SOURCE: LifecycleTier[] = ["base-images", "npm-direct", "npm-transitive"];
const CLUSTER = Object.fromEntries(LIFECYCLE_ENVIRONMENTS.map((e) => [e.name, e.clusters[0]])) as Record<string, string>;

type TierCov = LifecycleEnvironmentCoverage["tiers"][number];
/** `components` is how many rows the run says it read; the dashboard reads MORE than the snapshot carries as rows
 * left out on the way, so the default claims none (a real plan counts exactly its rows — pinned by the contract fixtures) */
const tier = (t: LifecycleTier, state: TierCov["state"] = "observed", gaps: string[] = [], components = 0): TierCov => ({ tier: t, state, components, gaps });
/** coverage as PLO writes it for a full plan: every tier of every environment read; nonprod has no repository */
function coverage(over: Record<string, Partial<Record<LifecycleTier, TierCov | null>>> = {}): LifecycleEnvironmentCoverage[] {
  return LIFECYCLE_ENVIRONMENTS.map((e) => ({
    environment: e.name,
    clusters: [...e.clusters],
    tiers: LIFECYCLE_TIERS.flatMap((t) => {
      const o = over[e.name]?.[t];
      if (o === null) return [];
      // a real plan counts one control-plane component per cluster (pinned by the contract fixtures)
      return [o ?? (e.name === "nonprod" && SOURCE.includes(t) ? tier(t, "not-applicable", [], 0) : tier(t, "observed", [], t === "control-plane" ? e.clusters.length : 0))];
    }),
  }));
}

const cp = (envName: string, over = {}) => component(`eks-control-plane:${CLUSTER[envName]}`, { tier: "control-plane", domain: "eks-control-plane", name: "control-plane", target: CLUSTER[envName], environments: [envName], current: "1.32", desired: null, latest: "1.32", bump: "none", status: "current", autonomy: "ignore", ...over });
const lodash = component("npm-dependency:twizz-sentinel:lodash", { name: "lodash", environments: ["staging", "prod"], desired: null, bump: "none", status: "current" });
const CLEAN = [cp("nonprod"), cp("staging"), cp("prod"), lodash];
const plan = (components = CLEAN, cov: LifecycleEnvironmentCoverage[] | null = coverage(), at = ago(DAY), doc = {}) => snap("plan", at, { runId: "plan-now", components, ...(cov ? { coverage: cov } : {}), ...doc });
const cve = (advisories = [] as ReturnType<typeof advisory>[], at = ago(2 * HOUR)) => snap("cve", at, { runId: "cve-now", advisories });

const build = (rows: EnvironmentsInput["rows"], over: Partial<EnvironmentsInput> = {}) => buildEnvironments({ rows, now: NOW, planHistory: [], ...over });
const byName = (rows: EnvironmentsInput["rows"], over: Partial<EnvironmentsInput> = {}) => Object.fromEntries(build(rows, over).environments.map((e) => [e.name, e])) as Record<string, EnvironmentView>;
const tierOf = (e: EnvironmentView, t: LifecycleTier) => e.tiers.find((x) => x.tier === t)!;

describe("words", () => {
  it("every word the derivation ranks is in the closed vocabulary, and Ember stays the human gate's", () => {
    for (const w of ENV_WORD_RANK) expect(STATUS_WORDS as readonly string[], w).toContain(w);
    expect(worstWord([])).toBe("OK");
    expect(worstWord(["OK", "RUNNING", "PENDING"])).toBe("PENDING");
    expect(worstWord(["WATCH", "AWAITING HUMAN", "PENDING"])).toBe("AWAITING HUMAN");
    expect(worstWord(["FAIL", "DENIED"])).toBe("FAIL");
    // a word this derivation does not make can never read better than OK
    expect(worstWord(["STUB"])).toBe("UNKNOWN");
  });

  it("counts fold PLO's nine statuses into what an operator asks about", () => {
    const rows = (["current", "applied", "outdated", "pr-open", "awaiting-approval", "blocked", "escalated", "failed", "unknown"] as const).map((status) => ({ status }));
    expect(countComponents([...rows, { status: "current" as const, eol: { eol: true } }])).toEqual({ total: 10, current: 3, behind: 3, blocked: 1, escalated: 1, failed: 1, unknown: 1, awaitingApproval: 1, eol: 1 });
  });

  it("a change set's word: an audit-only one is reported, never acted on", () => {
    expect(changeSetWord("planned", "auto")).toBe("PENDING");
    expect(changeSetWord("pr-opened", "pr")).toBe("RUNNING");
    expect(changeSetWord("awaiting-approval", "approval")).toBe("AWAITING HUMAN");
    expect(changeSetWord("escalated", "escalate")).toBe("WATCH");
    expect(changeSetWord("rollback-failed", "auto")).toBe("FAIL");
    expect(changeSetWord("blocked-precheck", "auto")).toBe("DENIED");
    expect(changeSetWord("planned", "ignore")).toBe("OBSERVE ONLY");
    expect(changeSetWord("something-new", "auto")).toBe("UNKNOWN");
  });
});

describe("buildEnvironments: every fixed environment, always", () => {
  it("lists nonprod, staging and prod with their clusters before any snapshot exists — as UNKNOWN, not as fine", () => {
    const view = build([]);
    expect(view.environments.map((e) => [e.name, e.kind, e.clusters])).toEqual([
      ["nonprod", "fixed", ["EKS-Twizz-NonProd"]],
      ["staging", "fixed", ["EKS-Moly-staging"]],
      ["prod", "fixed", ["EKS-Moly-Prod"]],
    ]);
    expect(view).toMatchObject({ observed: 0, fixed: 3 });
    for (const e of view.environments) {
      expect(e.word, e.name).toBe("UNKNOWN");
      expect(e.observation).toMatchObject({ state: "not-observed", word: "UNKNOWN", lastObserved: null });
      expect(e.headline).toMatch(/^not observed: /);
      expect(e.observation.reasons.join(" ")).toMatch(/no plan snapshot received yet/);
      expect(e.tiers.map((t) => t.tier)).toEqual([...LIFECYCLE_TIERS]);
    }
  });

  it("observed and current: OK only with full coverage, a fresh plan, a fresh CVE scan and nothing open", () => {
    const envs = byName([plan(), cve()]);
    for (const name of ["nonprod", "staging", "prod"]) {
      expect(envs[name].word, name).toBe("OK");
      expect(envs[name].observation).toMatchObject({ state: "observed", word: "OK", reasons: [], lastObserved: { job: "plan", runId: "plan-now", at: ago(DAY).toISOString() } });
      expect(envs[name].headline).toMatch(/^observed and current/);
    }
    // a tier that does not apply carries no pill and never counts against the environment
    expect(tierOf(envs.nonprod, "npm-direct")).toMatchObject({ state: "not-applicable", word: null });
    expect(tierOf(envs.staging, "npm-direct")).toMatchObject({ state: "observed", word: "OK", total: 1, current: 1 });
    expect(envs.prod.monitor).toBe("production");
    expect(envs.staging.monitor).toBe("staging");
    expect(envs.nonprod.monitor).toBeNull();
  });

  it("never OK without a CVE scan, and WATCH when the scan is older than its schedule allows", () => {
    expect(byName([plan()]).staging).toMatchObject({ word: "UNKNOWN", headline: "no CVE scan yet, so open advisories are not known", advisories: { scanned: false } });
    expect(byName([plan()]).staging.observation.state).toBe("observed");
    const old = byName([plan(), cve([], ago(3 * DAY))]).staging;
    expect(old.word).toBe("WATCH");
    expect(old.headline).toMatch(/cve data is older than 36 h/);
  });
});

describe("buildEnvironments: not observed is never green", () => {
  it("a cluster the plan could not reach is UNKNOWN with the reason, while the others stay as they are", () => {
    const gap = "EKS-Moly-Prod: cluster API not reachable via context moly-prod (timeout)";
    const cov = coverage({ prod: { "control-plane": tier("control-plane", "not-observed", ["no control plane was read for EKS-Moly-Prod"], 0), addons: tier("addons", "not-observed", ["aws eks list-addons failed"], 0), nodes: tier("nodes", "not-observed", ["x"], 0), helm: tier("helm", "not-observed", [gap], 0) } });
    const view = build([plan([cp("nonprod"), cp("staging"), lodash], cov), cve()]);
    const envs = Object.fromEntries(view.environments.map((e) => [e.name, e]));
    expect(view).toMatchObject({ observed: 2, fixed: 3 });
    expect(envs.prod.word).toBe("UNKNOWN");
    expect(envs.prod.observation.state).toBe("not-observed");
    expect(envs.prod.headline).toBe("not observed: EKS-Moly-Prod was not read — Control plane: no control plane was read for EKS-Moly-Prod");
    expect(tierOf(envs.prod, "helm")).toMatchObject({ state: "not-observed", word: "UNKNOWN", reasons: [gap] });
    // the repository tiers WERE read for prod, and still do not make the environment observed
    expect(tierOf(envs.prod, "npm-direct")).toMatchObject({ state: "observed", total: 1 });
    expect(envs.staging.word).toBe("OK");
    expect(envs.nonprod.word).toBe("OK");
  });

  it("stays UNKNOWN even when older rows say everything is current", () => {
    // the plan lists a (stale) control-plane row for prod but its coverage says the cluster was not read
    const cov = coverage({ prod: { "control-plane": tier("control-plane", "not-observed", ["aws eks describe-cluster failed: AccessDenied"], 0) } });
    const prod = byName([plan(CLEAN, cov), cve()]).prod;
    expect(prod.counts).toMatchObject({ total: 2, current: 2 });
    expect(prod.word).toBe("UNKNOWN");
    expect(prod.headline).toMatch(/AccessDenied/);
  });

  it("rows left out of the snapshot are not a clean observation: coverage that counts more than the rows carried is partial", () => {
    // PLO keeps the coverage list when it drops rows to fit the size limits (capComponents, fitBody): the run read
    // 400 npm packages for prod, the snapshot carries one of them
    const cov = coverage({ prod: { "npm-direct": tier("npm-direct", "observed", [], 400) }, staging: { "npm-direct": tier("npm-direct", "partial", ["frontend: package-lock.json could not be read"], 400) } });
    const envs = byName([plan(CLEAN, cov), cve()]);
    expect(tierOf(envs.prod, "npm-direct")).toMatchObject({ state: "partial", word: "WATCH", total: 1 });
    expect(tierOf(envs.prod, "npm-direct").reasons).toEqual(["the plan run plan-now read 400 components of this tier here but its snapshot carries 1: rows were left out to fit the size limit, so the counts understate"]);
    expect(envs.prod.observation.state).toBe("partial");
    expect(envs.prod.word).toBe("WATCH");
    expect(envs.prod.headline).toMatch(/^observed in part: .*read 400 components.*carries 1/);
    // a tier that already has a gap keeps it, and says this too
    expect(tierOf(envs.staging, "npm-direct").reasons).toEqual(["frontend: package-lock.json could not be read", expect.stringMatching(/read 400 components.*carries 1/)]);
    // as many rows as the run counted (or more, after a merge) is what a whole snapshot looks like
    expect(byName([plan(CLEAN, coverage()), cve()]).prod.word).toBe("OK");
  });

  it("an environment or tier listed twice in one coverage list: the entry that claims least counts", () => {
    const unread = coverage({ prod: { "control-plane": tier("control-plane", "not-observed", ["aws eks describe-cluster failed: AccessDenied"], 0) } });
    for (const cov of [
      [...coverage(), ...unread.filter((e) => e.environment === "prod")],
      [...unread.filter((e) => e.environment === "prod"), ...coverage()],
    ]) {
      const prod = byName([plan(CLEAN, cov), cve()]).prod;
      expect(tierOf(prod, "control-plane")).toMatchObject({ state: "not-observed", word: "UNKNOWN" });
      expect(tierOf(prod, "control-plane").reasons).toEqual(["aws eks describe-cluster failed: AccessDenied", "the plan run plan-now lists this tier 2 times for this environment; the worst entry is shown"]);
      expect(prod.word).toBe("UNKNOWN");
    }
    // the same tier twice inside one entry
    const twice = coverage().map((e) => (e.environment === "staging" ? { ...e, tiers: [...e.tiers, tier("helm", "partial", ["EKS-Moly-staging: Helm releases read in 2 of 9 namespaces"])] } : e));
    const staging = byName([plan(CLEAN, twice), cve()]).staging;
    expect(tierOf(staging, "helm")).toMatchObject({ state: "partial", word: "WATCH" });
    expect(staging.word).toBe("WATCH");
  });

  it("a plan that does not list the environment, or did not survey a tier, did not observe it", () => {
    const missing = coverage().filter((e) => e.environment !== "nonprod");
    const nonprod = byName([plan(CLEAN, missing), cve()]).nonprod;
    expect(nonprod.word).toBe("UNKNOWN");
    expect(nonprod.observation.reasons[0]).toMatch(/does not list this environment/);
    // --only helm-release: the EKS tiers are absent from coverage
    const narrow = coverage({ staging: { "control-plane": null, addons: null, nodes: null } });
    const staging = byName([plan(CLEAN, narrow), cve()]).staging;
    expect(staging.observation.state).toBe("not-observed");
    expect(tierOf(staging, "addons").reasons[0]).toMatch(/did not survey this tier/);
  });

  it("a gap next to rows is WATCH (observed in part), with the gap in words", () => {
    const gap = "EKS-Moly-staging: Helm releases read in 2 of 9 namespaces (Secrets are listable only there); a release in any other namespace is not seen";
    const staging = byName([plan(CLEAN, coverage({ staging: { helm: tier("helm", "partial", [gap]) } })), cve()]).staging;
    expect(staging.word).toBe("WATCH");
    expect(staging.observation).toMatchObject({ state: "partial", word: "WATCH" });
    expect(staging.headline).toBe(`observed in part: incomplete — Helm: ${gap}`);
    expect(tierOf(staging, "helm")).toMatchObject({ state: "partial", word: "WATCH" });
  });

  it("a tier that was not read, next to a cluster that was, is partial — not unknown, not fine", () => {
    const staging = byName([plan(CLEAN, coverage({ staging: { nodes: tier("nodes", "not-observed", ["aws eks list-nodegroups failed: Throttling"], 0) } })), cve()]).staging;
    expect(staging.observation.state).toBe("partial");
    expect(staging.word).toBe("WATCH");
    expect(staging.observation.reasons[0]).toBe("not read — Nodes: aws eks list-nodegroups failed: Throttling");
  });

  it("data older than the plan's schedule allows is stale: WATCH, and it says which run", () => {
    const staging = byName([plan(CLEAN, coverage(), ago(9 * DAY)), cve()]).staging;
    expect(staging.observation).toMatchObject({ state: "stale", word: "WATCH" });
    expect(staging.word).toBe("WATCH");
    expect(staging.headline).toBe("stale: plan data is older than 8 days (run plan-now); a newer run has not reported");
    expect(staging.freshness.find((f) => f.job === "plan")).toMatchObject({ word: "WATCH", runId: "plan-now" });
  });

  it("a failed run's rows never make a clean observation; a newer failed run is said, and the older data kept", () => {
    const failedOnly = byName([plan(CLEAN, coverage(), ago(HOUR), { ok: false, error: "no component was discovered" }), cve()]).staging;
    expect(failedOnly.observation.state).toBe("partial");
    expect(failedOnly.word).toBe("WATCH");
    expect(tierOf(failedOnly, "control-plane").reasons[0]).toMatch(/from a failed run \(no component was discovered\)/);
    const good = plan(CLEAN, coverage(), ago(2 * DAY));
    const bad = snap("plan", ago(HOUR), { runId: "plan-bad", ok: false, error: "kubeconfig could not be built" });
    const after = byName([good, bad, cve()]).staging;
    expect(after.observation.state).toBe("observed");
    expect(after.word).toBe("WATCH");
    expect(after.headline).toBe("the latest plan run (plan-bad) failed: kubeconfig could not be built; showing run plan-now from before it");
  });

  it("a snapshot without a coverage list vouches only for the tiers it has rows for", () => {
    const envs = byName([plan(CLEAN, null), cve()]);
    // rows for the control plane and npm-direct; nothing says whether add-ons, nodes or Helm were read
    expect(tierOf(envs.staging, "control-plane").state).toBe("observed");
    expect(tierOf(envs.staging, "addons")).toMatchObject({ state: "not-observed", word: "UNKNOWN" });
    expect(tierOf(envs.staging, "addons").reasons[0]).toMatch(/carries no coverage list/);
    expect(envs.staging.observation.state).toBe("partial");
    expect(envs.staging.word).toBe("WATCH");
    // no control-plane row at all: the cluster is not known to have been read
    const noProd = byName([plan([cp("staging"), lodash], null), cve()]).prod;
    expect(noProd.word).toBe("UNKNOWN");
    // and a discovery error of the tier's domain makes the rows partial
    const withGap = snap("plan", ago(DAY), { components: CLEAN, discoveryErrors: [{ domain: "eks-control-plane", error: "describe-cluster-versions unavailable" }] });
    expect(tierCoverage(withGap, LIFECYCLE_ENVIRONMENTS[1], "control-plane", 1)).toEqual({ state: "partial", reasons: ["describe-cluster-versions unavailable"] });
  });

  // final verification 2026-11-25: attempts to get an unread environment shown as OK
  it("a coverage entry cannot vouch for a cluster the run has no control-plane row for", () => {
    // coverage says prod was read in full ("observed", nothing counted), but no row of the run is prod's cluster
    const claimed = byName([plan([cp("nonprod"), cp("staging"), lodash], coverage()), cve()]);
    expect(claimed.prod.word).toBe("UNKNOWN");
    expect(claimed.prod.observation.state).toBe("not-observed");
    expect(tierOf(claimed.prod, "control-plane").reasons[0]).toBe("the plan run plan-now carries no control-plane row for EKS-Moly-Prod");
    expect(claimed.staging.word).toBe("OK");
    // a control-plane row of ANOTHER cluster filed under prod is not prod's cluster having answered
    const borrowed = byName([plan([cp("nonprod"), cp("staging", { environments: ["staging", "prod"] }), lodash], coverage()), cve()]);
    expect(borrowed.prod.word).toBe("UNKNOWN");
    expect(borrowed.prod.observation.state).toBe("not-observed");
  });

  // second review round 2026-11-25, #5: the CVE scan has no coverage list, only its discovery errors
  it("a CVE scan that says it could not read an environment takes that environment's green away — and only that one's", () => {
    const scan = (errors: Array<{ domain: string; error: string }>) => snap("cve", ago(2 * HOUR), { runId: "cve-now", advisories: [], discoveryErrors: errors });
    // one cluster: that cluster's environment only
    const cluster = byName([plan(), scan([{ domain: "helm-release", error: "EKS-Moly-Prod: cluster API not reachable (timeout)" }])]);
    expect(cluster.prod.word).toBe("WATCH");
    expect(cluster.prod.headline).toBe("the CVE scan did not cover all of this environment: EKS-Moly-Prod: cluster API not reachable (timeout)");
    expect(cluster.prod.advisories).toMatchObject({ scanned: true, total: 0, gaps: ["EKS-Moly-Prod: cluster API not reachable (timeout)"] });
    expect(cluster.staging).toMatchObject({ word: "OK", advisories: { gaps: [] } });
    expect(cluster.nonprod.word).toBe("OK");
    // one repository: the environments its components are in (twizz-sentinel: staging and prod), not nonprod
    const repo = byName([plan(), scan([{ domain: "npm-dependency", error: "twizz-sentinel: package-lock.json could not be read" }])]);
    expect([repo.nonprod.word, repo.staging.word, repo.prod.word]).toEqual(["OK", "WATCH", "WATCH"]);
    // an advisory source that did not answer, a cut snapshot, or a name nobody knows: every environment
    for (const e of [{ domain: "kev", error: "CISA KEV could not be fetched (HTTP 503)" }, { domain: "snapshot", error: "reduced to fit the 4096 KiB body limit: advisories 9000 -> 4000" }, { domain: "eks-addon", error: "EKS-Somewhere-Else: access denied" }]) {
      const all = byName([plan(), scan([e])]);
      expect([all.nonprod.word, all.staging.word, all.prod.word], e.domain).toEqual(["WATCH", "WATCH", "WATCH"]);
      expect(all.prod.headline, e.domain).toContain(e.error);
    }
    // a scan that failed and is shown for want of a good one: "none open" is not known anywhere
    const failed = byName([plan(), snap("cve", ago(2 * HOUR), { runId: "cve-bad", ok: false, error: "OSV did not answer", advisories: [] })]);
    expect(failed.prod.word).toBe("WATCH");
    expect(failed.prod.advisories.gaps[0]).toMatch(/^the CVE scan shown \(run cve-bad\) failed: OSV did not answer/);
  });

  it("pass 3 #4: a CVE gap is never dropped because its subject has no environment, or because a source run named it", () => {
    const scan = (errors: Array<{ domain: string; error: string }>) => snap("cve", ago(2 * HOUR), { runId: "cve-now", advisories: [], discoveryErrors: errors });
    const words = (envs: Record<string, EnvironmentView>) => [envs.nonprod.word, envs.staging.word, envs.prod.word];
    // a repository whose only rows carry no environment: the error is about nobody the dashboard can place → everybody
    const homeless = component("npm-dependency:twizz-sentinel:lodash", { name: "lodash", target: "twizz-sentinel", environments: [], desired: null, bump: "none", status: "current" });
    const a = byName([plan([cp("nonprod"), cp("staging"), cp("prod"), homeless]), scan([{ domain: "npm-dependency", error: "twizz-sentinel: OSV timeout" }])]);
    expect(words(a)).toEqual(["WATCH", "WATCH", "WATCH"]);
    for (const e of [a.nonprod, a.staging, a.prod]) expect(e.advisories.gaps, e.name).toEqual(["twizz-sentinel: OSV timeout"]);
    // an advisory that names the subject without an environment does not place it either
    const b = byName([plan(), snap("cve", ago(2 * HOUR), { runId: "cve-now", advisories: [advisory("GHSA-x", { affected: [affects("x", { target: "OSV", environments: [] })] })], discoveryErrors: [{ domain: "osv", error: "OSV: 503" }] })]);
    for (const e of [b.nonprod, b.staging, b.prod]) expect(e.advisories.gaps, e.name).toEqual(["OSV: 503"]);
    // a source run (assembled next to repository code) cannot claim an advisory source as "its" target and so keep
    // that source's failure away from the other environments — by a component row or by a coverage entry
    const claim = snap("source", ago(HOUR), { runId: "source-now", components: [component("npm-dependency:OSV:x", { target: "OSV", environments: ["nonprod"] }), component("npm-dependency:CISA KEV:x", { target: "CISA KEV", environments: [] })], coverage: [{ environment: "phantom", clusters: ["EPSS"], tiers: [] }] });
    for (const error of ["OSV: 503", "CISA KEV: could not be fetched", "EPSS: timeout"]) {
      const c = byName([plan(), scan([{ domain: "cve", error }]), claim]);
      for (const e of [c.nonprod, c.staging, c.prod]) expect(e.advisories.gaps, `${error} / ${e.name}`).toEqual([error]);
      expect(c.prod.headline, error).toContain(error);
    }
    // control: what the PLAN places stays placed (twizz-sentinel is in staging and prod, not in nonprod)
    const placed = byName([plan(), scan([{ domain: "npm-dependency", error: "twizz-sentinel: package-lock.json could not be read" }]), claim]);
    expect([placed.nonprod, placed.staging, placed.prod].map((e) => e.advisories.gaps.length)).toEqual([0, 1, 1]);
  });

  it("pass 3 #8.5: a tier's word is not OK while its advisories are not known", () => {
    // no CVE scan at all: read and current, and what is open against it is not known
    const noScan = byName([plan()]);
    expect(tierOf(noScan.prod, "control-plane")).toMatchObject({ state: "observed", advisories: null, word: "UNKNOWN" });
    expect(tierOf(noScan.staging, "npm-direct").word).toBe("UNKNOWN");
    expect(tierOf(noScan.nonprod, "npm-direct").word).toBeNull(); // does not apply: no word
    // the scan says it could not read prod: prod's tiers are not a clean OK, staging's are
    const gap = byName([plan(), snap("cve", ago(2 * HOUR), { runId: "cve-now", advisories: [], discoveryErrors: [{ domain: "helm-release", error: "EKS-Moly-Prod: cluster API not reachable (timeout)" }] })]);
    expect(tierOf(gap.prod, "control-plane").word).toBe("WATCH");
    expect(tierOf(gap.prod, "npm-direct").word).toBe("WATCH");
    expect(tierOf(gap.staging, "control-plane").word).toBe("OK");
    // control: scanned, nothing missing
    expect(tierOf(byName([plan(), cve()]).prod, "control-plane").word).toBe("OK");
  });

  it("pass 3 #9: UNKNOWN is never hidden behind PENDING or RUNNING", () => {
    expect(worstWord(["PENDING", "UNKNOWN"])).toBe("UNKNOWN");
    expect(worstWord(["RUNNING", "UNKNOWN", "OK"])).toBe("UNKNOWN");
    expect(worstWord(["WATCH", "UNKNOWN"])).toBe("WATCH");
    expect(ENV_WORD_RANK.indexOf("UNKNOWN")).toBeLessThan(ENV_WORD_RANK.indexOf("PENDING"));
    // one package behind in prod and no CVE scan yet: what is open is not known, and that is the word
    const behind = component("npm-dependency:twizz-sentinel:express", { name: "express", environments: ["prod"], status: "outdated" });
    const prod = byName([plan([...CLEAN, behind], coverage())]).prod;
    expect(prod.word).toBe("UNKNOWN");
    expect(prod.headline).toBe("no CVE scan yet, so open advisories are not known");
    // a component that could not be assessed next to one that is behind
    const unassessed = component("npm-dependency:twizz-sentinel:zod", { name: "zod", environments: ["prod"], status: "unknown" });
    const mixed = byName([plan([...CLEAN, behind, unassessed], coverage()), cve()]).prod;
    expect(mixed.word).toBe("UNKNOWN");
    expect(mixed.headline).toBe("1 component could not be assessed");
    expect(mixed.counts).toMatchObject({ behind: 1, unknown: 1 });
  });

  it("pass 3 #3: a cluster's control plane is never 'does not apply' — an environment whose cluster nobody read is not observed", () => {
    // every cluster tier of prod marked not-applicable, no control-plane row for EKS-Moly-Prod; the repository tiers are read and current
    const na = (t: LifecycleTier) => tier(t, "not-applicable");
    const cov = coverage({ prod: { "control-plane": na("control-plane"), addons: na("addons"), nodes: na("nodes"), helm: na("helm") } });
    const envs = byName([plan([cp("nonprod"), cp("staging"), lodash], cov), cve()]);
    expect(envs.prod.observation.state).toBe("not-observed");
    expect(envs.prod.word).toBe("UNKNOWN");
    expect(envs.prod.headline).toMatch(/^not observed: EKS-Moly-Prod was not read/);
    expect(tierOf(envs.prod, "control-plane")).toMatchObject({ state: "not-observed", word: "UNKNOWN" });
    expect(tierOf(envs.prod, "control-plane").reasons[0]).toMatch(/says the control plane does not apply to prod, which has the cluster EKS-Moly-Prod/);
    expect(build([plan([cp("nonprod"), cp("staging"), lodash], cov), cve()]).observed).toBe(2);
    // the same when the row IS there: the run still said it did not look
    expect(byName([plan(CLEAN, cov), cve()]).prod.observation.state).toBe("not-observed");
    // control: an environment with no cluster at all may say so
    const sandbox = byName([plan([...CLEAN, component("x:thing", { environments: ["sandbox"] })], [...coverage(), { environment: "sandbox", clusters: [], tiers: LIFECYCLE_TIERS.map((t) => (t === "npm-direct" ? tier(t) : na(t))) }]), cve()]).sandbox;
    expect(tierOf(sandbox, "control-plane").state).toBe("not-applicable");
    expect(sandbox.observation.state).toBe("observed");
  });

  it("a newer CVE run that failed is said: yesterday's clean scan is not today's", () => {
    const yesterday = snap("cve", ago(25 * HOUR), { runId: "cve-yesterday", advisories: [] });
    const today = snap("cve", ago(HOUR), { runId: "cve-today", ok: false, error: "OSV did not answer" });
    const envs = byName([plan(), yesterday, today]);
    for (const name of ["nonprod", "staging", "prod"]) {
      expect(envs[name].word, name).toBe("WATCH");
      expect(envs[name].headline, name).toBe("the latest cve run (cve-today) failed: OSV did not answer; showing run cve-yesterday from before it");
      expect(envs[name].freshness.find((f) => f.job === "cve"), name).toMatchObject({ word: "WATCH", runId: "cve-yesterday" });
    }
    // control: without the failed run the same scan is fresh
    expect(byName([plan(), yesterday]).prod.word).toBe("OK");
  });

  // second review round 2026-11-25, #9.2
  it("a failed source run never speaks instead of a successful plan: the plan's rows and its reading stay", () => {
    const failedSource = snap("source", ago(HOUR), { runId: "source-bad", ok: false, error: "run.json was not written" });
    const s = byName([plan(), cve(), failedSource]).staging;
    expect(tierOf(s, "npm-direct")).toMatchObject({ state: "observed", total: 1, from: { job: "plan", runId: "plan-now" } });
    expect(s.observation.state).toBe("observed");
    expect(s.word).toBe("OK");
    // …and its partial rows and change sets do not replace the plan's either
    const half = snap("source", ago(HOUR), { runId: "source-half", ok: false, error: "frontend: npm ci failed", components: [{ ...lodash, status: "applied" as const }], changeSets: [] });
    expect(tierOf(byName([plan([cp("nonprod"), cp("staging"), cp("prod"), { ...lodash, status: "outdated" as const, desired: "4.17.21", bump: "patch" as const }]), cve(), half]).staging, "npm-direct")).toMatchObject({ behind: 1, current: 0 });
    // with no successful plan to fall back on, the failed source run is all there is — and it is never a clean read
    const alone = byName([cve(), half]).staging;
    expect(alone.word).toBe("UNKNOWN");
  });

  // second review round 2026-11-25, #10.1
  it("last observed: a run that surveyed only some tiers (plan --only) did not observe the environment", () => {
    const cov = coverage({ prod: { "control-plane": tier("control-plane", "not-observed", ["timeout"], 0) } });
    const only = coverage().map((e) => ({ ...e, tiers: e.tiers.filter((t) => t.tier === "control-plane") }));
    const history: CoverageHistoryRow[] = [
      { job: "plan", runId: "plan-now", ok: true, finishedAt: ago(DAY), coverage: cov },
      { job: "plan", runId: "plan-only-cp", ok: true, finishedAt: ago(2 * DAY), coverage: only },
      { job: "plan", runId: "plan-full", ok: true, finishedAt: ago(9 * DAY), coverage: coverage() },
    ];
    expect(byName([plan(CLEAN, cov), cve()], { planHistory: history }).prod.observation.lastObserved).toEqual({ at: ago(9 * DAY).toISOString(), job: "plan", runId: "plan-full" });
  });

  it("pass 3 #11: an earlier plan whose control plane has no row did not observe a cluster; 'last observed' names a run that read the environment", () => {
    const cov = coverage({ prod: { "control-plane": tier("control-plane", "not-observed", ["timeout"], 0) } });
    // an earlier run that calls prod's control plane "observed" with ZERO components: a cluster that answered has one
    const hollow = coverage({ prod: { "control-plane": tier("control-plane", "observed", [], 0) } });
    const history: CoverageHistoryRow[] = [
      { job: "plan", runId: "plan-now", ok: true, finishedAt: ago(DAY), coverage: cov },
      { job: "plan", runId: "plan-hollow", ok: true, finishedAt: ago(2 * DAY), coverage: hollow },
      { job: "plan", runId: "plan-full", ok: true, finishedAt: ago(9 * DAY), coverage: coverage() },
    ];
    expect(byName([plan(CLEAN, cov), cve()], { planHistory: history }).prod.observation.lastObserved).toEqual({ at: ago(9 * DAY).toISOString(), job: "plan", runId: "plan-full" });
    expect(byName([plan(CLEAN, cov), cve()], { planHistory: history.slice(0, 2) }).prod.observation.lastObserved).toBeNull();

    // an environment only a SOURCE run reads (no cluster; the plan does not list it): "last observed" is that run,
    // not the plan that never looked at it
    const thing = component("npm-dependency:edge:thing", { target: "edge", environments: ["edge"] });
    const planRow = plan(CLEAN, coverage(), ago(10 * DAY));
    const sourceRow = snap("source", ago(HOUR), { runId: "source-now", components: [thing], coverage: [{ environment: "edge", clusters: [], tiers: SOURCE.map((t) => tier(t, "observed", [], t === "npm-direct" ? 1 : 0)) }] });
    const edge = byName([planRow, cve(), sourceRow]).edge;
    expect(edge.kind).toBe("reported");
    expect(tierOf(edge, "npm-direct")).toMatchObject({ state: "observed", from: { job: "source", runId: "source-now" } });
    expect(edge.observation.lastObserved).toEqual({ at: ago(HOUR).toISOString(), job: "source", runId: "source-now" });
    // control: when both runs supply tiers, the OLDER one is named, so freshness is never overstated
    const both = byName([plan(CLEAN, coverage(), ago(DAY)), cve(), snap("source", ago(HOUR), { runId: "source-now", components: [lodash], coverage: coverage().map((e) => ({ ...e, tiers: e.tiers.filter((t) => SOURCE.includes(t.tier)).map((t) => (t.tier === "npm-direct" && e.environment !== "nonprod" ? tier(t.tier, "observed", [], 1) : t)) })) })]).staging;
    expect(both.observation.lastObserved).toMatchObject({ job: "plan", runId: "plan-now" });
  });

  it("last observed: from the run shown when it read the environment, else the newest earlier plan that did", () => {
    const cov = coverage({ prod: { "control-plane": tier("control-plane", "not-observed", ["timeout"], 0) } });
    const history: CoverageHistoryRow[] = [
      { job: "plan", runId: "plan-now", ok: true, finishedAt: ago(DAY), coverage: cov },
      { job: "plan", runId: "plan-failed", ok: false, finishedAt: ago(5 * DAY), coverage: coverage() },
      { job: "plan", runId: "plan-old-schema", ok: true, finishedAt: ago(6 * DAY), coverage: null },
      { job: "plan", runId: "plan-good", ok: true, finishedAt: ago(8 * DAY), coverage: coverage() },
      { job: "plan", runId: "plan-older", ok: true, finishedAt: ago(15 * DAY), coverage: coverage() },
    ];
    const envs = byName([plan(CLEAN, cov), cve()], { planHistory: history });
    expect(envs.prod.observation.lastObserved).toEqual({ at: ago(8 * DAY).toISOString(), job: "plan", runId: "plan-good" });
    expect(envs.staging.observation.lastObserved).toEqual({ at: ago(DAY).toISOString(), job: "plan", runId: "plan-now" });
    // never observed by any run Nebula has
    expect(byName([plan(CLEAN, cov), cve()], { planHistory: [history[0]] }).prod.observation.lastObserved).toBeNull();
    // the history could not be read: said, not guessed
    expect(build([plan(), cve()], { planHistory: undefined }).notes).toEqual(['earlier plan runs could not be read, so "last observed" is known only from the run shown']);
  });
});

describe("buildEnvironments: what stands in each environment", () => {
  const stgCp = cp("staging", { current: "1.31", desired: "1.32", bump: "minor", status: "awaiting-approval", autonomy: "approval", changeSetId: "staging-cp" });
  const prodNodes = component("eks-nodegroup:EKS-Moly-Prod:general", { tier: "nodes", domain: "eks-nodegroup", name: "general", target: "EKS-Moly-Prod", environments: ["prod"], status: "blocked" });
  const express = component("npm-dependency:twizz-sentinel:express", { name: "express", environments: ["staging", "prod"], status: "pr-open", pr: pr(SENTINEL, 41), changeSetId: "source-sentinel-express" });
  const node = component("base-image:Moly-backend:node", { tier: "base-images", domain: "base-image", name: "node", target: "Moly-backend", environments: ["prod"], status: "failed", eol: { eol: true, date: "2025-04-30" } });
  const helmNp = component("helm-release:EKS-Twizz-NonProd:argo-cd", { tier: "helm", domain: "helm-release", name: "argo-cd", target: "EKS-Twizz-NonProd", environments: ["nonprod"], status: "outdated", autonomy: "ignore" });
  const components = [cp("nonprod"), stgCp, cp("prod"), prodNodes, express, node, lodash, helmNp];
  const changeSets = [
    { id: "staging-cp", stage: "staging", target: "EKS-Moly-staging", domain: "eks-control-plane", tier: "control-plane" as const, autonomy: "approval", status: "awaiting-approval", rationale: [], componentIds: [stgCp.id] },
    { id: "nonprod-helm-argo", stage: "nonprod", target: "EKS-Twizz-NonProd", domain: "helm-release", tier: "helm" as const, autonomy: "ignore", status: "planned", rationale: [], componentIds: [helmNp.id] },
    { id: "source-sentinel-express", stage: "source", target: "twizz-sentinel", domain: "npm-dependency", tier: "npm-direct" as const, autonomy: "pr", status: "pr-opened", rationale: [], componentIds: [express.id], pr: pr(SENTINEL, 41) },
    { id: "source-backend-node", stage: "source", target: "Moly-backend", domain: "base-image", tier: "base-images" as const, autonomy: "escalate", status: "escalated", rationale: [], componentIds: [node.id], escalationUrl: "https://github.com/twizz-app/platform-lifecycle-orchestrator/issues/9" },
    { id: "staging-done", stage: "staging", target: "EKS-Moly-staging", domain: "eks-addon", tier: "addons" as const, autonomy: "auto", status: "applied", rationale: [], componentIds: [] },
  ];
  const advisories = [
    advisory("CVE-2026-1000", { severity: "high", kev: true, affected: [affects(lodash.id, { name: "lodash", environments: ["staging", "prod"] })] }),
    advisory("CVE-2026-2000", { severity: "critical", affected: [affects(node.id, { name: "node", tier: "base-images", target: "Moly-backend", environments: ["prod"] })] }),
    advisory("GHSA-mod-0002", { severity: "moderate", affected: [affects(express.id, { name: "express", environments: ["staging"] })] }),
  ];
  const rows = [snap("plan", ago(DAY), { runId: "plan-now", components, changeSets, coverage: coverage() }), cve(advisories)];
  const envs = byName(rows);

  it("counts per environment and per tier, and takes the worst as the word", () => {
    expect(envs.staging.counts).toEqual({ total: 3, current: 1, behind: 2, blocked: 0, escalated: 0, failed: 0, unknown: 0, awaitingApproval: 1, eol: 0 });
    expect(envs.staging.word).toBe("AWAITING HUMAN");
    expect(envs.staging.headline).toBe("1 upgrade awaiting approval");
    expect(envs.prod.counts).toMatchObject({ total: 5, current: 2, behind: 1, blocked: 1, failed: 1, eol: 1 });
    expect(envs.prod.word).toBe("FAIL");
    expect(envs.prod.headline).toBe("1 upgrade failed");
    expect(tierOf(envs.prod, "nodes")).toMatchObject({ blocked: 1, word: "DENIED" });
    expect(tierOf(envs.prod, "base-images")).toMatchObject({ failed: 1, eol: 1, advisories: 1, word: "FAIL" });
    expect(tierOf(envs.staging, "control-plane")).toMatchObject({ behind: 1, awaitingApproval: 1, word: "AWAITING HUMAN" });
    expect(envs.nonprod.counts).toMatchObject({ total: 2, current: 1, behind: 1 });
    expect(envs.nonprod.word).toBe("PENDING");
  });

  it("open advisories by severity, with the known-exploited ones called out, only for the environment they affect", () => {
    expect(envs.prod.advisories).toEqual({ scanned: true, total: 2, counts: { critical: 1, high: 1, moderate: 0, low: 0, unknown: 0 }, kev: 1, gaps: [] });
    expect(envs.staging.advisories).toEqual({ scanned: true, total: 2, counts: { critical: 0, high: 1, moderate: 1, low: 0, unknown: 0 }, kev: 1, gaps: [] });
    expect(envs.nonprod.advisories).toMatchObject({ scanned: true, total: 0, kev: 0 });
    expect(tierOf(envs.staging, "npm-direct")).toMatchObject({ advisories: 2, kev: 1, word: "WATCH" });
    // an environment whose components are all current is still not OK while a known-exploited advisory is open
    const quiet = byName([plan(), cve([advisories[0]])]);
    expect(quiet.prod.word).toBe("WATCH");
    expect(quiet.prod.headline).toBe("1 known-exploited advisory");
    expect(quiet.nonprod.word).toBe("OK");
  });

  it("pending change sets with their pull requests: infrastructure by stage, repositories by where they deploy", () => {
    expect(envs.staging.changeSets.map((c) => [c.id, c.word])).toEqual([["staging-cp", "AWAITING HUMAN"], ["source-sentinel-express", "RUNNING"]]);
    expect(envs.staging.changeSets[1].pr?.number).toBe(41);
    expect(envs.prod.changeSets.map((c) => c.id)).toEqual(["source-backend-node", "source-sentinel-express"]);
    expect(envs.prod.changeSets[0]).toMatchObject({ word: "WATCH", escalationUrl: "https://github.com/twizz-app/platform-lifecycle-orchestrator/issues/9" });
    // audit-only: reported, never acted on — and an applied change set is not pending
    expect(envs.nonprod.changeSets).toEqual([expect.objectContaining({ id: "nonprod-helm-argo", word: "OBSERVE ONLY" })]);
    expect(envs.staging.changeSetsTotal).toBe(2);
  });

  it("a newer source run speaks for the repository tiers only, and its change sets replace the plan's", () => {
    const sourceRun = snap("source", ago(HOUR), {
      runId: "source-now",
      components: [{ ...express, status: "pr-open" }, { ...stgCp, status: "current" }],
      changeSets: [{ ...changeSets[2], status: "pr-opened" }, { ...changeSets[0], status: "applied" }],
      coverage: coverage().map((e) => ({ ...e, tiers: e.tiers.filter((t) => SOURCE.includes(t.tier)).map((t) => (e.environment === "staging" && t.tier === "npm-direct" ? tier(t.tier, "partial", ["frontend: package-lock.json could not be read from origin/main"]) : t)) })),
    });
    const s = byName([...rows, sourceRun]).staging;
    expect(tierOf(s, "npm-direct")).toMatchObject({ state: "partial", from: { job: "source", runId: "source-now" } });
    // the control plane is still the plan's word: a source run cannot mark it read, current or applied
    expect(tierOf(s, "control-plane")).toMatchObject({ state: "observed", behind: 1, from: { job: "plan", runId: "plan-now" } });
    expect(s.changeSets.map((c) => [c.id, c.from])).toEqual([["staging-cp", "plan"], ["source-sentinel-express", "source"]]);
    expect(s.freshness.map((f) => f.job)).toEqual(["plan", "source", "cve"]);
    expect(s.observation.state).toBe("partial");
  });

  it("pass 3 #5: a source run cannot remove (or rewrite) a plan's infrastructure change set by reusing its id under a repository tier", () => {
    // the same id, relabelled as a repository tier and "applied" (or "skipped"): mergeComponents refuses this for rows
    for (const status of ["applied", "skipped", "planned"]) {
      const forged = snap("source", ago(HOUR), { runId: "source-now", components: [], changeSets: [{ ...changeSets[0], tier: "npm-direct" as const, domain: "npm-dependency", stage: "staging", status, autonomy: "ignore", componentIds: [] }], coverage: [] });
      const s = byName([...rows, forged]).staging;
      expect(s.changeSets.find((c) => c.id === "staging-cp"), status).toMatchObject({ tier: "control-plane", word: "AWAITING HUMAN", status: "awaiting-approval", from: "plan" });
      expect(s.changeSetsTotal, status).toBe(2);
    }
    // control: a repository-tier change set of the plan IS the source run's to finish
    const finished = snap("source", ago(HOUR), { runId: "source-now", components: [], changeSets: [{ ...changeSets[2], status: "applied" }], coverage: [] });
    expect(byName([...rows, finished]).staging.changeSets.map((c) => c.id)).toEqual(["staging-cp"]);
    // the same rule for what could not be placed anywhere: a source run cannot talk an unplaced infrastructure change set away
    const adrift = { ...changeSets[0], id: "elsewhere-cp", stage: "elsewhere", componentIds: ["eks-control-plane:EKS-Elsewhere"] };
    const planRow = snap("plan", ago(DAY), { runId: "plan-now", components: CLEAN, changeSets: [adrift], coverage: coverage() });
    const hush = snap("source", ago(HOUR), { runId: "source-now", components: [], changeSets: [{ ...adrift, tier: "npm-direct" as const, status: "applied" }], coverage: [] });
    expect(build([planRow, cve()]).notes.join("\n")).toMatch(/1 pending change set could not be placed in any environment \(elsewhere-cp\)/);
    expect(build([planRow, cve(), hush]).notes.join("\n")).toMatch(/1 pending change set could not be placed in any environment \(elsewhere-cp\)/);
  });

  it("what names no environment is said in the notes: a change set without rows, an advisory without an environment", () => {
    const orphan = { ...changeSets[0], id: "source-gone-left-pad", stage: "source", tier: "npm-direct" as const, status: "rollback-failed", autonomy: "pr", componentIds: ["npm-dependency:gone:left-pad"] };
    const done = { ...orphan, id: "source-gone-done", status: "applied" };
    const nowhere = advisory("GHSA-nowhere", { severity: "critical", kev: true, affected: [affects("npm-dependency:gone:left-pad", { environments: [] })] });
    const view = build([snap("plan", ago(DAY), { runId: "plan-now", components: CLEAN, changeSets: [orphan, done], coverage: coverage() }), cve([nowhere])]);
    for (const e of view.environments) expect([e.name, e.changeSetsTotal, e.advisories.total]).toEqual([e.name, 0, 0]);
    expect(view.notes).toEqual([
      "1 pending change set could not be placed in any environment (source-gone-left-pad): the snapshot has no row for their components, so no environment above counts them",
      "1 open advisory of the CVE scan names no environment listed here, so no environment above counts it: see the Advisories tab",
    ]);
    // everything placed: no note
    expect(build(rows).notes).toEqual([]);
  });

  it("caps the change-set list and still says how many there are", () => {
    const many = Array.from({ length: MAX_ENV_CHANGE_SETS + 7 }, (_, i) => ({ ...changeSets[0], id: `staging-cs-${String(i).padStart(2, "0")}`, status: "planned", autonomy: "auto" }));
    const s = byName([snap("plan", ago(DAY), { components: CLEAN, changeSets: many, coverage: coverage() }), cve()]).staging;
    expect(s.changeSets).toHaveLength(MAX_ENV_CHANGE_SETS);
    expect(s.changeSetsTotal).toBe(MAX_ENV_CHANGE_SETS + 7);
  });

  it("an environment name the inventory constant does not know is shown as reported, not dropped", () => {
    const odd = component("x:eu:thing", { environments: ["sandbox"] });
    const view = build([plan([...CLEAN, odd]), cve()]);
    expect(view.environments.map((e) => [e.name, e.kind])).toEqual([["nonprod", "fixed"], ["staging", "fixed"], ["prod", "fixed"], ["sandbox", "reported"]]);
    // coverage does not list it, so it is not observed
    expect(view.environments[3].word).toBe("UNKNOWN");
    expect(view.fixed).toBe(3);
  });
});

describe("buildEnvironments: the bundle and its preview envs", () => {
  const SERVICES: LifecycleServiceInput[] = [
    { service: "twizz-sentinel", repo: SENTINEL, promotable: true, stagingHost: "sentinel-stg.prv.twizz.com" },
    { service: "moly-backend", repo: BACKEND, promotable: false, stagingHost: null },
  ];
  const ENV_S = "plo-2611-twizz-sentinel";
  const ENV_B = "plo-2611-moly-backend";
  const source = snap("source", ago(DAY), { runId: "source-1", bundles: [bundle(SENTINEL, SHA_SENTINEL, { environments: ["staging", "prod"] }), bundle(BACKEND, SHA_BACKEND, { environments: ["staging", "prod"] })], bundleKey: KEY });
  const staging = [{ service: "twizz-sentinel", host: "sentinel-stg.prv.twizz.com", currentTag: "main-" + "1".repeat(40), argo: "PASS" as const, runsImage: true, rolledOutAt: ago(3 * HOUR).toISOString(), error: null }];
  const previewOf = (over: Partial<PreviewInput> = {}) => buildPreview({ rows: [source], requests: [], services: SERVICES, envs: [], promotions: [], staging, signoffs: [], envChanges: [], now: NOW, ...over });
  const withPreview = (over: Partial<PreviewInput> = {}) => byName([plan(), cve(), source], { preview: previewOf(over) });

  it("no bundle: no stage lines and no preview envs", () => {
    const envs = byName([plan(), cve()], { preview: buildPreview({ rows: [], requests: [], services: SERVICES, envs: [], promotions: [], staging, signoffs: [], envChanges: [], now: NOW }) });
    expect(Object.keys(envs)).toEqual(["nonprod", "staging", "prod"]);
    for (const e of Object.values(envs)) expect(e.stage).toEqual([]);
  });

  it("each environment gets the part of the bundle's road that concerns it", () => {
    const envs = withPreview();
    expect(envs.nonprod.stage.map((s) => [s.label, s.word])).toEqual([["preview", "PLANNED"], ["preview smoke", "PLANNED"]]);
    expect(envs.staging.stage.map((s) => [s.label, s.word])).toEqual([["bundle", "PLANNED"], ["staging smoke", "PLANNED"]]);
    expect(envs.staging.stage[0].detail).toBe(`bundle ${KEY.slice(0, 12)}: 0 of 1 service run the bundle image`);
    expect(envs.prod.stage.map((s) => [s.label, s.word])).toEqual([["sign-off", "PLANNED"]]);
    // the bundle's stage never changes whether an environment was observed, nor its word
    expect(envs.prod.word).toBe("OK");
  });

  it("live preview envs are listed after the fixed ones, read live, with their build, rollout and smoke", () => {
    const req = smokeRequest("preview", KEY, { status: "done", createdAt: ago(20 * 60_000), claimedAt: ago(15 * 60_000), finishedAt: ago(10 * 60_000), runId: "smoke-preview" });
    const building = env(ENV_B, BACKEND, SHA_BACKEND, { build: "building", imageTag: null, argo: null });
    const envs = withPreview({ envs: [env(ENV_S, SENTINEL, SHA_SENTINEL), building] });
    expect(Object.keys(envs)).toEqual(["nonprod", "staging", "prod", ENV_S, ENV_B]);
    expect(envs[ENV_S]).toMatchObject({ kind: "preview", clusters: ["EKS-Twizz-NonProd"], word: "DEPLOYED", tiers: [], monitor: null, preview: { service: "twizz-sentinel", url: `https://${ENV_S}.prv.twizz.com`, bundleKey12: KEY.slice(0, 12) } });
    expect(envs[ENV_S].observation).toMatchObject({ state: "observed", lastObserved: { job: "live", at: NOW.toISOString() } });
    expect(envs[ENV_B].word).toBe("RUNNING");
    expect(envs[ENV_B].stage.map((s) => [s.label, s.word])).toEqual([["build", "RUNNING"], ["rollout", "PLANNED"], ["preview smoke", "PLANNED"]]);
    expect(envs.nonprod.stage[0]).toMatchObject({ label: "preview", word: "RUNNING", detail: `bundle ${KEY.slice(0, 12)}: 1 of 2 preview envs up` });
    // Argo healthy on ANOTHER image is not "up": the env is rolling out, never DEPLOYED
    const lagging = withPreview({ envs: [env(ENV_S, SENTINEL, SHA_SENTINEL, { runsImage: false }), building] });
    expect(lagging[ENV_S].word).toBe("RUNNING");
    expect(lagging[ENV_S].stage[1]).toMatchObject({ label: "rollout", word: "RUNNING", detail: "Argo has not rolled the bundle image out yet" });
    // a failing check of this env's own service makes it FAIL
    const up = [env(ENV_S, SENTINEL, SHA_SENTINEL), env(ENV_B, BACKEND, SHA_BACKEND)];
    const failed = byName([plan(), cve(), source], { preview: buildPreview({ rows: [source, smokeSnap(req, "preview", KEY, [{ ok: false }], ago(12 * 60_000))], requests: [req], services: SERVICES, envs: up, promotions: [], staging, signoffs: [], envChanges: [], now: NOW }) });
    expect(failed[ENV_S].word).toBe("FAIL");
    expect(failed[ENV_S].headline).toBe("preview smoke: 0 of 1 check passed for twizz-sentinel: unexpected status");
    expect(failed.nonprod.stage[1]).toMatchObject({ label: "preview smoke", word: "FAIL" });
    // …and only it: the other env had no check in that run. That is not a failure of its own — and not "fine"
    // either: an env the smoke said nothing about is not verified, so it is never DEPLOYED on that run
    expect(failed[ENV_B].stage[2]).toEqual({ label: "preview smoke", word: "WATCH", detail: "the latest preview smoke had no check for moly-backend, so it is not verified" });
    expect(failed[ENV_B].word).toBe("WATCH");
    // a run whose checks all passed but which is not the answer to its request vouches for nothing
    const late = smokeSnap(req, "preview", KEY, [{ ok: true }], ago(12 * 60_000));
    const untrusted = byName([plan(), cve(), source], { preview: buildPreview({ rows: [source, { ...late, createdAt: ago(5 * 60_000) }], requests: [req], services: SERVICES, envs: up, promotions: [], staging, signoffs: [], envChanges: [], now: NOW }) });
    expect(untrusted[ENV_S].stage[2]).toMatchObject({ word: "FAIL", detail: "the result was received after the request had been completed" });
  });

  // second review round 2026-11-25, #7: what the preview rows said that was not so
  describe("a preview env is never shown better than what was verified of it", () => {
    const up = [env(ENV_S, SENTINEL, SHA_SENTINEL), env(ENV_B, BACKEND, SHA_BACKEND)];
    const targets = [
      { name: "twizz-sentinel", baseUrl: PREVIEW_SVC },
      { name: "moly-backend", baseUrl: "http://moly-backend.env-plo-2611-moly-backend.svc.cluster.local:3000" },
    ];
    const req = smokeRequest("preview", KEY, { status: "done", createdAt: ago(20 * 60_000), claimedAt: ago(15 * 60_000), finishedAt: ago(10 * 60_000), runId: "smoke-preview", params: { scope: "preview", bundleKey: KEY, targets } });
    const row = (name: string, base: string, ok: boolean, detail = ok ? "ok" : "unexpected status") => ({ name, url: name.includes("/") ? `${base}/health` : base, ok, status: ok ? 200 : null, ms: 12, detail });
    const smoked = (results: ReturnType<typeof row>[], envs = up, doc = {}, received = ago(12 * 60_000)) => {
      const s = snap("smoke", ago(12 * 60_000), { runId: "smoke-preview", requestId: req.id, smoke: { scope: "preview", bundleKey: KEY, results }, ...doc });
      return byName([plan(), cve(), source], { preview: buildPreview({ rows: [source, { ...s, createdAt: received }], requests: [req], services: SERVICES, envs, promotions: [], staging, signoffs: [], envChanges: [], now: NOW }) });
    };
    const both = [row("twizz-sentinel/health", targets[0].baseUrl, true), row("moly-backend/health", targets[1].baseUrl, true)];

    it("control: both services checked, both passed, requested after the rollout — PASS and DEPLOYED", () => {
      const envs = smoked(both);
      for (const name of [ENV_S, ENV_B]) {
        expect(envs[name].stage[2], name).toMatchObject({ label: "preview smoke", word: "PASS" });
        expect(envs[name], name).toMatchObject({ word: "DEPLOYED", observation: { state: "observed", word: "OK" } });
      }
      expect(envs.nonprod.stage[1]).toMatchObject({ label: "preview smoke", word: "PASS" });
    });

    it("a pass from before the env last rolled out is not shown as PASS — on the env, on nonprod or on the gate", () => {
      // rebuilt and rolled out five minutes ago; the smoke was requested twenty minutes ago
      const rebuilt = [env(ENV_S, SENTINEL, SHA_SENTINEL, { rolledOutAt: ago(5 * 60_000).toISOString() }), up[1]];
      const envs = smoked(both, rebuilt);
      expect(envs[ENV_S].stage[2]).toMatchObject({ word: "WATCH" });
      expect(envs[ENV_S].stage[2].detail).toMatch(/passed but are no longer evidence: plo-2611-twizz-sentinel rolled out at .* after the smoke was requested/);
      expect(envs[ENV_S].word).toBe("WATCH");
      // the env that did NOT roll out again keeps its own pass
      expect(envs[ENV_B].stage[2]).toMatchObject({ word: "PASS" });
      // the bundle-wide line on nonprod is the gate's: one stale env makes the whole pass stale
      expect(envs.nonprod.stage[1].word).toBe("WATCH");
      expect(envs.nonprod.stage[1].detail).toMatch(/no longer evidence/);
      // an unknown rollout time is not evidence either (fail closed)
      const undated = smoked(both, [env(ENV_S, SENTINEL, SHA_SENTINEL, { rolledOutAt: null }), up[1]]);
      expect(undated[ENV_S].stage[2]).toMatchObject({ word: "WATCH" });
      expect(undated[ENV_S].stage[2].detail).toMatch(/Argo does not say when/);
    });

    it("a result that is not the request's own gives no env a PASS, even with a failing row in it", () => {
      // received after the request was completed, one row failing, the other service's row green
      const mixed = [row("twizz-sentinel/health", targets[0].baseUrl, false), row("moly-backend/health", targets[1].baseUrl, true)];
      const late = smoked(mixed, up, {}, ago(5 * 60_000));
      expect(late[ENV_B].stage[2]).toEqual({ label: "preview smoke", word: "FAIL", detail: "the result was received after the request had been completed" });
      expect(late[ENV_B].word).toBe("FAIL");
      // a row nobody asked for (another host under a requested name) taints the whole result
      const foreign = [row("twizz-sentinel/health", targets[0].baseUrl, false), row("moly-backend/health", "http://redis.env-plo-2611-moly-backend.svc.cluster.local:6379", true)];
      expect(smoked(foreign)[ENV_B].stage[2]).toMatchObject({ word: "FAIL" });
      // control: the same failing run, bound to its request and with only requested rows, lets the other env keep its own pass
      expect(smoked(mixed)[ENV_B].stage[2]).toMatchObject({ word: "PASS" });
    });

    it("a target PLO refused or had no check for (a row named after the service itself) is FAIL, never DEPLOYED", () => {
      const refused = [row("twizz-sentinel/health", targets[0].baseUrl, true), row("moly-backend", targets[1].baseUrl, false, "not verified: no smoke checks are configured for this service in the inventory (repositories[].smoke)")];
      const envs = smoked(refused);
      expect(envs[ENV_B].stage[2]).toEqual({ label: "preview smoke", word: "FAIL", detail: "0 of 1 check passed for moly-backend: not verified: no smoke checks are configured for this service in the inventory (repositories[].smoke)" });
      expect(envs[ENV_B].word).toBe("FAIL");
      expect(envs[ENV_S].stage[2]).toMatchObject({ word: "PASS" });
      // a bare-name row that claims to be green is not a refusal: it is a row nobody asked for
      const greenBare = [row("twizz-sentinel/health", targets[0].baseUrl, false), row("moly-backend", targets[1].baseUrl, true)];
      expect(smoked(greenBare)[ENV_B].stage[2]).toMatchObject({ word: "FAIL" });
    });

    // pass 3 #2: the row is built by the REAL producer (`toPreviewEnv` over `argoStatusFor`/`argoWord`), not by hand
    it("pass 3 #2: what the reader really produces — Argo unreachable is 'read in part', a building env is not", () => {
      const manifest = (name: string, service: string, repo: string, sha: string, built: boolean): NamedEnvManifest => ({
        name,
        kind: "backend",
        service,
        owner: "nick",
        ...(built ? { imageTag: `nb-${name}-${sha.slice(0, 12)}` } : {}),
        expiresAt: new Date(NOW.getTime() + 48 * HOUR).toISOString(),
        db: { mode: "none", generation: 0 },
        frontendOrigins: [],
        source: { repo, ref: "plo/bundle/2026-11", sha },
        build: built ? { status: "PASS", expectedTag: "t", startedAt: ago(4 * HOUR).toISOString(), finishedAt: ago(4 * HOUR).toISOString() } : { status: "RUNNING", expectedTag: "t", startedAt: ago(60_000).toISOString() },
        config: { port: 8090, healthPath: "/health", rev: 1, envVarNames: [] },
      });
      // Argo cannot be reached: the deployable env's Application was asked for and not read
      const down = { reachable: false as const, reason: "connect ETIMEDOUT", apps: {} };
      const app = argoStatusFor(down, `env-${ENV_S}`);
      const unreachable = toPreviewEnv(manifest(ENV_S, "twizz-sentinel", SENTINEL, SHA_SENTINEL, true), false, argoWord(app).word, app);
      // a building env (named-envs/pending) has no Application to read yet: Argo is not asked about it
      const building = toPreviewEnv(manifest(ENV_B, "moly-backend", BACKEND, SHA_BACKEND, false), true, null);
      const envs = withPreview({ envs: [unreachable, building] });
      expect(envs[ENV_S].observation).toMatchObject({ state: "partial", word: "WATCH", reasons: ["Argo could not be read, so what this env runs is not known"] });
      expect(envs[ENV_S].stage[1]).toMatchObject({ label: "rollout", word: "UNKNOWN", detail: "Argo could not be read" });
      expect(envs[ENV_S].word).toBe("UNKNOWN");
      expect(observationLine(envs[ENV_S], NOW.getTime())).toBe("read in part: twizz-gitops was read, Argo could not be");
      expect(envs[ENV_B].observation).toMatchObject({ state: "observed", word: "OK", reasons: [] });
      expect(envs[ENV_B].stage[1]).toMatchObject({ label: "rollout", word: "PLANNED", detail: "waits for the build" });
      expect(observationLine(envs[ENV_B], NOW.getTime())).toBe("read live from twizz-gitops and Argo");
      // Argo answered and has no Application for the env yet: that was read (PENDING), not "could not be read"
      const none = argoStatusFor({ reachable: true, apps: {} }, `env-${ENV_S}`);
      const fresh = withPreview({ envs: [toPreviewEnv(manifest(ENV_S, "twizz-sentinel", SENTINEL, SHA_SENTINEL, true), false, argoWord(none).word, none)] });
      expect(fresh[ENV_S].observation).toMatchObject({ state: "observed" });
      expect(fresh[ENV_S].stage[1]).toMatchObject({ label: "rollout", word: "PENDING", detail: "Argo has not rolled the bundle image out yet" });
    });

    // pass 3 #6: `ok: false` on a smoke snapshot is PLO saying the JOB failed (aborted, refused, nothing ran)
    it("pass 3 #6: a smoke JOB that failed gives no env a PASS, whatever rows it got out before", () => {
      const partial = [row("twizz-sentinel/health", targets[0].baseUrl, true)];
      const aborted = smoked(partial, up, { ok: false, error: "smoke run failed: aborted" });
      expect(aborted[ENV_S].stage[2]).toEqual({ label: "preview smoke", word: "FAIL", detail: "the smoke run failed: smoke run failed: aborted" });
      expect(aborted[ENV_S].word).toBe("FAIL");
      expect(aborted[ENV_B].stage[2]).toMatchObject({ word: "FAIL" });
      expect(aborted.nonprod.stage[1]).toMatchObject({ label: "preview smoke", word: "FAIL" });
      // control: a job that RAN (ok: true) with one failing check keeps the other service's own pass
      expect(smoked([row("twizz-sentinel/health", targets[0].baseUrl, true), row("moly-backend/health", targets[1].baseUrl, false)])[ENV_S].stage[2]).toMatchObject({ word: "PASS" });
    });

    it("Argo unreachable: the env is read in part and UNKNOWN, not observed", () => {
      const blind = smoked(both, [env(ENV_S, SENTINEL, SHA_SENTINEL, { argo: "UNKNOWN", argoUnread: true, runsImage: false, rolledOutAt: null }), up[1]]);
      expect(blind[ENV_S].observation).toMatchObject({ state: "partial", word: "WATCH", reasons: ["Argo could not be read, so what this env runs is not known"] });
      expect(blind[ENV_S].stage[1]).toMatchObject({ label: "rollout", word: "UNKNOWN", detail: "Argo could not be read" });
      // and with no rollout time its smoke is not evidence either: nothing about it reads as up
      expect(["UNKNOWN", "WATCH"]).toContain(blind[ENV_S].word);
      expect(blind[ENV_S].headline).not.toMatch(/^up:/);
      expect(blind[ENV_B].observation).toMatchObject({ state: "observed", word: "OK" });
    });
  });

  it("the sign-off is the human gate, and it is the only place Ember's word appears for the bundle", () => {
    const signed = withPreview({ signoffs: [{ bundleKey: KEY, actor: "nick", at: ago(HOUR) }] });
    expect(signed.prod.stage).toEqual([{ label: "sign-off", word: "PASS", detail: `bundle ${KEY.slice(0, 12)} signed off by nick; merging the bundled pull requests is a human action in GitHub` }]);
    for (const e of Object.values(withPreview())) for (const s of e.stage) expect(s.word, `${e.name}/${s.label}`).not.toBe("AWAITING HUMAN");
  });

  it("a bundle state that could not be read is said, per environment and in the notes — never an empty list", () => {
    const view = build([plan(), cve()], { preview: null, previewError: "GitHub: bad credentials" });
    expect(view.notes).toEqual(["preview environments could not be read: GitHub: bad credentials"]);
    expect(view.environments[0].stage).toEqual([{ label: "bundle", word: "UNKNOWN", detail: "the bundle state could not be read: GitHub: bad credentials" }]);
    // what could not be read is UNKNOWN for the environment it concerns — never "no preview env", never "0 of 1 deployed"
    const blind = byName([plan(), cve(), source], { preview: previewOf({ envs: null, staging: [{ ...staging[0], currentTag: null, error: "GitHub 502" }] }), previewEnvsRead: false });
    expect(blind.nonprod.stage[0]).toMatchObject({ label: "preview", word: "UNKNOWN" });
    expect(blind.staging.stage[0]).toEqual({ label: "bundle", word: "UNKNOWN", detail: `bundle ${KEY.slice(0, 12)}: staging state could not be read for twizz-sentinel (GitHub 502)` });
    // the named-env manifests could not be read: buildPreview says so, and so does the pane
    const unread = build([plan(), cve(), source], { preview: previewOf({ envs: null, sourceErrors: ["named envs could not be read: 502"] }) });
    expect(unread.notes).toContain("named envs could not be read: 502");
  });
});
