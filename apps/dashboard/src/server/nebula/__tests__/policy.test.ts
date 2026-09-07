import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { evaluatePolicy, loadPolicyFile } from "@twizz-idp/actions";

// The dashboard enforces the SAME policy.yaml as the MCP server
// (apps/mcp/policy.yaml, traced into the standalone image by next.config).
const policyFile = resolve(__dirname, "../../../../../mcp/policy.yaml");

describe("policy.yaml wiring", () => {
  it("apps/mcp/policy.yaml exists where deps.ts resolves it from the app dir", () => {
    expect(existsSync(policyFile)).toBe(true);
    expect(existsSync(resolve(process.cwd(), "../mcp/policy.yaml"))).toBe(true);
  });
  it("covers the four named-env tools and denies prod-shaped names", () => {
    const policy = loadPolicyFile(policyFile);
    for (const tool of ["create_named_env", "teardown_named_env", "clone_staging_db", "extend_named_env"]) {
      expect(policy.write_tools?.[tool], tool).toBeDefined();
    }
    expect(evaluatePolicy(policy, "teardown_named_env", { name: "smoke" }).allowed).toBe(true);
    expect(evaluatePolicy(policy, "teardown_named_env", { name: "prod-ish" }).allowed).toBe(false);
    expect(evaluatePolicy(policy, "create_named_env", { name: "x1", service: "moly-backend", imageTag: "latest", db: "isolated", ttlHours: "1", frontendOrigin: "" }).allowed).toBe(false);
    expect(evaluatePolicy(policy, "clone_staging_db", { name: "x1", source: "staging/moly/backend" }).allowed).toBe(false);
    expect(evaluatePolicy(policy, "clone_staging_db", { name: "x1", source: "preview/moly-backend" }).allowed).toBe(true);
  });
});
