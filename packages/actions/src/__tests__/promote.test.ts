import { describe, expect, it } from "vitest";
import {
  PROMOTABLE_TAG_RE,
  bumpImageTag,
  isPromotableTag,
  listPromotions,
  listReleaseCandidates,
  mergePromotion,
  parsePromotionBranch,
  promoteRelease,
  promotionBranch,
  readImageTag,
  readTargetState,
} from "../promote";
import { PROMOTABLE_NAMES, releaseTarget } from "../registry";
import { FakeEcr, FakePromotions } from "./fakes";

const SHA = "86ab429fd1d318ae234e9627c152edb6f3600325";
const MAIN_TAG = `main-${SHA}`;
const PR_TAG = `pr-12-${SHA}`;
const VALUES = `# Staging values for twizz-sentinel (docs/NEBULA.md §N4). Nebula bumps image.tag by PR.
nameOverride: twizz-sentinel

image:
  repository: 848281935985.dkr.ecr.eu-west-1.amazonaws.com/twizz-sentinel
  tag: main-0000000000000000000000000000000000000000 # promoted by Nebula
  pullPolicy: IfNotPresent

env:
  SENTINEL_ACTIONS_ENABLED: "false" # flip only once the WAF IP set exists
`;

function deps(over: { images?: Record<string, Array<{ tags: string[]; pushedAt: Date | undefined; digest: string | undefined }>> } = {}) {
  const promotions = new FakePromotions();
  promotions.main.set("apps/twizz-sentinel/values-staging.yaml", VALUES);
  promotions.main.set("apps/twizz-admin/values-staging.yaml", VALUES.replace(/twizz-sentinel/g, "twizz-admin"));
  const images = new FakeEcr(
    over.images ?? {
      "twizz-sentinel": [
        { tags: [MAIN_TAG, "main"], pushedAt: new Date("2026-09-05T06:09:40Z"), digest: "sha256:aaa" },
        { tags: [PR_TAG], pushedAt: new Date("2026-09-20T10:00:00Z"), digest: "sha256:bbb" },
        { tags: ["nb-sentinel-smoke-86ab429fd1d3"], pushedAt: new Date("2026-09-11T11:25:32Z"), digest: "sha256:ccc" },
        { tags: ["dev"], pushedAt: new Date("2026-09-01T00:00:00Z"), digest: "sha256:ddd" },
        // what staging is on right now (see VALUES)
        { tags: ["main-0000000000000000000000000000000000000000"], pushedAt: new Date("2026-08-01T00:00:00Z"), digest: "sha256:000" },
      ],
      "twizz-admin": [{ tags: [`pr-139-${SHA}`], pushedAt: new Date("2026-09-03T12:44:21Z"), digest: "sha256:eee" }],
    },
  );
  return { images, promotions };
}

describe("registry: release train", () => {
  it("only sentinel + admin are promotable, and only to staging", () => {
    expect(PROMOTABLE_NAMES.sort()).toEqual(["twizz-admin", "twizz-sentinel"]);
    expect(releaseTarget("twizz-sentinel", "staging")).toMatchObject({ cluster: "EKS-Moly-staging", namespace: "sentinel", valuesFile: "apps/twizz-sentinel/values-staging.yaml", argoApp: "staging-twizz-sentinel", host: "sentinel.stg.prv.twizz.com" });
    expect(releaseTarget("twizz-admin", "staging")?.host).toBe("admin.stg.prv.twizz.com");
    expect(releaseTarget("moly-backend", "staging")).toBeUndefined();
  });
});

describe("tags + branches", () => {
  it("accepts immutable tags and refuses aliases", () => {
    for (const t of [MAIN_TAG, PR_TAG, "nb-sentinel-smoke-86ab429fd1d3", "build-75b95f51-a1de-432d-8132-33a2802f622c"]) expect(isPromotableTag(t)).toBe(true);
    for (const t of ["main", "latest", "dev", "staging", "prod", "main-abc", "pr-12-abc", "v1.2.3"]) expect(isPromotableTag(t)).toBe(false);
    expect(PROMOTABLE_TAG_RE.test("main-" + SHA.slice(0, 39))).toBe(false);
  });
  it("branch names round-trip and carry the whole tag", () => {
    const b = promotionBranch("twizz-sentinel", "staging", MAIN_TAG);
    expect(b).toBe(`promote/twizz-sentinel/staging/${MAIN_TAG}`);
    expect(parsePromotionBranch(b)).toEqual({ service: "twizz-sentinel", target: "staging", tag: MAIN_TAG });
    expect(parsePromotionBranch("promote/twizz-sentinel/prod/" + MAIN_TAG)).toBeNull();
    expect(parsePromotionBranch("promote/twizz-sentinel/staging/latest")).toBeNull();
    expect(parsePromotionBranch("nebula/some-env")).toBeNull();
    expect(parsePromotionBranch("promote/a/b/c/d")).toBeNull();
  });
});

