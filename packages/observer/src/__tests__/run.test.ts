import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { runObserver } from "../run";
import type { ObserverDeps, ObserverEvent, ObserverScope } from "../tools/types";

const scope: ObserverScope = { cluster: "EKS-Twizz-NonProd", namespace: "env-smoke", from: "2026-09-10T07:00:00.000Z", to: "2026-09-10T07:30:00.000Z" };

const deps: ObserverDeps = {
  async getPodLogs() {
    return { status: "complete", lines: [{ timestamp: "2026-09-10T07:10:00.000Z", message: "[Nest] 1  - 09/10/2026, 7:10:00 AM   ERROR [X] boom", podName: "moly-backend-abc12-x1y2z", containerName: "moly-backend" }] };
  },
  async getLogHistogram() {
    return { status: "complete", binMinutes: 15, bins: [] };
  },
  async getLivePods() {
    return [];
  },
};

type Turn = { text: string; stop_reason: string; stop_details?: unknown };

/** Fake client: each toolRunner iteration yields a stream that emits the turn's text. */
function fakeClient(turns: Turn[], captured: { params?: unknown }) {
  const streams = turns.map((t) => ({
    on(event: string, cb: (d: string) => void) {
      if (event === "text") setTimeout(() => cb(t.text), 0);
      return this;
    },
    async finalMessage() {
      await new Promise((r) => setTimeout(r, 1));
      return { stop_reason: t.stop_reason, stop_details: t.stop_details, content: [{ type: "text", text: t.text }], usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 } };
    },
  }));
  return {
    beta: {
      messages: {
        toolRunner(params: unknown) {
          captured.params = params;
          return {
            pushMessages() {},
            async *[Symbol.asyncIterator]() {
              for (const s of streams) yield s;
            },
          };
        },
      },
    },
  } as unknown as Anthropic;
}

describe("runObserver", () => {
  it("prefetches the view for summarize, streams text, reports usage, and passes the frozen system prompt", async () => {
    const events: ObserverEvent[] = [];
    const captured: { params?: { system?: Array<{ text: string; cache_control?: unknown }>; messages?: Array<{ role: string; content: string }>; model?: string; tools?: unknown[] } } = {};
    const r = await runObserver({ client: fakeClient([{ text: "All good.", stop_reason: "end_turn" }], captured), scope, deps, kind: "summarize", onEvent: (e) => events.push(e) });
    expect(r.text).toBe("All good.");
    expect(r.usage).toEqual({ input: 100, output: 10, cacheRead: 50, cacheWrite: 0 });
    expect(r.iterations).toBe(1);
    expect(events.map((e) => e.type)).toEqual(["status", "tool_result", "status", "text", "usage"]);
    expect(captured.params?.model).toBe("claude-opus-5");
    expect(captured.params?.system?.[0].cache_control).toEqual({ type: "ephemeral" });
    expect(captured.params?.system?.[0].text).not.toMatch(/2026|env-smoke/);
    const user = captured.params?.messages?.at(-1);
    expect(user?.role).toBe("user");
    expect(user?.content).toContain("namespace=env-smoke");
    expect(user?.content).toContain("[ERROR ×1");
    expect(captured.params?.tools?.length).toBe(4); // no node_metrics without the dep
  });

  it("carries text-only history and redacts the selection for explain", async () => {
    const captured: { params?: { messages?: Array<{ role: string; content: string }> } } = {};
    await runObserver({
      client: fakeClient([{ text: "ok", stop_reason: "end_turn" }], captured),
      scope,
      deps,
      kind: "explain",
      selection: "Authorization: Bearer abcDEF123456789xyz",
      history: [{ role: "user", content: "earlier" }, { role: "assistant", content: "reply" }],
    });
    const msgs = captured.params?.messages ?? [];
    expect(msgs).toHaveLength(3);
    expect(msgs[2].content).toContain("[REDACTED:bearer]");
    expect(msgs[2].content).not.toContain("abcDEF");
  });

  it("surfaces refusal and iteration cut-offs honestly", async () => {
    const r1 = await runObserver({ client: fakeClient([{ text: "", stop_reason: "refusal", stop_details: { explanation: "policy" } }], {}), scope, deps, kind: "chat", userText: "hi" });
    expect(r1.text).toContain("declined to continue: policy");
    const r2 = await runObserver({ client: fakeClient([{ text: "partial", stop_reason: "tool_use" }], {}), scope, deps, kind: "chat", userText: "hi" });
    expect(r2.text).toContain("Stopped after 1 tool iterations");
  });
});
