// The generic agent loop: Anthropic tool-runner (streamed) over SDK-independent
// tools, with per-call events, usage accounting and honest stop reasons. The
// Observer (logs) and the Configurator (repo config) are both thin callers.
import type Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaMessageStream } from "@anthropic-ai/sdk/lib/BetaMessageStream";
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { z } from "zod/v4";

export const DEFAULT_MODEL = "claude-opus-5";
export const TOOL_RESULT_CAP = 32_000;

/** Events every agent surface streams to the UI (SSE). */
export type AgentEvent =
  | { type: "status"; word: "RUNNING" | "PASS" | "FAIL" | "DENIED" | "STUB"; note?: string }
  | { type: "text"; delta: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; status?: string; lines?: number; groups?: number; chars: number; redacted?: number; ms: number; truncated?: boolean }
  | { type: "usage"; input: number; output: number; cacheRead: number; cacheWrite: number; iterations: number }
  | { type: "done"; word: "PASS"; text: string }
  | { type: "error"; word: "FAIL" | "DENIED" | "STUB"; message: string };

/** What every tool context carries; surfaces extend it. */
export type AgentCtxBase = { onEvent?: (e: AgentEvent) => void; signal?: AbortSignal };

/** SDK-independent tool: wrapped for Anthropic here, for MCP elsewhere. */
export type AgentTool<I extends z.ZodTypeAny = z.ZodTypeAny, C extends AgentCtxBase = AgentCtxBase> = {
  name: string;
  description: string;
  input: I;
  run(input: z.infer<I>, ctx: C): Promise<string>;
};

export type ToolCallRecord = { name: string; input: unknown; ms?: number };

export type AgentUsage = { input: number; output: number; cacheRead: number; cacheWrite: number };

export type AgentLoopResult = {
  /** The full conversation so far (for a follow-up turn). */
  messages: BetaMessageParam[];
  text: string;
  model: string;
  usage: AgentUsage;
  toolCalls: ToolCallRecord[];
  iterations: number;
  stopReason: string;
  durationMs: number;
};

export type RunAgentLoopOptions<C extends AgentCtxBase> = {
  client: Anthropic;
  system: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: readonly AgentTool<any, C>[];
  ctx: C;
  messages: BetaMessageParam[];
  model?: string;
  maxIterations: number;
  maxTokens?: number;
  effort?: "low" | "medium" | "high";
  /** Terminal tools: when the model calls one, the tool is executed and
   * `shouldStop()` decides (e.g. "was the proposal accepted?") whether the
   * loop ends there instead of sending the result back to the model. */
  terminal?: { tools: readonly string[]; shouldStop: () => boolean };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function wrapTool<C extends AgentCtxBase>(tool: AgentTool<any, C>, ctx: C, calls: ToolCallRecord[], cap = TOOL_RESULT_CAP) {
  return betaZodTool({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.input,
    run: async (input) => {
      const t0 = Date.now();
      const id = `${tool.name}-${calls.length + 1}`;
      ctx.onEvent?.({ type: "tool_use", id, name: tool.name, input });
      const entry: ToolCallRecord = { name: tool.name, input, ms: 0 };
      calls.push(entry);
      let text: string;
      try {
        text = await tool.run(input, ctx);
      } catch (e) {
        text = `tool error: ${String((e as Error).message ?? e)}`;
      }
      entry.ms = Date.now() - t0;
      let truncated = false;
      if (text.length > cap) {
        text = text.slice(0, cap) + `\n… [tool result truncated at ${cap} chars — narrow the query]`;
        truncated = true;
      }
      if (truncated) ctx.onEvent?.({ type: "tool_result", id, name: tool.name, chars: text.length, ms: entry.ms!, truncated });
      return text;
    },
  });
}

/** Run the loop until the model stops, the iteration cap is hit, the model
 * refuses, or a terminal tool was called. The last assistant prose is `text`. */
export async function runAgentLoop<C extends AgentCtxBase>(o: RunAgentLoopOptions<C>): Promise<AgentLoopResult> {
  const started = Date.now();
  const model = o.model ?? DEFAULT_MODEL;
  const calls: ToolCallRecord[] = [];
  const usage: AgentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const emit = (e: AgentEvent) => o.ctx.onEvent?.(e);
  const tools = o.tools.map((t) => wrapTool(t, o.ctx, calls));
  emit({ type: "status", word: "RUNNING", note: "thinking" });

  const runner = o.client.beta.messages.toolRunner(
    {
      model,
      max_tokens: o.maxTokens ?? 16_000,
      thinking: { type: "adaptive" },
      output_config: { effort: o.effort ?? "medium" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [{ type: "text", text: o.system, cache_control: { type: "ephemeral" } }],
      tools,
      messages: o.messages,
      max_iterations: o.maxIterations,
      stream: true,
    },
    { signal: o.ctx.signal },
  );

  let iterations = 0;
  let text = "";
  let stopReason = "end_turn";
  let refusal: string | undefined;
  let terminal = false;
  for await (const stream of runner as AsyncIterable<BetaMessageStream>) {
    iterations++;
    let turnText = "";
    stream.on("text", (delta: string) => {
      turnText += delta;
      emit({ type: "text", delta });
    });
    const msg = await stream.finalMessage();
    usage.input += msg.usage.input_tokens ?? 0;
    usage.output += msg.usage.output_tokens ?? 0;
    usage.cacheRead += msg.usage.cache_read_input_tokens ?? 0;
    usage.cacheWrite += msg.usage.cache_creation_input_tokens ?? 0;
    stopReason = msg.stop_reason ?? "end_turn";
    if (turnText) text = turnText; // the last assistant prose is the answer
    if (msg.stop_reason === "refusal") {
      refusal = msg.stop_details && "explanation" in msg.stop_details ? String((msg.stop_details as { explanation?: string }).explanation ?? "refused") : "refused";
      break;
    }
    if (msg.stop_reason === "pause_turn") runner.pushMessages({ role: "assistant", content: msg.content });
    emit({ type: "usage", ...usage, iterations });
    // terminal tool: execute it now (the runner caches the response, so it is
    // never run twice), then either stop or let the loop continue normally
    if (o.terminal && msg.stop_reason === "tool_use") {
      const used = msg.content.filter((b) => b.type === "tool_use").map((b) => (b as { name: string }).name);
      if (used.some((n) => o.terminal!.tools.includes(n))) {
        await runner.generateToolResponse?.();
        if (o.terminal.shouldStop()) {
          terminal = true;
          stopReason = "terminal_tool";
          break;
        }
      }
    }
  }

  if (refusal) text = (text ? text + "\n\n" : "") + `[The model declined to continue: ${refusal}]`;
  if (stopReason === "max_tokens") text += "\n\n[Answer cut off at the token limit — ask a narrower question.]";
  if (stopReason === "tool_use" && !terminal) text += `\n\n[Stopped after ${iterations} tool iterations without a final answer — narrow the scope or ask a more specific question.]`;

  const finalMessages = (runner as unknown as { params?: { messages?: BetaMessageParam[] } }).params?.messages ?? o.messages;
  return { messages: finalMessages, text, model, usage, toolCalls: calls, iterations, stopReason, durationMs: Date.now() - started };
}
