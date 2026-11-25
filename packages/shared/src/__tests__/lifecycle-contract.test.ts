// The contract with PLO, pinned as files (docs/NEBULA.md §N9 "Keeping the two schemas identical").
//
// fixtures/lifecycle-contract/ holds one full-featured snapshot per job, built by PLO's own
// `buildSnapshot`, plus the shared vocabulary and the request shapes. THE SAME FILES, byte for
// byte, live in the PLO repo under test/fixtures/contract/, where test/contract.test.ts fails
// as soon as PLO's builder stops producing them.
//
// This side proves the dashboard's schema accepts exactly what PLO sends: every file parses
// and nothing is stripped (a stripped key = a field PLO sends that Nebula silently drops).
//
// To change the contract: change both schemas, regenerate in PLO
// (`UPDATE_CONTRACT_FIXTURES=1 npx vitest run test/contract.test.ts`), copy the *.json files
// here, run both suites. Never edit these files by hand.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LIFECYCLE_AUTONOMY,
  LIFECYCLE_BUMPS,
  LIFECYCLE_BUNDLE_KEY_RE,
  LIFECYCLE_COMPONENT_STATUSES,
  LIFECYCLE_COVERAGE_STATES,
  LIFECYCLE_ENVIRONMENTS,
  LIFECYCLE_JOBS,
  LIFECYCLE_LIMITS,
  LIFECYCLE_MAX_SMOKE_TARGETS,
  LIFECYCLE_REQUEST_KINDS,
  LIFECYCLE_RUN_ID_RE,
  LIFECYCLE_SCHEMA_VERSION,
  LIFECYCLE_SEVERITIES,
  LIFECYCLE_SMOKE_SCOPES,
  LIFECYCLE_TIERS,
  LifecycleAdvisory,
  LifecycleCompleteBody,
  LifecycleComponent,
  LifecycleScheduleEntry,
  LifecycleSnapshotDoc,
  isLifecycleRequestKind,
  parseLifecycleRequestParams,
} from "../lifecycle";

const DIR = join(__dirname, "fixtures", "lifecycle-contract");
const read = (name: string) => JSON.parse(readFileSync(join(DIR, name), "utf8"));
const SNAPSHOTS = ["snapshot-plan.json", "snapshot-source.json", "snapshot-cve.json", "snapshot-smoke.json", "snapshot-failed.json"];

describe("PLO contract fixtures", () => {
  it("the fixture set is the one PLO generates", () => {
    expect(readdirSync(DIR).sort()).toEqual([...SNAPSHOTS, "requests.json", "vocabulary.json"].sort());
  });

  it.each(SNAPSHOTS)("%s parses and nothing is stripped or coerced", (name) => {
    const raw = read(name);
    expect(LifecycleSnapshotDoc.parse(raw)).toEqual(raw);
  });

  it("one snapshot per job, each carrying its job's data", () => {
    const [plan, source, cve, smoke, failed] = SNAPSHOTS.map((n) => LifecycleSnapshotDoc.parse(read(n)));
    expect([plan.job, source.job, cve.job, smoke.job]).toEqual([...LIFECYCLE_JOBS]);
    expect(new Set(plan.components!.map((c) => c.tier))).toEqual(new Set(LIFECYCLE_TIERS));
    expect(source.bundles!.length).toBeGreaterThan(1);
    expect(source.bundleKey).toMatch(LIFECYCLE_BUNDLE_KEY_RE);
    expect(source.components!.some((c) => c.pr)).toBe(true);
    expect(cve.advisories!.some((a) => a.kev)).toBe(true);
    expect(smoke.smoke!.bundleKey).toBe(source.bundleKey);
    expect(smoke.smoke!.results.some((r) => r.status === null)).toBe(true);
    // coverage: every inventory environment, every state, and a source run speaks for the repository tiers only
    expect(plan.coverage!.map((e) => e.environment).sort()).toEqual(LIFECYCLE_ENVIRONMENTS.map((e) => e.name).sort());
    expect(new Set(plan.coverage!.flatMap((e) => e.tiers.map((t) => t.state)))).toEqual(new Set(LIFECYCLE_COVERAGE_STATES));
    expect(source.coverage!.every((e) => e.tiers.every((t) => ["base-images", "npm-direct", "npm-transitive"].includes(t.tier)))).toBe(true);
    expect(cve.coverage).toBeUndefined();
    // a whole snapshot carries exactly the rows its coverage counts, per environment and tier — the dashboard
    // reads "fewer rows than counted" as rows left out on the way (lifecycle-environments.ts tierCoverage)
    for (const s of [plan, source]) {
      for (const e of s.coverage!) {
        for (const t of e.tiers) expect([s.job, e.environment, t.tier, s.components!.filter((c) => c.tier === t.tier && c.environments.includes(e.environment)).length]).toEqual([s.job, e.environment, t.tier, t.components]);
      }
    }
    expect(failed.ok).toBe(false);
    expect(failed.error).toBeTruthy();
  });

  it("the closed vocabularies, limits and key sets are the same on both sides", () => {
    const v = read("vocabulary.json");
    expect(v).toEqual({
      schemaVersion: LIFECYCLE_SCHEMA_VERSION,
      limits: { ...LIFECYCLE_LIMITS, smokeTargets: LIFECYCLE_MAX_SMOKE_TARGETS },
      runIdPattern: LIFECYCLE_RUN_ID_RE.source,
      bundleKeyExample: v.bundleKeyExample,
      jobs: [...LIFECYCLE_JOBS],
      tiers: [...LIFECYCLE_TIERS],
      componentStatuses: [...LIFECYCLE_COMPONENT_STATUSES],
      bumps: [...LIFECYCLE_BUMPS],
      autonomy: [...LIFECYCLE_AUTONOMY],
      rollback: [...LifecycleComponent.shape.rollback.options],
      severities: [...LIFECYCLE_SEVERITIES],
      advisorySources: [...LifecycleAdvisory.shape.source.options],
      smokeScopes: [...LIFECYCLE_SMOKE_SCOPES],
      scheduleRunners: [...LifecycleScheduleEntry.shape.runner.options],
      requestKinds: [...LIFECYCLE_REQUEST_KINDS],
      snapshotKeys: Object.keys(LifecycleSnapshotDoc.shape).sort(),
      componentKeys: Object.keys(LifecycleComponent.shape).sort(),
      coverageStates: [...LIFECYCLE_COVERAGE_STATES],
      environments: LIFECYCLE_ENVIRONMENTS.map((e) => ({ name: e.name, clusters: [...e.clusters] })),
    });
    expect(v.bundleKeyExample).toMatch(LIFECYCLE_BUNDLE_KEY_RE);
  });

  it("requests: what Nebula may hand out is what PLO accepts, and what PLO refuses Nebula never queues", () => {
    const r = read("requests.json") as { claimed: Array<{ id: string; kind: string; params: unknown }>; refused: Array<{ id: string; kind: string; params: unknown }>; complete: unknown[] };
    for (const c of r.claimed) {
      expect(isLifecycleRequestKind(c.kind), c.id).toBe(true);
      expect(parseLifecycleRequestParams(c.kind as "plan", c.params), c.id).toEqual(c.params);
    }
    for (const c of r.refused) expect(() => parseLifecycleRequestParams(c.kind as "plan", c.params), c.id).toThrow();
    for (const body of r.complete) expect(LifecycleCompleteBody.parse(body)).toEqual(body);
  });
});
