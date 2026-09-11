import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { createGate } from "../gate";
import { MemoryNonceStore, PrismaNonceStore, NONCE_TTL_MS, type ActionNonceDelegate } from "../confirm";
import { evaluatePolicy, loadPolicyFile } from "../policy";
import type { AuditEntry } from "../audit";

// The real policy the MCP server ships — tests pin its named-env entries.
const policy = loadPolicyFile(join(__dirname, "..", "..", "..", "..", "apps", "mcp", "policy.yaml"));
const TAG = "build-75b95f51-a1de-432d-8132-33a2802f622c";

describe("policy.yaml — named-env tools", () => {
  const ok = { allowed: true };
  it("create_named_env: allows moly-backend + build-* + plain names", () => {
    expect(evaluatePolicy(policy, "create_named_env", { name: "smoke", service: "moly-backend", imageTag: TAG })).toEqual(ok);
  });
  it("create_named_env: denies other services, alias tags, and prod/staging/shared/dev names", () => {
    expect(evaluatePolicy(policy, "create_named_env", { name: "smoke", service: "frontend", imageTag: TAG }).allowed).toBe(false);
    expect(evaluatePolicy(policy, "create_named_env", { name: "smoke", service: "moly-backend", imageTag: "latest" }).allowed).toBe(false);
    for (const name of ["prod", "myprod2", "staging-copy", "shared", "dev"]) {
      const d = evaluatePolicy(policy, "create_named_env", { name, service: "moly-backend", imageTag: TAG });
      expect(d.allowed, name).toBe(false);
    }
  });
  it("clone_staging_db: source is pinned to the staging preview blob", () => {
    expect(evaluatePolicy(policy, "clone_staging_db", { name: "smoke", source: "preview/moly-backend" })).toEqual(ok);
    expect(evaluatePolicy(policy, "clone_staging_db", { name: "smoke", source: "prod/moly/backend" }).allowed).toBe(false);
    expect(evaluatePolicy(policy, "clone_staging_db", { name: "smoke", source: "preview/twizz-admin" }).allowed).toBe(false);
    expect(evaluatePolicy(policy, "clone_staging_db", { name: "smoke" }).allowed).toBe(false); // missing pinned field
  });
  it("teardown / extend: any name, but global *prod* deny still applies", () => {
    expect(evaluatePolicy(policy, "teardown_named_env", { name: "smoke" })).toEqual(ok);
    expect(evaluatePolicy(policy, "extend_named_env", { name: "smoke", ttlHours: "24" })).toEqual(ok);
    expect(evaluatePolicy(policy, "teardown_named_env", { name: "prod-like" }).allowed).toBe(false);
  });
  it("unknown tools are denied by default (dispatch lives inside the actions, never as a tool)", () => {
    expect(evaluatePolicy(policy, "trigger_build", { repo: "twizz-app/x" }).allowed).toBe(false);
  });
  it("build-on-provision tools: org repos only, reserved names refused, prod-shaped refs caught globally", () => {
    const f = { name: "biz-feat", repo: "twizz-app/business", ref: "feat/x", sha: "a".repeat(40), kind: "frontend", service: "business" };
    expect(evaluatePolicy(policy, "create_env_from_repo", f)).toEqual(ok);
    expect(evaluatePolicy(policy, "create_env_from_repo", { ...f, repo: "someone/business" }).allowed).toBe(false);
    expect(evaluatePolicy(policy, "create_env_from_repo", { ...f, service: "nebula" }).allowed).toBe(false);
    expect(evaluatePolicy(policy, "create_env_from_repo", { ...f, ref: "production" }).allowed).toBe(false);
    expect(evaluatePolicy(policy, "create_env_from_repo", { ...f, kind: "sidecar" }).allowed).toBe(false);
    expect(evaluatePolicy(policy, "open_config_pr", { repo: "twizz-app/business", base: "dev", branch: "nebula/biz-feat" })).toEqual(ok);
    expect(evaluatePolicy(policy, "open_config_pr", { repo: "twizz-app/business", base: "dev", branch: "feat/x" }).allowed).toBe(false);
    expect(evaluatePolicy(policy, "create_branch", { repo: "twizz-app/business", name: "feat/x" })).toEqual(ok);
    expect(evaluatePolicy(policy, "create_branch", { repo: "twizz-app/business", name: "main" }).allowed).toBe(false);
    expect(evaluatePolicy(policy, "rebuild_env", { name: "biz-feat" })).toEqual(ok);
    expect(evaluatePolicy(policy, "set_env_vars", { name: "biz-feat" })).toEqual(ok);
  });
});

