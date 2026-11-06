import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MCP_CAPACITY_WRITES, MCP_CLUSTERS, MCP_OPERATOR_READS, MCP_OPERATOR_WRITES, MCP_READ_TOOLS, MCP_SELF_SERVICE_WRITES, MCP_TOOL_NAMES, MCP_WRITE_TOOLS, toolsFor, gateText, registerNebulaTools, scopeOf, type AppCaller, type NebulaMcpDeps } from "../tools";
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
    intent: vi.fn(async () => {}),
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
    expect(await names(true, [])).toEqual([...everyone, ...MCP_OPERATOR_READS, ...MCP_OPERATOR_WRITES].sort()); // operator without a scope: no capacity writes
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

describe("durable intent before a confirmed write (Codex review 2026-11-05)", () => {
  it("refuses the write and never calls Nebula if the intent row can't be stored", async () => {
    const { caller, calls } = fakeCaller();
    const client = await connect({ caller, intent: async () => { throw new Error("db down"); } });
    const r = await client.callTool({ name: "teardown_env", arguments: { name: "feat-x", confirm: "nonce-1234567" } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("REFUSED");
    expect(calls).toHaveLength(0);
  });

  it("the first (unconfirmed) call needs no intent; the confirmed call writes intent first, then the outcome with the same id", async () => {
    const order: string[] = [];
    const client = await connect({
      caller: fakeCaller().caller,
      intent: async (_t, _a, i) => { order.push(`intent:${i}`); },
      audit: async (_t, _a, _ok, _ms, _e, i) => { order.push(`outcome:${i ?? "-"}`); },
    });
    await client.callTool({ name: "teardown_env", arguments: { name: "feat-x" } });
    await client.callTool({ name: "teardown_env", arguments: { name: "feat-x", confirm: "nonce-1234567" } });
    expect(order[0]).toBe("outcome:-");
    const id = order[1].slice("intent:".length);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(order[2]).toBe(`outcome:${id}`);
  });
});

describe("traffic-driven capacity (§N5.4)", () => {
  it("an estimate apply forwards only numbers — the size is computed server-side", async () => {
    const { caller, calls } = fakeCaller();
    const client = await connect({ caller });
    await client.callTool({ name: "apply_live_capacity", arguments: { tier: "production", estimateRps: 2500, planHash: "c".repeat(64) } });
    const call = calls.find((c) => c.proc === "actions.applyLiveCapacity")!;
    expect(call.input).toEqual({ tier: "production", estimate: { rps: 2500, peakFactor: 1, headroom: 1.2 }, planHash: "c".repeat(64), confirm: undefined });
  });

  it("exactly one of preset or estimateRps", async () => {
    const { caller, calls } = fakeCaller();
    const client = await connect({ caller });
    for (const args of [{ tier: "production", planHash: "c".repeat(64) }, { tier: "production", preset: "max", estimateRps: 2500, planHash: "c".repeat(64) }]) {
      const r = await client.callTool({ name: "apply_live_capacity", arguments: args });
      expect(r.isError).toBe(true);
    }
    expect(calls.filter((c) => c.proc === "actions.applyLiveCapacity")).toHaveLength(0);
  });

  it("estimates, peaks, windows and cases are reads every bound person gets; applying stays scoped", async () => {
    const names = (await (await connect({ caller: fakeCaller().caller, operator: false, scopes: [] })).listTools()).tools.map((t) => t.name);
    for (const n of ["capacity_estimate", "traffic_peaks", "traffic_window", "capacity_cases"]) expect(names).toContain(n);
    expect(names).not.toContain("apply_live_capacity");
  });

  it("capacity_estimate defaults to the peak as given with 1.2 headroom", async () => {
    const { caller, calls } = fakeCaller({ "capacity.estimateLive": { ok: true } });
    const client = await connect({ caller });
    await client.callTool({ name: "capacity_estimate", arguments: { tier: "production", rps: 2500 } });
    expect(calls.find((c) => c.proc === "capacity.estimateLive")?.input).toEqual({ tier: "production", rps: 2500, peakFactor: 1, headroom: 1.2 });
  });

  it("offers the plan_capacity_for_traffic prompt, which starts from past cases", async () => {
    const client = await connect({ caller: fakeCaller().caller });
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain("plan_capacity_for_traffic");
    const p = await client.getPrompt({ name: "plan_capacity_for_traffic", arguments: { expectedPeakRps: "2500", when: "tonight 00:00 EET" } });
    const text = (p.messages[0].content as { text: string }).text;
    expect(text).toMatch(/capacity_cases/);
    expect(text.indexOf("capacity_cases")).toBeLessThan(text.indexOf("capacity_estimate"));
    expect(text).toContain("2500");
  });
});

describe("traffic estimate hardening (Codex review 2026-11-06)", () => {
  it("a profile may only name allowlisted workloads and node groups", async () => {
    const { checkProfileTargets } = await import("../../routers/capacity");
    expect(() => checkProfileTargets("production", { workloads: { "moly-backend-deployment": {} }, nodegroups: { "eks-prod-node-group-m5-2x-extra": {} } })).not.toThrow();
    expect(() => checkProfileTargets("production", { workloads: { "kube-proxy": {} }, nodegroups: {} })).toThrow(/allowlist/);
    expect(() => checkProfileTargets("production", { workloads: {}, nodegroups: { "some-other-group": {} } })).toThrow(/allowlist/);
  });

  it("Logs Insights bin timestamps parse as UTC; zoned values are accepted; junk is dropped", async () => {
    const { insightsTime } = await import("../../nebula/traffic");
    expect(insightsTime("2026-11-05 22:18:00.000")).toBe(Date.parse("2026-11-05T22:18:00.000Z"));
    expect(insightsTime("2026-11-05T22:18:00.000Z")).toBe(Date.parse("2026-11-05T22:18:00.000Z"));
    expect(insightsTime("2026-11-06T00:18:00+02:00")).toBe(Date.parse("2026-11-05T22:18:00.000Z"));
    expect(insightsTime("not a time")).toBeNull();
  });
});

describe("events + incidents (verify / watch / changes / prompts)", () => {
  it("are reads every bound person gets", async () => {
    const names = (await (await connect({ caller: fakeCaller().caller, operator: false, scopes: [] })).listTools()).tools.map((t) => t.name);
    for (const n of ["capacity_verify", "event_watch"]) expect(names).toContain(n);
    expect(names).not.toContain("recent_changes"); // other people's activity: operators only
  });

  it("capacity_verify takes exactly one target and forwards it", async () => {
    const { caller, calls } = fakeCaller({ "capacity.verify": { check: { verdict: "READY" } } });
    const client = await connect({ caller });
    expect((await client.callTool({ name: "capacity_verify", arguments: { tier: "production" } })).isError).toBe(true);
    await client.callTool({ name: "capacity_verify", arguments: { tier: "production", preset: "campaign" } });
    await client.callTool({ name: "capacity_verify", arguments: { tier: "production", estimateRps: 2500 } });
    expect(calls.filter((c) => c.proc === "capacity.verify").map((c) => c.input)).toEqual([
      { tier: "production", preset: "campaign" },
      { tier: "production", estimate: { rps: 2500, peakFactor: 1, headroom: 1.2 } },
    ]);
  });

  it("event_watch returns the verdict and only the last 10 minutes of detail", async () => {
    const minutes = Array.from({ length: 30 }, (_, i) => ({ t: String(i), rps: i }));
    const client = await connect({ caller: fakeCaller({ "capacity.watch": { status: "WATCH", minutes } }).caller });
    const out = JSON.parse(textOf(await client.callTool({ name: "event_watch", arguments: { tier: "production" } })));
    expect(out.status).toBe("WATCH");
    expect(out.lastMinutes).toHaveLength(10);
    expect(out.minutes).toBeUndefined();
  });

  it("prompts: prepare_marketing_event (verify before the event) and diagnose_outage (changes before conclusions; no prod restarts)", async () => {
    const client = await connect({ caller: fakeCaller().caller });
    const names = (await client.listPrompts()).prompts.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(["plan_capacity_for_traffic", "prepare_marketing_event", "diagnose_outage"]));
    const prep = (( await client.getPrompt({ name: "prepare_marketing_event", arguments: { expectedPeakRps: "2500" } })).messages[0].content as { text: string }).text;
    expect(prep.indexOf("capacity_verify")).toBeGreaterThan(prep.indexOf("apply_live_capacity"));
    expect(prep).toMatch(/explicit yes/);
    const diag = ((await client.getPrompt({ name: "diagnose_outage", arguments: { symptom: "slow at midnight" } })).messages[0].content as { text: string }).text;
    expect(diag.indexOf("recent_changes")).toBeLessThan(diag.indexOf("Conclude"));
    expect(diag).toMatch(/NOT Nebula actions/);
  });
});

describe("capacity file provenance: pinned, proven (Codex reviews)", () => {
  const SHA = (c: string) => c.repeat(40);
  type PR = { number: number; merged_at: string | null; base: { ref: string; repo: { full_name: string } }; merge_commit_sha: string; merged_by: string | null; commits: string[] };
  const gh = (o: { head?: string; lastCommit?: Record<string, string>; prs?: PR[]; content?: Record<string, string>; throws?: boolean }) =>
    ({
      git: { getRef: async () => ({ data: { object: { sha: o.head ?? SHA("h") } } }) },
      repos: {
        listCommits: async ({ path }: { path: string }) => {
          if (o.throws) throw new Error("GitHub down");
          const c = o.lastCommit?.[path];
          return { data: c ? [{ sha: c }] : [] };
        },
        listPullRequestsAssociatedWithCommit: async ({ commit_sha }: { commit_sha: string }) => ({ data: (o.prs ?? []).filter((p) => p.merge_commit_sha === commit_sha || p.commits.includes(commit_sha)) }),
        getContent: async ({ path, ref }: { path: string; ref: string }) => ({ data: { type: "file", sha: `blob-${path}-${ref.slice(0, 1)}`, content: Buffer.from(o.content?.[path] ?? "presets: []").toString("base64") } }),
      },
      pulls: {
        get: async ({ pull_number }: { pull_number: number }) => {
          const p = (o.prs ?? []).find((x) => x.number === pull_number)!;
          return { data: { merged_by: p.merged_by ? { login: p.merged_by } : null, merge_commit_sha: p.merge_commit_sha } };
        },
        listCommits: async ({ pull_number }: { pull_number: number }) => ({ data: ((o.prs ?? []).find((x) => x.number === pull_number)?.commits ?? []).map((sha) => ({ sha })) }),
      },
    }) as never;
  const pr = (o: Partial<PR> & { number: number }): PR => ({ merged_at: "2026-11-06T08:00:00Z", base: { ref: "main", repo: { full_name: "TwizzyNicky/twizz-gitops" } }, merge_commit_sha: SHA("m"), merged_by: "TwizzyNicky", commits: [], ...o });
  const P = "capacity/presets.yaml";

  it("accepts a squash merge by an owner (the last commit IS the merge commit)", async () => {
    const { capacityFileProvenance } = await import("../../nebula/capacity");
    process.env.NEBULA_CAPACITY_OWNERS = "twizzynicky";
    const v = await capacityFileProvenance(P, SHA("1"), gh({ lastCommit: { [P]: SHA("m") }, prs: [pr({ number: 7 })] }));
    expect(v).toMatchObject({ ok: true, pr: 7, mergedBy: "twizzynicky" });
  });

  it("accepts a merge-commit PR whose own commit last touched the file", async () => {
    const { capacityFileProvenance } = await import("../../nebula/capacity");
    expect(await capacityFileProvenance(P, SHA("2"), gh({ lastCommit: { [P]: SHA("c") }, prs: [pr({ number: 8, commits: [SHA("c")] })] }))).toMatchObject({ ok: true, pr: 8 });
  });

  it("refuses: direct push, a non-owner merger, a PR into another repo, and a PR that only CONTAINS the commit", async () => {
    const { capacityFileProvenance } = await import("../../nebula/capacity");
    expect(await capacityFileProvenance(P, SHA("3"), gh({ lastCommit: { [P]: SHA("d") }, prs: [] }))).toMatchObject({ ok: false, reason: expect.stringMatching(/pushed directly/) });
    expect(await capacityFileProvenance(P, SHA("4"), gh({ lastCommit: { [P]: SHA("m") }, prs: [pr({ number: 9, merged_by: "mallory" })] }))).toMatchObject({ ok: false, reason: expect.stringMatching(/capacity owner/) });
    expect(await capacityFileProvenance(P, SHA("5"), gh({ lastCommit: { [P]: SHA("m") }, prs: [pr({ number: 10, base: { ref: "main", repo: { full_name: "evil/twizz-gitops" } } })] }))).toMatchObject({ ok: false });
    // association returns a PR whose merge commit and commits are NOT the file's last commit
    const containing = { lastCommit: { [P]: SHA("x") }, prs: [pr({ number: 11, merge_commit_sha: SHA("y"), commits: [SHA("z")] })] };
    const g = gh(containing) as unknown as { repos: { listPullRequestsAssociatedWithCommit: unknown } };
    g.repos.listPullRequestsAssociatedWithCommit = async () => ({ data: containing.prs });
    expect(await capacityFileProvenance(P, SHA("6"), g as never)).toMatchObject({ ok: false, reason: expect.stringMatching(/not the merge or one of the commits/) });
  });

  it("errors fail closed and are not cached", async () => {
    const { capacityFileProvenance } = await import("../../nebula/capacity");
    expect(await capacityFileProvenance(P, SHA("7"), gh({ throws: true }))).toMatchObject({ ok: false, reason: expect.stringMatching(/could not verify/) });
    expect(await capacityFileProvenance(P, SHA("7"), gh({ lastCommit: { [P]: SHA("m") }, prs: [pr({ number: 7 })] }))).toMatchObject({ ok: true });
  });

  it("pinReviewedCapacity reads the bytes AT the pinned head and throws if any file is unproven", async () => {
    const { pinReviewedCapacity } = await import("../../nebula/capacity");
    const ok = await pinReviewedCapacity([P], gh({ head: SHA("8"), lastCommit: { [P]: SHA("m") }, prs: [pr({ number: 7 })], content: { [P]: "presets: []" } }));
    expect(ok.head).toBe(SHA("8"));
    expect(ok.files[P]).toMatchObject({ content: "presets: []", blob: `blob-${P}-8` });
    await expect(pinReviewedCapacity([P, "capacity/profiles.yaml"], gh({ head: SHA("9"), lastCommit: { [P]: SHA("m") }, prs: [pr({ number: 7 })] }))).rejects.toThrow(/not owner-reviewed/);
  });
});

describe("watchVerdict (Codex review)", () => {
  const ok = { verdict: "OK" as const, rps: 0, workloads: [], nodegroups: [], notes: [] };
  const sat = { ...ok, verdict: "SATURATED" as const };
  const base = { peakRps: 200, requests: 12_000, err5xx: 0, p95MsLast: 280, nodes: { cpuAvgPct: 20, cpuMaxPct: 30 }, maxPodMcpu: 90, atPeak: ok, atPeakPlus30: ok, signals: [] as Array<{ label: string; word: string }>, edgeData: true, podData: "complete" as const };
  it("OK when everything is calm", async () => {
    const { watchVerdict } = await import("../../nebula/watch-model");
    expect(watchVerdict(base)).toMatchObject({ status: "OK", reasons: [] });
  });
  it("high 5xx alone is ACT — but NOT capacity evidence", async () => {
    const { watchVerdict } = await import("../../nebula/watch-model");
    expect(watchVerdict({ ...base, err5xx: 600 })).toMatchObject({ status: "ACT", capacityEvidence: false, capacityShort: false });
  });
  it("saturation is ACT with capacity evidence", async () => {
    const { watchVerdict } = await import("../../nebula/watch-model");
    expect(watchVerdict({ ...base, atPeak: sat, nodes: { cpuAvgPct: 91, cpuMaxPct: 99 } })).toMatchObject({ status: "ACT", capacityEvidence: true });
  });
  it("a HOT monitor signal is ACT; missing data is UNKNOWN or WATCH with the gap named", async () => {
    const { watchVerdict } = await import("../../nebula/watch-model");
    expect(watchVerdict({ ...base, signals: [{ label: "Atlas connections", word: "HOT" }] }).status).toBe("ACT");
    expect(watchVerdict({ ...base, edgeData: false })).toMatchObject({ status: "UNKNOWN" });
    expect(watchVerdict({ ...base, podData: "timeout" })).toMatchObject({ status: "WATCH", reasons: [expect.stringMatching(/data gap: pod\/node metrics timeout/)] });
  });
});
