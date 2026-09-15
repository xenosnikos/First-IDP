import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { checkProposal } from "../configurator/proposal";
import { runConfigurator } from "../configurator/run";
import { detectStack, readFile, redactConfigText } from "../configurator/tools";
import type { ConfiguratorCtx, ConfiguratorEvent, RepoReader } from "../configurator/types";

const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "twizz-sentinel", scripts: { start: "node dist/main.js", build: "tsc" }, dependencies: { "@nestjs/core": "^10", mongoose: "^8" }, engines: { node: ">=20" } }),
  "src/main.ts": "const port = Number(process.env.PORT ?? 8090);\napp.listen(port);",
  ".env.example": "ANTHROPIC_API_KEY=sk-ant-realvalue123\nLOG_LEVEL=info\n",
  "config.yaml": "db:\n  password: hunter2\n  host: localhost\n",
  "pnpm-lock.yaml": "lockfileVersion: 9",
};

const reader: RepoReader = {
  async listTree() {
    return { entries: Object.keys(FILES).map((path) => ({ path, type: "blob" as const, size: FILES[path].length })), truncated: false };
  },
  async getFile(path) {
    return FILES[path] ?? null;
  },
};

const ctx = (): ConfiguratorCtx => ({ repo: "twizz-app/twizz-sentinel", ref: "main", sha: "a".repeat(40), reader, notes: {}, redactions: {}, rejected: 0 });

type Turn = { text: string; stop_reason: string; tool?: { name: string; input: unknown } };

/** Fake client mirroring the real runner: each iteration yields a stream for
 * one scripted turn; a tool_use turn is executed once — either by the caller
 * (generateToolResponse, cached) or by the runner before the next turn. */
function fakeClient(turns: Turn[], executed: string[]) {
  let i = 0;
  let toolsByName: Record<string, { run: (input: unknown) => Promise<string> }> = {};
  const messages: unknown[] = [];
  let pending: Promise<unknown> | undefined;
  const execute = (t: Turn) => {
    if (!t.tool) return Promise.resolve(null);
    pending ??= (async () => {
      executed.push(t.tool!.name);
      const text = await toolsByName[t.tool!.name].run(t.tool!.input);
      messages.push({ role: "user", content: [{ type: "tool_result", content: text }] });
      return { role: "user", content: [] };
    })();
    return pending;
  };
  const runner = {
    params: { messages },
    pushMessages() {},
    generateToolResponse: () => execute(turns[i - 1]),
    async *[Symbol.asyncIterator]() {
      while (i < turns.length) {
        pending = undefined;
        const t = turns[i++];
        yield {
          on(event: string, cb: (d: string) => void) {
            if (event === "text" && t.text) setTimeout(() => cb(t.text), 0);
            return this;
          },
          async finalMessage() {
            await new Promise((r) => setTimeout(r, 1));
            const content: unknown[] = t.text ? [{ type: "text", text: t.text }] : [];
            if (t.tool) content.push({ type: "tool_use", id: `t${i}`, name: t.tool.name, input: t.tool.input });
            messages.push({ role: "assistant", content });
            return { stop_reason: t.stop_reason, content, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
          },
        };
        if (t.stop_reason !== "tool_use") break;
        await execute(t);
      }
    },
  };
  return {
    beta: {
      messages: {
        toolRunner(params: { tools: Array<{ name: string; run: (input: unknown) => Promise<string> }> }) {
          toolsByName = Object.fromEntries(params.tools.map((t) => [t.name, t]));
          return runner;
        },
      },
    },
  } as unknown as Anthropic;
}

const goodProposal = { twizzYaml: { version: 2, kind: "backend", port: 8090, healthPath: "/health", needs: { mongo: true }, secrets: ["ANTHROPIC_API_KEY"] }, confidence: "high", basedOn: ["src/main.ts:1"] };

describe("checkProposal", () => {
  it("accepts a valid backend and fills defaults", () => {
    const r = checkProposal(goodProposal);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.proposal.twizzYaml).toMatchObject({ dockerfile: "Dockerfile", context: ".", env: {}, needs: { mongo: true, redis: false } });
  });

  it("rejects secrets in build args, a Dockerfile at the wrong path, and baked credentials", () => {
    const r1 = checkProposal({ ...goodProposal, twizzYaml: { ...goodProposal.twizzYaml, build: { args: { API_KEY: "x" } } } });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.issues.join(" ")).toMatch(/build arg "API_KEY"/);
    const r2 = checkProposal({ ...goodProposal, dockerfile: { path: "docker/Dockerfile", content: "FROM node:20-alpine\n", reason: "none" } });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.issues[0]).toMatch(/must equal context \+ dockerfile/);
    const r3 = checkProposal({ ...goodProposal, dockerfile: { path: "Dockerfile", content: "FROM node:20-alpine\nENV API_KEY=abc\n", reason: "none" } });
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.issues[0]).toMatch(/credential-looking/);
  });

  it("requires ARG declarations for build args and the frontend block", () => {
    const fe = { version: 2, kind: "frontend", port: 80, healthPath: "/", build: { args: { VITE_API_URL: "${NEBULA_API_URL}" } }, frontend: { framework: "vite", apiEnvVar: "VITE_API_URL", serve: "static" } };
    const bad = checkProposal({ twizzYaml: fe, confidence: "medium", dockerfile: { path: "Dockerfile", content: "FROM node:20-alpine AS build\nRUN npm ci\nFROM nginx:alpine\n", reason: "no Dockerfile in the repo" } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues[0]).toMatch(/ARG VITE_API_URL/);
    const good = checkProposal({ twizzYaml: fe, confidence: "medium", dockerfile: { path: "Dockerfile", content: "FROM node:20-alpine AS build\nARG VITE_API_URL\nRUN npm ci\nFROM nginx:alpine\n", reason: "no Dockerfile in the repo" } });
    expect(good.ok).toBe(true);
    const noBlock = checkProposal({ twizzYaml: { ...fe, frontend: undefined }, confidence: "low" });
    expect(noBlock.ok).toBe(false);
  });
});