describe("values surgery", () => {
  it("reads and bumps image.tag while keeping comments and the rest", () => {
    expect(readImageTag(VALUES)).toBe("main-0000000000000000000000000000000000000000");
    const out = bumpImageTag(VALUES, MAIN_TAG);
    expect(readImageTag(out)).toBe(MAIN_TAG);
    expect(out).toContain("# Staging values for twizz-sentinel");
    expect(out).toContain("# promoted by Nebula");
    expect(out).toContain('SENTINEL_ACTIONS_ENABLED: "false" # flip only once the WAF IP set exists');
    expect(out).toContain("repository: 848281935985.dkr.ecr.eu-west-1.amazonaws.com/twizz-sentinel");
    // exactly one line changed
    const a = VALUES.split("\n");
    const b = out.split("\n");
    expect(b.length).toBe(a.length);
    expect(a.filter((l, i) => l !== b[i])).toEqual(["  tag: main-0000000000000000000000000000000000000000 # promoted by Nebula"]);
  });
  it("refuses a file without an image map or with broken YAML", () => {
    expect(() => bumpImageTag("replicaCount: 2\n", MAIN_TAG)).toThrow(/no `image:` map/);
    expect(() => bumpImageTag("image: [\n", MAIN_TAG)).toThrow(/not valid YAML/);
  });
});

describe("listReleaseCandidates", () => {
  it("lists immutable tags newest first with their aliases; alias-only images are dropped", async () => {
    const list = await listReleaseCandidates(deps(), "twizz-sentinel");
    expect(list.map((c) => c.tag)).toEqual([PR_TAG, "nb-sentinel-smoke-86ab429fd1d3", MAIN_TAG, "main-0000000000000000000000000000000000000000"]);
    expect(list[2]).toMatchObject({ kind: "main", aliases: ["main"], pushedAt: "2026-09-05T06:09:40.000Z" });
    expect(list[0].kind).toBe("pr");
    expect(list[1].kind).toBe("nebula");
  });
  it("refuses a service that is not on the train", async () => {
    await expect(listReleaseCandidates(deps(), "moly-backend")).rejects.toThrow(/not on the release train/);
  });
});

describe("promoteRelease", () => {
  it("opens ONE PR that bumps only image.tag, with a body naming from/to/app/host/actor", async () => {
    const d = deps();
    const r = await promoteRelease(d, { service: "twizz-sentinel", target: "staging", imageTag: MAIN_TAG, actor: "nick" });
    expect(r).toMatchObject({ service: "twizz-sentinel", target: "staging", from: "main-0000000000000000000000000000000000000000", to: MAIN_TAG, existing: false, argoApp: "staging-twizz-sentinel", host: "sentinel.stg.prv.twizz.com", branch: `promote/twizz-sentinel/staging/${MAIN_TAG}` });
    expect(r.image).toEqual({ tag: MAIN_TAG, aliases: ["main"], pushedAt: "2026-09-05T06:09:40.000Z" });
    expect(d.promotions.prs).toHaveLength(1);
    const pr = d.promotions.prs[0];
    expect(pr.title).toBe(`promote(twizz-sentinel): staging → ${MAIN_TAG}`);
    expect(Object.keys(pr.files)).toEqual(["apps/twizz-sentinel/values-staging.yaml"]);
    expect(readImageTag(pr.files["apps/twizz-sentinel/values-staging.yaml"])).toBe(MAIN_TAG);
    expect(pr.body).toContain("staging-twizz-sentinel");
    expect(pr.body).toContain("https://sentinel.stg.prv.twizz.com");
    expect(pr.body).toContain("Requested by: nick");
    expect(pr.body).toContain("Replaces: `main-0000000000000000000000000000000000000000`");
    // main is untouched until the merge
    expect(readImageTag(d.promotions.main.get("apps/twizz-sentinel/values-staging.yaml")!)).toBe("main-0000000000000000000000000000000000000000");
  });

  it("is idempotent: the same promotion twice returns the existing PR without a second commit", async () => {
    const d = deps();
    const a = await promoteRelease(d, { service: "twizz-sentinel", target: "staging", imageTag: MAIN_TAG, actor: "nick" });
    const b = await promoteRelease(d, { service: "twizz-sentinel", target: "staging", imageTag: MAIN_TAG, actor: "igor" });
    expect(b.prNumber).toBe(a.prNumber);
    expect(b.existing).toBe(true);
    expect(d.promotions.prs).toHaveLength(1);
  });

  it("refuses aliases, unknown images, an unpromotable service, the current tag, and a missing target file", async () => {
    const d = deps();
    await expect(promoteRelease(d, { service: "twizz-sentinel", target: "staging", imageTag: "main", actor: "n" })).rejects.toThrow(/not an immutable image tag/);
    await expect(promoteRelease(d, { service: "twizz-sentinel", target: "staging", imageTag: `main-${"f".repeat(40)}`, actor: "n" })).rejects.toThrow(/does not exist/);
    await expect(promoteRelease(d, { service: "moly-backend", target: "staging", imageTag: MAIN_TAG, actor: "n" })).rejects.toThrow(/no staging target/);
    await expect(promoteRelease(d, { service: "twizz-sentinel", target: "staging", imageTag: "main-0000000000000000000000000000000000000000", actor: "n" })).rejects.toThrow(/already on/);
    d.promotions.main.delete("apps/twizz-admin/values-staging.yaml");
    await expect(promoteRelease(d, { service: "twizz-admin", target: "staging", imageTag: `pr-139-${SHA}`, actor: "n" })).rejects.toThrow(/not bootstrapped/);
    expect(d.promotions.prs).toHaveLength(0);
  });
});

