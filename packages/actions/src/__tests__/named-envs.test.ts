import { describe, expect, it } from "vitest";
import {
  ALIAS_TAGS,
  IMAGE_TAG_RE,
  envSecretName,
  nebulaTag,
  resolveService,
  normalizeOrigins,
  DEFAULT_MAX_NAMED_ENVS,
  deriveEnvSecret,
  expiresAtFrom,
  isValidImageTag,
  isValidName,
  manifestToYaml,
  parseManifest,
  rewriteMongoDb,
  toLabelValue,
  type NamedEnvManifest,
} from "../named-envs";

const TAG = "build-75b95f51-a1de-432d-8132-33a2802f622c";

describe("rewriteMongoDb", () => {
  it("rewrites the db path of a mongodb+srv URI and keeps the query string", () => {
    expect(rewriteMongoDb("mongodb+srv://user:p%40ss@nonprod-twizz.tjeemu.mongodb.net/moly?retryWrites=true&w=majority", "nebula_smoke")).toBe(
      "mongodb+srv://user:p%40ss@nonprod-twizz.tjeemu.mongodb.net/nebula_smoke?retryWrites=true&w=majority",
    );
  });
  it("rewrites a plain mongodb:// URI with a host list", () => {
    expect(rewriteMongoDb("mongodb://u:p@h1:27017,h2:27017/moly", "nebula_x")).toBe("mongodb://u:p@h1:27017,h2:27017/nebula_x");
  });
  it("inserts a db when the URI has no path", () => {
    expect(rewriteMongoDb("mongodb+srv://u:p@host", "nebula_x")).toBe("mongodb+srv://u:p@host/nebula_x");
    expect(rewriteMongoDb("mongodb+srv://u:p@host/?authSource=admin", "nebula_x")).toBe("mongodb+srv://u:p@host/nebula_x?authSource=admin");
  });
  it("rejects non-mongo URIs", () => {
    expect(() => rewriteMongoDb("postgres://x/y", "z")).toThrow();
  });
});

describe("validation", () => {
  it("accepts DNS-label names and rejects the rest", () => {
    expect(isValidName("smoke")).toBe(true);
    expect(isValidName("rel-2026-09")).toBe(true);
    expect(isValidName("Smoke")).toBe(false);
    expect(isValidName("1abc")).toBe(false);
    expect(isValidName("ab")).toBe(false);
    expect(isValidName("a".repeat(25))).toBe(false);
    expect(isValidName("has_underscore")).toBe(false);
  });
  it("accepts immutable build-* tags only", () => {
    expect(isValidImageTag(TAG)).toBe(true);
    for (const alias of ALIAS_TAGS) expect(isValidImageTag(alias)).toBe(false);
    expect(isValidImageTag("build-short")).toBe(false);
    expect(isValidImageTag("pr-12-abc")).toBe(false);
    expect(isValidImageTag("sha-deadbeef")).toBe(false);
  });
  it("makes any actor string a valid k8s label value", () => {
    expect(toLabelValue("local:root")).toBe("local-root");
    expect(toLabelValue("nick@twizz.com")).toBe("nick-twizz.com");
    expect(toLabelValue("---")).toBe("unknown");
    expect(toLabelValue("x".repeat(80)).length).toBe(63);
  });
});