describe("configurator tools", () => {
  it("detect_stack summarises package.json and lists .env.example KEYS only", async () => {
    const c = ctx();
    const out = await detectStack.run({}, c);
    expect(out).toContain("@nestjs/core@^10");
    expect(out).toContain("dockerfiles: NONE");
    expect(out).toContain(".env.example keys: ANTHROPIC_API_KEY, LOG_LEVEL");
    expect(out).not.toContain("realvalue");
  });

  it("read_file masks credential-looking values and returns keys only for env files", async () => {
    const c = ctx();
    const env = await readFile.run({ path: ".env.example" }, c);
    expect(env).toContain("ANTHROPIC_API_KEY=[REDACTED:value]");
    expect(env).toContain("LOG_LEVEL=[REDACTED:value]");
    expect(env).not.toContain("realvalue");
    const yaml = await readFile.run({ path: "config.yaml" }, c);
    expect(yaml).toContain("password: [REDACTED:value]");
    expect(yaml).toContain("host: localhost");
    expect(c.redactions.value).toBe(3);
    expect(await readFile.run({ path: "nope.ts" }, c)).toMatch(/no such file/);
    expect(redactConfigText("token: eyJabc.def.ghi", c)).not.toContain("eyJabc");
  });
});

describe("runConfigurator", () => {
  it("runs detect_stack → read_file → rejected proposal → accepted proposal and stops at the terminal tool", async () => {
    const executed: string[] = [];
    const events: ConfiguratorEvent[] = [];
    const client = fakeClient(
      [
        { text: "", stop_reason: "tool_use", tool: { name: "detect_stack", input: {} } },
        { text: "", stop_reason: "tool_use", tool: { name: "read_file", input: { path: "src/main.ts" } } },
        { text: "", stop_reason: "tool_use", tool: { name: "propose_config", input: { ...goodProposal, twizzYaml: { ...goodProposal.twizzYaml, build: { args: { SECRET_KEY: "x" } } } } } },
        { text: "Proposing.", stop_reason: "tool_use", tool: { name: "propose_config", input: goodProposal } },
        { text: "SHOULD NOT RUN", stop_reason: "end_turn" },
      ],
      executed,
    );
    const r = await runConfigurator({ client, repo: "twizz-app/twizz-sentinel", ref: "main", sha: "a".repeat(40), reader, onEvent: (e) => events.push(e) });
    expect(r.proposal?.twizzYaml.port).toBe(8090);
    expect(r.rejected).toBe(1);
    expect(r.stopReason).toBe("terminal_tool");
    expect(r.iterations).toBe(4);
    expect(r.text).toBe("Proposing.");
    expect(executed).toEqual(["detect_stack", "read_file", "propose_config", "propose_config"]);
    expect(events.find((e) => e.type === "proposal")).toBeTruthy();
    expect(r.toolCalls.map((t) => t.name)).toEqual(["detect_stack", "read_file", "propose_config", "propose_config"]);
  });

  it("returns proposal: null (after one nudge) when the model never proposes", async () => {
    const client = fakeClient([{ text: "I think it is a backend on 8090.", stop_reason: "end_turn" }, { text: "Still no.", stop_reason: "end_turn" }], []);
    const r = await runConfigurator({ client, repo: "twizz-app/twizz-sentinel", ref: "main", sha: "a".repeat(40), reader });
    expect(r.proposal).toBeNull();
    expect(r.iterations).toBe(2);
  });
});