describe("listPromotions + mergePromotion", () => {
  it("lists open promotion PRs parsed from their branches and ignores other PRs", async () => {
    const d = deps();
    await promoteRelease(d, { service: "twizz-sentinel", target: "staging", imageTag: MAIN_TAG, actor: "nick" });
    await d.promotions.openPr({ branch: "chore/unrelated", files: { "README.md": "x" }, title: "chore", body: "" });
    const list = await listPromotions(d);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ service: "twizz-sentinel", target: "staging", imageTag: MAIN_TAG, argoApp: "staging-twizz-sentinel", host: "sentinel.stg.prv.twizz.com", state: "open" });
  });

  it("merges the PR pinned to its head sha and main then carries the new tag", async () => {
    const d = deps();
    const p = await promoteRelease(d, { service: "twizz-sentinel", target: "staging", imageTag: MAIN_TAG, actor: "nick" });
    const m = await mergePromotion(d, { prNumber: p.prNumber, service: "twizz-sentinel", target: "staging", imageTag: MAIN_TAG, actor: "nick" });
    expect(m).toMatchObject({ prNumber: p.prNumber, service: "twizz-sentinel", target: "staging", imageTag: MAIN_TAG, argoApp: "staging-twizz-sentinel" });
    expect(d.promotions.merged[0].sha).toBe(m.mergedSha);
    expect(d.promotions.merged[0].title).toBe(`promote(twizz-sentinel): staging → ${MAIN_TAG} (#${p.prNumber})`);
    expect((await readTargetState(d, "twizz-sentinel", "staging")).imageTag).toBe(MAIN_TAG);
    expect(await listPromotions(d)).toEqual([]);
  });

  it("refuses when the confirmed fields do not match the PR, when the PR is not open, or does not exist", async () => {
    const d = deps();
    const p = await promoteRelease(d, { service: "twizz-sentinel", target: "staging", imageTag: MAIN_TAG, actor: "nick" });
    await expect(mergePromotion(d, { prNumber: p.prNumber, service: "twizz-sentinel", target: "staging", imageTag: PR_TAG, actor: "n" })).rejects.toThrow(/promotes twizz-sentinel staging/);
    await expect(mergePromotion(d, { prNumber: p.prNumber, service: "twizz-admin", target: "staging", imageTag: MAIN_TAG, actor: "n" })).rejects.toThrow(/promotes twizz-sentinel/);
    await expect(mergePromotion(d, { prNumber: 999, service: "twizz-sentinel", target: "staging", imageTag: MAIN_TAG, actor: "n" })).rejects.toThrow(/does not exist/);
    await mergePromotion(d, { prNumber: p.prNumber, service: "twizz-sentinel", target: "staging", imageTag: MAIN_TAG, actor: "n" });
    await expect(mergePromotion(d, { prNumber: p.prNumber, service: "twizz-sentinel", target: "staging", imageTag: MAIN_TAG, actor: "n" })).rejects.toThrow(/is merged/);
    expect(d.promotions.merged).toHaveLength(1);
  });

  it("refuses a non-promotion PR even when the number is right", async () => {
    const d = deps();
    const pr = await d.promotions.openPr({ branch: "chore/unrelated", files: { "README.md": "x" }, title: "chore", body: "" });
    await expect(mergePromotion(d, { prNumber: pr.number, service: "twizz-sentinel", target: "staging", imageTag: MAIN_TAG, actor: "n" })).rejects.toThrow(/not a promotion PR/);
  });
});
