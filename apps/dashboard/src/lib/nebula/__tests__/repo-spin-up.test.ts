import { describe, expect, it } from "vitest";
import { TwizzYamlV2 } from "@twizz-idp/shared";
import { buildArgPreview, isValidBranchName, problemsFor, proposalToFiles, slugEnvName, validateTwizzObject, type SpinUpState } from "../repo-spin-up";

describe("slugEnvName", () => {
  it("squeezes repo + branch into a DNS label ≤ 24 chars, letter-first", () => {
    expect(slugEnvName("twizz-app/twizz-sentinel", "main")).toBe("sentinel-main");
    expect(slugEnvName("twizz-app/Moly-backend", "feature/Payments_V2")).toBe("moly-backend-payments-v2");
    expect(slugEnvName("twizz-app/business", "nebula/business-main")).toBe("business-business-main");
    expect(slugEnvName("twizz-app/frontend", "frontend")).toBe("frontend");
    expect(slugEnvName("twizz-app/123-numbers", "42")).toMatch(/^[a-z][a-z0-9-]{2,23}$/);
    expect(slugEnvName("twizz-app/a-very-long-repository-name", "and-a-very-long-branch-name").length).toBeLessThanOrEqual(24);
    expect(slugEnvName("x", "y")).toBe("x-y");
  });
});

describe("branch names", () => {
  it("accepts git-valid names and refuses the classic invalid shapes", () => {
    expect(isValidBranchName("feature/x-1")).toBe(true);
    expect(isValidBranchName("nebula/sentinel-main")).toBe(true);
    expect(isValidBranchName("bad..name")).toBe(false);
    expect(isValidBranchName("/leading")).toBe(false);
    expect(isValidBranchName("trailing/")).toBe(false);
    expect(isValidBranchName("x.lock")).toBe(false);
    expect(isValidBranchName("has space")).toBe(false);
  });
});

const backend = TwizzYamlV2.parse({ version: 2, kind: "backend", port: 8090, healthPath: "/health" });
const frontend = TwizzYamlV2.parse({ version: 2, kind: "frontend", port: 80, healthPath: "/", build: { args: { VITE_API_URL: "${NEBULA_API_URL}/v1", VITE_SELF: "${NEBULA_ENV_URL}" } }, frontend: { framework: "vite", apiEnvVar: "VITE_API_URL", serve: "static" } });

describe("proposalToFiles / buildArgPreview / validateTwizzObject", () => {
  it("commits the edited YAML text and the Dockerfile only when kept", () => {
    const proposal = { twizzYaml: backend, dockerfile: { path: "Dockerfile", content: "FROM node:20-alpine\n", reason: "none in repo" } };
    expect(proposalToFiles("version: 2\n", proposal, true).map((f) => f.path)).toEqual(["twizz.yaml", "Dockerfile"]);
    expect(proposalToFiles("version: 2\n", proposal, false).map((f) => f.path)).toEqual(["twizz.yaml"]);
    expect(proposalToFiles("version: 2\n", null, true).map((f) => f.path)).toEqual(["twizz.yaml"]);
  });

  it("resolves placeholders for the preview", () => {
    expect(buildArgPreview(frontend, { envName: "biz-main", attachUrl: "https://api-x.prv.twizz.com" })).toEqual([
      { key: "VITE_API_URL", value: "https://api-x.prv.twizz.com/v1" },
      { key: "VITE_SELF", value: "https://biz-main.prv.twizz.com" },
    ]);
    expect(buildArgPreview(frontend, { envName: "" })[0].value).toContain("<attach a backend>");
    expect(buildArgPreview(null, { envName: "x" })).toEqual([]);
  });

  it("validates parsed YAML objects and reports issues", () => {
    expect(validateTwizzObject({ ok: false, error: "bad indent" })).toEqual({ ok: false, issues: ["YAML: bad indent"] });
    const r = validateTwizzObject({ ok: true, value: { version: 2, kind: "backend", port: 8090, healthPath: "/health", env: { TOKEN: "eyJabcdefghijk.x" } } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]).toMatch(/looks like a credential/);
  });
});

describe("problemsFor", () => {
  const base: SpinUpState = { repo: "twizz-app/twizz-sentinel", branchMode: "existing", branch: "main", newBranchFrom: "", headSha: "a".repeat(40), envName: "sentinel-main", ttlHours: 168, config: backend, configIssues: [], attach: null, db: "none" };

  it("is empty for a complete backend state", () => {
    expect(problemsFor(base)).toEqual([]);
  });

  it("shows DENIED previews for names policy would refuse, before the gate", () => {
    expect(problemsFor({ ...base, envName: "my-prod-test" })[0]).toMatch(/^DENIED: env name/);
    expect(problemsFor({ ...base, branch: "release/staging-1" })[0]).toMatch(/^DENIED: branch/);
    expect(problemsFor({ ...base, branchMode: "new", branch: "prod-fix", newBranchFrom: "main" })[0]).toMatch(/^DENIED: branch "prod-fix"/);
    expect(problemsFor({ ...base, repo: "twizz-app/prod-tools" })).toContain('DENIED: repo "twizz-app/prod-tools" matches the global *prod* deny');
  });

  it("requires attach for frontends, a config, and a valid new branch", () => {
    expect(problemsFor({ ...base, config: frontend })).toEqual(["frontends must attach to a backend env (or an API URL)"]);
    expect(problemsFor({ ...base, config: frontend, attach: { env: "api-main" } })).toEqual([]);
    expect(problemsFor({ ...base, config: null, configIssues: ["port: required"] })).toEqual(["twizz.yaml has 1 issue"]);
    expect(problemsFor({ ...base, branchMode: "new", branch: "", newBranchFrom: "" })).toEqual(["name the new branch", "pick the branch to create it from"]);
    expect(problemsFor({ ...base, branchMode: "new", branch: "main", newBranchFrom: "main" })).toEqual(['DENIED: branch "main" would be refused by policy (main/master/*prod*/*staging*)', "the new branch needs a different name from its base"]);
    expect(problemsFor({ ...base, db: "clone" })).toEqual(["clone staging is only available for moly-backend"]);
  });
});