describe("manifest round-trip", () => {
  const m: NamedEnvManifest = {
    name: "smoke",
    service: "moly-backend",
    owner: "nick",
    imageTag: TAG,
    expiresAt: "2026-09-14T00:00:00.000Z",
    db: { mode: "clone", generation: 2 },
    kind: "backend",
    frontendOrigins: ["https://smoke-frontend.prv.twizz.com", "https://smoke-business.prv.twizz.com"],
  };
  it("serialises in schema order (v2: kind + frontendOrigins list) and parses back identically", () => {
    const yaml = manifestToYaml(m);
    expect(yaml.split("\n").slice(0, 2)).toEqual(["name: smoke", "kind: backend"]);
    expect(yaml).toContain("expiresAt: \"2026-09-14T00:00:00.000Z\"");
    expect(yaml).toContain("frontendOrigins:\n  - https://smoke-frontend.prv.twizz.com\n  - https://smoke-business.prv.twizz.com");
    expect(parseManifest(yaml)).toEqual(m);
  });
  it("reads a v1 manifest (no kind, single frontendOrigin) as backend with a one-element list", () => {
    const v1 = manifestToYaml(m).replace("kind: backend\n", "").replace(/frontendOrigins:[\s\S]*$/, "frontendOrigin: https://smoke-frontend.prv.twizz.com\n");
    expect(parseManifest(v1)).toEqual({ ...m, frontendOrigins: ["https://smoke-frontend.prv.twizz.com"] });
    expect(parseManifest(manifestToYaml(m).replace(/frontendOrigins:[\s\S]*$/, "frontendOrigin: \"\"\n")).frontendOrigins).toEqual([]);
  });
  it("rejects an unknown kind (worker is valid since v3)", () => {
    expect(() => parseManifest(manifestToYaml(m).replace("kind: backend", "kind: sidecar"))).toThrow(/kind/);
    expect(parseManifest(manifestToYaml(m).replace("kind: backend", "kind: worker")).kind).toBe("worker");
  });
  it("parses the hand-written smoke manifest shape (comments, unquoted values)", () => {
    const hand = `# comment
name: smoke
service: moly-backend
owner: nick
imageTag: ${TAG}   # = :prod
expiresAt: "2026-09-14T00:00:00Z"
db:
  mode: clone
  generation: 1
frontendOrigin: https://smoke-frontend.prv.twizz.com
`;
    expect(parseManifest(hand)).toEqual({ ...m, expiresAt: "2026-09-14T00:00:00Z", db: { mode: "clone", generation: 1 }, frontendOrigins: ["https://smoke-frontend.prv.twizz.com"] });
  });
  it("rejects bad manifests loudly", () => {
    expect(() => parseManifest("name: Bad\nservice: moly-backend\n")).toThrow(/invalid name/);
    expect(() => parseManifest(manifestToYaml(m).replace("moly-backend", "Nope_Service"))).toThrow(/invalid service/);
    expect(() => parseManifest(manifestToYaml(m).replace("mode: clone", "mode: shared"))).toThrow(/db.mode/);
    expect(() => parseManifest(manifestToYaml(m).replace("generation: 2", "generation: -1"))).toThrow(/generation/);
    expect(() => parseManifest(manifestToYaml(m).replace(/imageTag: .*\n/, ""))).toThrow(/imageTag/);
  });
});

describe("manifest v3 (build-on-provision)", () => {
  const v3: NamedEnvManifest = {
    name: "sentinel-nebula-test",
    kind: "backend",
    service: "twizz-sentinel",
    owner: "rohitagrohia",
    expiresAt: "2026-09-17T12:00:00.000Z",
    db: { mode: "none", generation: 0 },
    frontendOrigins: [],
    source: { repo: "twizz-app/twizz-sentinel", ref: "nebula-test", sha: "a".repeat(40), prNumber: 12, prUrl: "https://github.com/twizz-app/twizz-sentinel/pull/12" },
    build: { status: "PENDING", expectedTag: "nb-sentinel-nebula-test-aaaaaaaaaaaa", startedAt: "2026-09-10T12:00:00.000Z" },
    config: { port: 8090, healthPath: "/health", rev: 1, envVarNames: ["LOG_LEVEL"] },
  };
  it("round-trips every v3 key, quotes timestamps, and tolerates a missing imageTag while pending", () => {
    const y = manifestToYaml(v3);
    expect(y).not.toContain("imageTag");
    expect(y).toContain('startedAt: "2026-09-10T12:00:00.000Z"');
    expect(y).toContain("prNumber: 12");
    expect(parseManifest(y, { where: "pending" })).toEqual(v3);
    expect(() => parseManifest(y)).toThrow(/imageTag/);
  });
  it("keeps v3 keys through a promote (imageTag + PASS) and drops nothing on re-serialisation", () => {
    const promoted: NamedEnvManifest = { ...v3, imageTag: v3.build!.expectedTag, build: { ...v3.build!, status: "PASS", finishedAt: "2026-09-10T12:05:00.000Z", runId: 42, runUrl: "https://x/42" } };
    const back = parseManifest(manifestToYaml(promoted));
    expect(back).toEqual(promoted);
    expect(manifestToYaml(back)).toBe(manifestToYaml(promoted));
  });
  it("ignores unknown keys and rejects a PASS without imageTag even in pending", () => {
    const y = manifestToYaml(v3) + "somethingNew: 1\n";
    expect(parseManifest(y, { where: "pending" }).name).toBe(v3.name);
    const passed = manifestToYaml({ ...v3, build: { ...v3.build!, status: "PASS" } });
    expect(() => parseManifest(passed, { where: "pending" })).toThrow(/imageTag/);
  });
  it("validates image tags for both schemes and derives the builder tag", () => {
    expect(IMAGE_TAG_RE.test("nb-sentinel-nebula-test-aaaaaaaaaaaa")).toBe(true);
    expect(IMAGE_TAG_RE.test(nebulaTag("biz-feat-x", "0123456789abcdef0123"))).toBe(true);
    expect(IMAGE_TAG_RE.test("nb-x-latest")).toBe(false);
    expect(IMAGE_TAG_RE.test("nb-1bad-aaaaaaaaaaaa")).toBe(false);
    expect(isValidImageTag("nb-smoke-aaaaaaaaaaaa")).toBe(true);
  });
  it("resolves services: registry by repo (moly keeps its ECR + boot path), else the repo slug; reserved names refused", () => {
    expect(resolveService("twizz-app/Moly-backend")).toMatchObject({ service: "moly-backend", ecrRepo: "molybackend", legacyBoot: true, kind: "backend" });
    expect(resolveService("twizz-app/twizz-sentinel")).toMatchObject({ service: "twizz-sentinel", ecrRepo: "twizz-sentinel", legacyBoot: false });
    expect(resolveService("twizz-app/Some_New.Repo")).toMatchObject({ service: "some-new-repo", ecrRepo: "some-new-repo" });
    expect(() => resolveService("twizz-app/nebula")).toThrow(/reserved|valid/);
    expect(() => resolveService("twizz-app/kube-proxy")).toThrow();
    expect(envSecretName("twizz-sentinel", "x")).toBe("preview/twizz-sentinel/x");
    expect(envSecretName("moly-backend", "x")).toBe("preview/moly-backend/x");
  });
});

