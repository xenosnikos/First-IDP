import { describe, expect, it } from "vitest";
import {
  ALIAS_TAGS,
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
    frontendOrigin: "https://smoke-frontend.prv.twizz.com",
  };
  it("serialises in schema order and parses back identically", () => {
    const yaml = manifestToYaml(m);
    expect(yaml.split("\n")[0]).toBe("name: smoke");
    expect(yaml).toContain("expiresAt: \"2026-09-14T00:00:00.000Z\"");
    expect(parseManifest(yaml)).toEqual(m);
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
    expect(parseManifest(hand)).toEqual({ ...m, expiresAt: "2026-09-14T00:00:00Z", db: { mode: "clone", generation: 1 } });
  });
  it("rejects bad manifests loudly", () => {
    expect(() => parseManifest("name: Bad\nservice: moly-backend\n")).toThrow(/invalid name/);
    expect(() => parseManifest(manifestToYaml(m).replace("moly-backend", "nope"))).toThrow(/unknown service/);
    expect(() => parseManifest(manifestToYaml(m).replace("mode: clone", "mode: shared"))).toThrow(/db.mode/);
    expect(() => parseManifest(manifestToYaml(m).replace("generation: 2", "generation: 0"))).toThrow(/generation/);
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

describe("constants", () => {
  it("caps live envs at 6 by default", () => {
    expect(DEFAULT_MAX_NAMED_ENVS).toBe(6);
  });
});
