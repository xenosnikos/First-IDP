import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MCP_CAPACITY_WRITES, MCP_CLUSTERS, MCP_OPERATOR_WRITES, MCP_READ_TOOLS, MCP_SELF_SERVICE_WRITES, MCP_TOOL_NAMES, MCP_WRITE_TOOLS, toolsFor, gateText, registerNebulaTools, scopeOf, type AppCaller, type NebulaMcpDeps } from "../tools";
import { isAllowedSentinelPath, sentinelEndpoint } from "../sentinel";

// A caller that records every procedure call: tools must only reach the
// procedures they wrap, with the arguments the agent cannot widen.
function fakeCaller(results: Record<string, unknown> = {}) {
  const calls: Array<{ proc: string; input: unknown }> = [];
  const caller = new Proxy({}, {
    get: (_t, router: string) =>
      new Proxy({}, {
        get: (_u, proc: string) => async (input: unknown) => {
          const key = `${router}.${proc}`;
          calls.push({ proc: key, input });
          return results[key] ?? { confirmationRequired: true, summary: `summary of ${key}`, instruction: "", confirm: "nonce-1234567" };
        },
      }),
  }) as unknown as AppCaller;
  return { caller, calls };
}

async function connect(deps: Partial<NebulaMcpDeps> & { caller: AppCaller }) {
  const server = new McpServer({ name: "nebula", version: "test" });
  registerNebulaTools(server, {
    login: "nick",
    operator: true,
    scopes: ["capacity:production", "capacity:staging"],
    notes: {},
    observer: {
      getPodLogs: vi.fn(async () => ({ status: "complete" as const, lines: [] })),
      getLogHistogram: vi.fn(async () => ({ status: "complete" as const, binMinutes: 15, bins: [] })),
      getLivePods: vi.fn(async () => []),
    },
    sentinel: vi.fn(async () => ({ ok: true })),
    ...deps,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");

describe("nebula MCP surface", () => {
  it("an operator with both capacity scopes gets exactly the pinned tool list", async () => {
    const client = await connect({ caller: fakeCaller().caller });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
  });

  it("tools a person may not use are not even listed", async () => {
    const names = async (operator: boolean, scopes: string[]) => (await (await connect({ caller: fakeCaller().caller, operator, scopes: scopes as never })).listTools()).tools.map((t) => t.name).sort();
    const everyone = [...MCP_READ_TOOLS, ...MCP_SELF_SERVICE_WRITES].sort();
    expect(await names(false, [])).toEqual(everyone);
    expect(await names(false, ["capacity:production"])).toEqual(everyone); // a scope without operator grants nothing
    expect(await names(true, [])).toEqual([...everyone, ...MCP_OPERATOR_WRITES].sort()); // operator without a scope: no capacity writes
    expect(toolsFor({ operator: true, scopes: ["capacity:staging"] })).toContain("apply_live_capacity");
    expect(toolsFor({ operator: true, scopes: ["capacity:staging"] })).not.toContain("set_prod_atlas_tier");
  });

  it("live capacity: only the tiers the person is scoped for, only NAMED templates (no custom size)", async () => {
    const client = await connect({ caller: fakeCaller().caller, scopes: ["capacity:staging"] as never });
    const t = (await client.listTools()).tools.find((x) => x.name === "apply_live_capacity")!;
    const props = (t.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties;
    expect(props.tier.enum).toEqual(["staging"]);
    expect(Object.keys(props)).not.toContain("custom");
    const r = await client.callTool({ name: "apply_live_capacity", arguments: { tier: "production", preset: "max", planHash: "a".repeat(64) } });
    expect(r.isError).toBe(true);
  });

  it("live capacity forwards the preset + planHash to the gated procedure, never a custom size", async () => {
    const { caller, calls } = fakeCaller();
    const client = await connect({ caller });
    await client.callTool({ name: "apply_live_capacity", arguments: { tier: "production", preset: "campaign", planHash: "b".repeat(64) } });
    const call = calls.find((c) => c.proc === "actions.applyLiveCapacity")!;
    expect(call.input).toEqual({ tier: "production", preset: "campaign", planHash: "b".repeat(64), confirm: undefined });
  });

  it("never wraps the capacity-PR / NonProd Atlas procedures, and capacity writes appear only behind needScope", () => {
    const src = readFileSync(path.join(__dirname, "../tools.ts"), "utf8");
    for (const forbidden of ["setAtlasTier", "applyCapacityPreset", "mergeCapacityPr"]) expect(src).not.toContain(`.${forbidden}(`);
    for (const proc of ["applyLiveCapacity", "setProdAtlasTier"]) {
      const at = src.indexOf(`c.actions.${proc}(`);
      expect(at).toBeGreaterThan(0);
      expect(src.lastIndexOf("needScope(", at)).toBeGreaterThan(src.lastIndexOf("reg(", at));
    }
  });

  it("no non-capacity write tool takes a cluster, tier or target argument", async () => {
    const client = await connect({ caller: fakeCaller().caller });
    const { tools } = await client.listTools();
    for (const t of tools.filter((x) => (MCP_WRITE_TOOLS as readonly string[]).includes(x.name) && !(MCP_CAPACITY_WRITES as readonly string[]).includes(x.name))) {
      const props = Object.keys((t.inputSchema as { properties?: object }).properties ?? {});
      expect(props, t.name).not.toContain("cluster");
      expect(props, t.name).not.toContain("tier");
      expect(props, t.name).not.toContain("target");
    }
  });

  it("reads production logs (read-only) and refuses unknown clusters", async () => {
    const getPodLogs = vi.fn(async () => ({ status: "complete" as const, lines: [] }));
    const client = await connect({ caller: fakeCaller().caller, observer: { getPodLogs, getLogHistogram: vi.fn(), getLivePods: vi.fn(async () => []) } as never });
    expect(MCP_CLUSTERS).toContain("EKS-Moly-Prod");
    const ok = await client.callTool({ name: "fetch_logs", arguments: { cluster: "EKS-Moly-Prod", namespace: "default" } });
    expect(ok.isError).toBeFalsy();
    expect(((getPodLogs.mock.calls[0] as unknown[])[0] as { clusterName: string }).clusterName).toBe("EKS-Moly-Prod");
    const bad = await client.callTool({ name: "fetch_logs", arguments: { cluster: "some-other-cluster", namespace: "default" } });
    expect(bad.isError).toBe(true);
  });

  it("sentinel tools default to staging and pass an explicit production tier through", async () => {
    const sentinel = vi.fn(async () => ({ ok: true }));
    const client = await connect({ caller: fakeCaller().caller, sentinel });
    await client.callTool({ name: "sentinel_alerts", arguments: { severity: "critical" } });
    await client.callTool({ name: "sentinel_alerts", arguments: { tier: "production", severity: "critical" } });
    expect(sentinel.mock.calls[0]).toEqual(["staging", "alerts", { severity: "critical", limit: 25 }, "nick"]);
    expect(sentinel.mock.calls[1]).toEqual(["production", "alerts", { severity: "critical", limit: 25 }, "nick"]);
  });

  it("production sentinel answers 'not reachable' until it has an endpoint", () => {
    expect(sentinelEndpoint("production", {} as NodeJS.ProcessEnv)).toMatchObject({ missing: expect.stringContaining("not reachable") });
    expect(sentinelEndpoint("production", { NEBULA_SENTINEL_PROD_URL: "https://x/", SENTINEL_PROD_API_KEY: "k" } as never)).toEqual({ base: "https://x", key: "k" });
    expect(sentinelEndpoint("staging", { SENTINEL_STAGING_API_KEY: "k" } as never)).toEqual({ base: "https://sentinel-stg.prv.twizz.com", key: "k" });
  });

  it("scopes Observer reads to the given cluster/namespace and window", async () => {
    const getPodLogs = vi.fn(async () => ({ status: "complete" as const, lines: [] }));
    const client = await connect({ caller: fakeCaller().caller, observer: { getPodLogs, getLogHistogram: vi.fn(), getLivePods: vi.fn(async () => []) } as never });
    await client.callTool({ name: "fetch_logs", arguments: { cluster: "EKS-Moly-staging", namespace: "default", minutesBack: 30, errorsOnly: true } });
    const arg = (getPodLogs.mock.calls[0] as unknown[])[0] as { clusterName: string; namespace: string; startTime: number; endTime: number };
    expect(arg.clusterName).toBe("EKS-Moly-staging");
    expect(arg.namespace).toBe("default");
    expect(arg.endTime - arg.startTime).toBe(30 * 60);
  });

  it("caps the window at 24 h", () => {
    const s = scopeOf({ cluster: "EKS-Twizz-NonProd", namespace: "x", from: "2026-01-01T00:00:00Z", to: "2026-01-05T00:00:00Z" }, Date.parse("2026-02-01T00:00:00Z"));
    expect(Date.parse(s.to) - Date.parse(s.from)).toBe(24 * 3600_000);
  });

  it("promotions always target staging", async () => {
    const { caller, calls } = fakeCaller();
    const client = await connect({ caller });
    await client.callTool({ name: "promote_release", arguments: { service: "twizz-sentinel", imageTag: "main-0123456789abcdef0123456789abcdef01234567" } });
    expect(calls.find((c) => c.proc === "actions.promoteRelease")?.input).toMatchObject({ target: "staging" });
  });

  it("create_env_from_repo never forwards secret values: confirm sends declared names blank", async () => {
    const { caller, calls } = fakeCaller();
    const client = await connect({ caller });
    const args = { name: "feat-x", repo: "twizz-app/frontend", ref: "feat", sha: "a".repeat(40), twizzYaml: "version: 2\nkind: backend\nport: 3000\nhealthPath: /health\nsecrets: [STRIPE_KEY]\n", secretNames: ["OTHER_KEY"] };
    await client.callTool({ name: "create_env_from_repo", arguments: args });
    expect((calls[0].input as { secretValues?: unknown }).secretValues).toBeUndefined();
    await client.callTool({ name: "create_env_from_repo", arguments: { ...args, confirm: "nonce-1234567" } });
    expect((calls[1].input as { secretValues?: unknown }).secretValues).toEqual({ STRIPE_KEY: "", OTHER_KEY: "" });
  });

  it("set_env_vars refuses credential-shaped values before reaching Nebula", async () => {
    const { caller, calls } = fakeCaller();
    const client = await connect({ caller });
    const r = await client.callTool({ name: "set_env_vars", arguments: { name: "feat-x", vars: { AWS_KEY: "AKIAABCDEFGHIJKLMNOP" } } });
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("phrases the gate's two-step confirm for the agent", () => {
    const t = textOf(gateText({ confirmationRequired: true, summary: "Create named env 'x'", instruction: "", confirm: "abc12345" }));
    expect(t).toContain("CONFIRMATION REQUIRED");
    expect(t).toContain('confirm="abc12345"');
    expect(gateText({ denied: true, reason: "nope" }).isError).toBe(true);
  });

  it("surfaces tRPC errors (e.g. FORBIDDEN for non-operators) as tool errors", async () => {
    const { TRPCError } = await import("@trpc/server");
    const caller = new Proxy({}, { get: () => new Proxy({}, { get: () => async () => { throw new TRPCError({ code: "FORBIDDEN", message: "READ-ONLY: your GitHub login is not in NEBULA_OPERATORS" }); } }) }) as unknown as AppCaller;
    const client = await connect({ caller });
    const r = await client.callTool({ name: "clone_staging_db", arguments: { name: "feat-x" } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("FORBIDDEN");
  });

  it("CI reads are limited to Twizz repos and the Nebula builder", async () => {
    const client = await connect({ caller: fakeCaller().caller });
    expect((await client.callTool({ name: "ci_run", arguments: { owner: "someone", repo: "x", runId: 1 } })).isError).toBe(true);
    expect((await client.callTool({ name: "ci_run", arguments: { owner: "xenosnikos", repo: "First-IDP", runId: 1 } })).isError).toBeFalsy();
  });

  it("sentinel paths are an allowlist of GETs", () => {
    expect(isAllowedSentinelPath("alerts")).toBe(true);
    expect(isAllowedSentinelPath("alerts/0123456789abcdef01234567/similar")).toBe(true);
    expect(isAllowedSentinelPath("alerts/0123456789abcdef01234567/triage")).toBe(false);
    expect(isAllowedSentinelPath("ip-blocklist")).toBe(false);
    expect(isAllowedSentinelPath("alerts/../replay/event")).toBe(false);
  });
});