describe("expiresAtFrom", () => {
  it("adds ttlHours and formats RFC3339 UTC", () => {
    expect(expiresAtFrom(new Date("2026-09-07T12:00:00Z"), 168)).toBe("2026-09-14T12:00:00.000Z");
    expect(expiresAtFrom(new Date("2026-09-07T12:00:00Z"), 1)).toBe("2026-09-07T13:00:00.000Z");
  });
});

describe("deriveEnvSecret", () => {
  const base = {
    MONGO_URI: "mongodb+srv://u:p@host/moly?retryWrites=true",
    SHIFT_FOUR_MONGO_URI: "mongodb+srv://u:p@host/moly",
    BUSINESS_URL: "https://stg.twizz.com",
    TOKEN_SECRET: "old",
    REDIS_HOST: "staging-redis.internal",
    REDIS_PASSWORD: "hunter2",
    STRIPE_SECRET_KEY: "sk_test",
  };
  it("rewrites both Mongo URIs, frontend, token and Redis; leaves everything else", () => {
    const out = deriveEnvSecret(base, { name: "smoke", frontendOrigin: "https://smoke-frontend.prv.twizz.com", tokenSecret: "fresh" });
    expect(out.MONGO_URI).toBe("mongodb+srv://u:p@host/nebula_smoke?retryWrites=true");
    expect(out.SHIFT_FOUR_MONGO_URI).toBe("mongodb+srv://u:p@host/nebula_smoke");
    expect(out.BUSINESS_URL).toBe("https://smoke-frontend.prv.twizz.com");
    expect(out.TOKEN_SECRET).toBe("fresh");
    expect(out.TOKEN_SECRET).not.toBe(base.TOKEN_SECRET);
    expect(out.REDIS_HOST).toBe("redis");
    expect(out.REDIS_PASSWORD).toBe("");
    expect(out.STRIPE_SECRET_KEY).toBe("sk_test");
    expect(Object.keys(out).sort()).toEqual(Object.keys(base).sort());
    expect(base.MONGO_URI).toContain("/moly"); // input untouched
  });
  it("does not invent URIs that the base blob lacks", () => {
    const out = deriveEnvSecret({ MONGO_URI: base.MONGO_URI }, { name: "x", frontendOrigin: "https://x", tokenSecret: "t" });
    expect(out.SHIFT_FOUR_MONGO_URI).toBeUndefined();
  });
});

describe("normalizeOrigins", () => {
  it("falls back, trims, dedupes and validates", () => {
    expect(normalizeOrigins(undefined, "https://d")).toEqual(["https://d"]);
    expect(normalizeOrigins(["", "  "], "https://d")).toEqual(["https://d"]);
    expect(normalizeOrigins([" https://a ", "https://b", "https://a"], "https://d")).toEqual(["https://a", "https://b"]);
    expect(normalizeOrigins(["https://a:8443"], "https://d")).toEqual(["https://a:8443"]);
    expect(() => normalizeOrigins(["http://a"], "https://d")).toThrow(/https origin/);
    expect(() => normalizeOrigins(["https://a/path"], "https://d")).toThrow(/https origin/);
  });
});

describe("constants", () => {
  it("caps live envs at 6 by default", () => {
    expect(DEFAULT_MAX_NAMED_ENVS).toBe(6);
  });
});