function harness(nonces = new MemoryNonceStore()) {
  const rows: AuditEntry[] = [];
  const gate = createGate({ policy, nonces, audit: async (e) => void rows.push(e) });
  return { gate, rows };
}

describe("gate", () => {
  it("policy denial → audited, action never runs", async () => {
    const { gate, rows } = harness();
    let ran = false;
    const r = await gate("create_named_env", { name: "prod", service: "moly-backend", imageTag: TAG }, undefined, "s", async () => (ran = true));
    expect(r).toMatchObject({ denied: true });
    expect(ran).toBe(false);
    expect(rows).toEqual([expect.objectContaining({ action: "mcp.create_named_env", allowed: false })]);
  });

  it("two-step confirm: nonce issued, then consumed once for the same args", async () => {
    const { gate, rows } = harness();
    const fields = { name: "smoke", service: "moly-backend", imageTag: TAG };
    const first = await gate("create_named_env", fields, undefined, "summary", async () => "created");
    expect(first).toMatchObject({ confirmationRequired: true, summary: "summary" });
    const nonce = (first as { confirm: string }).confirm;
    expect(rows).toHaveLength(0); // issuing a nonce is not an action

    const wrongArgs = await gate("create_named_env", { ...fields, name: "other" }, nonce, "s", async () => "x");
    expect(wrongArgs).toMatchObject({ denied: true, reason: /unknown or already-used/ }); // consumed on mismatch

    const second = await gate("create_named_env", fields, (await gate("create_named_env", fields, undefined, "s", async () => 1) as { confirm: string }).confirm, "s", async () => "created");
    expect(second).toEqual({ done: true, result: "created" });
    expect(rows.at(-1)).toMatchObject({ action: "mcp.create_named_env", allowed: true, detail: { result: "created" } });
  });

  it("action errors are audited and returned, not thrown", async () => {
    const { gate, rows } = harness();
    const fields = { name: "smoke" };
    const nonce = (await gate("teardown_named_env", fields, undefined, "s", async () => 1) as { confirm: string }).confirm;
    const r = await gate("teardown_named_env", fields, nonce, "s", async () => {
      throw new Error("boom");
    });
    expect(r).toEqual({ error: "Error: boom" });
    expect(rows.at(-1)).toMatchObject({ allowed: true, detail: { error: "Error: boom" } });
  });

  it("nonces expire after 5 minutes", async () => {
    let t = 1_000_000;
    const store = new MemoryNonceStore(() => t);
    const nonce = await store.issue("x", { a: "1" });
    t += NONCE_TTL_MS + 1;
    expect(await store.consume(nonce, "x", { a: "1" })).toMatchObject({ ok: false, reason: /expired/ });
  });
});

describe("PrismaNonceStore", () => {
  function fakeDelegate() {
    const rows = new Map<string, { fingerprint: string; expiresAt: Date }>();
    const d: ActionNonceDelegate = {
      async create({ data }) {
        rows.set(data.nonce, { fingerprint: data.fingerprint, expiresAt: data.expiresAt });
        return data;
      },
      async findUnique({ where }) {
        return rows.get(where.nonce) ?? null;
      },
      async deleteMany({ where }) {
        let count = 0;
        for (const [k, v] of rows) {
          if ((where.nonce && k === where.nonce) || (where.expiresAt && v.expiresAt < where.expiresAt.lt)) {
            rows.delete(k);
            count++;
          }
        }
        return { count };
      },
    };
    return { d, rows };
  }

  it("behaves like the memory store, across 'processes' sharing the table", async () => {
    let t = 5_000_000;
    const { d, rows } = fakeDelegate();
    const issuer = new PrismaNonceStore(d, () => t);
    const consumer = new PrismaNonceStore(d, () => t);
    const nonce = await issuer.issue("extend_named_env", { name: "smoke", ttlHours: "24" });
    expect(rows.size).toBe(1);
    expect(await consumer.consume(nonce, "extend_named_env", { ttlHours: "24", name: "smoke" })).toEqual({ ok: true }); // key order irrelevant
    expect(await consumer.consume(nonce, "extend_named_env", { name: "smoke", ttlHours: "24" })).toMatchObject({ ok: false });
    expect(rows.size).toBe(0);
  });

  it("sweeps expired rows on issue", async () => {
    let t = 0;
    const { d, rows } = fakeDelegate();
    const store = new PrismaNonceStore(d, () => t);
    await store.issue("a", {});
    t += NONCE_TTL_MS + 1;
    await store.issue("b", {});
    expect(rows.size).toBe(1);
  });
});
