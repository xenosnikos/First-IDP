import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaMessageStream } from "@anthropic-ai/sdk/lib/BetaMessageStream";
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { redact } from "./logs/redact";
import { SYSTEM_PROMPT, userMessageFor, type ObserverKind } from "./prompt";
import { fetchLogs, toolsFor } from "./tools";
import { scopeText } from "./tools/scope";
import type { ObserverCtx, ObserverDeps, ObserverEvent, ObserverScope, ObserverTool } from "./tools/types";

export const DEFAULT_MODEL = "claude-opus-5";
export const MAX_ITERATIONS = 8;
export const MAX_HISTORY_TURNS = 12;
export const MAX_TURN_CHARS = 8000;
const TOOL_RESULT_CAP = 32_000;

export type HistoryTurn = { role: "user" | "assistant"; content: string };

export type ObserverResult = {
  text: string;
  model: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  toolCalls: Array<{ name: string; input: unknown; ms?: number }>;
  iterations: number;
  stopReason: string;
  redactions: Record<string, number>;
  durationMs: number;
};

export type RunObserverOptions = {
  client: Anthropic;
  scope: ObserverScope;
  deps: ObserverDeps;
  kind: ObserverKind;
  history?: HistoryTurn[];
  selection?: string;
  userText?: string;
  onEvent?: (e: ObserverEvent) => void;
  signal?: AbortSignal;
  model?: string;
  maxIterations?: number;
};

/** Client from env. ANTHROPIC_WORKSPACE_ID is required by identity-linked
 * keys that are not scoped to a workspace (same convention as twizz-sentinel). */
export function createObserverClient(apiKey = process.env.ANTHROPIC_API_KEY, workspaceId = process.env.ANTHROPIC_WORKSPACE_ID): Anthropic | null {
  if (!apiKey) return null;
  return new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000, defaultHeaders: workspaceId ? { "anthropic-workspace-id": workspaceId } : undefined });
}

/** Text-only history, validated: bounded, alternating, oldest dropped. */
export function normalizeHistory(history: HistoryTurn[] | undefined): BetaMessageParam[] {
  const turns = (history ?? []).filter((t) => (t.role === "user" || t.role === "assistant") && typeof t.content === "string" && t.content.trim() !== "");
  const kept = turns.slice(-MAX_HISTORY_TURNS);
  const out: BetaMessageParam[] = [];
  if (turns.length > kept.length) out.push({ role: "user", content: "[earlier turns omitted]" }, { role: "assistant", content: "Understood." });
  for (const t of kept) {
    const content = t.content.length > MAX_TURN_CHARS ? t.content.slice(0, MAX_TURN_CHARS) + " …" : t.content;
    const last = out[out.length - 1];
    if (last && last.role === t.role) {
      last.content = `${last.content as string}\n\n${content}`;
    } else out.push({ role: t.role, content });
  }
  // must start with a user turn
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapTool(tool: ObserverTool<any>, ctx: ObserverCtx, calls: ObserverResult["toolCalls"]) {
  return betaZodTool({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.input,
    run: async (input) => {
      const t0 = Date.now();
      const id = `${tool.name}-${calls.length + 1}`;
      ctx.onEvent?.({ type: "tool_use", id, name: tool.name, input });
      const entry = { name: tool.name, input, ms: 0 };
      calls.push(entry);
      let text: string;
      try {
        text = await tool.run(input, ctx);
      } catch (e) {
        text = `tool error: ${String((e as Error).message ?? e)}`;
      }
      entry.ms = Date.now() - t0;
      let truncated = false;
      if (text.length > TOOL_RESULT_CAP) {
        text = text.slice(0, TOOL_RESULT_CAP) + `\n… [tool result truncated at ${TOOL_RESULT_CAP} chars — narrow the query]`;
        truncated = true;
      }
      if (truncated) ctx.onEvent?.({ type: "tool_result", id, name: tool.name, chars: text.length, ms: entry.ms, truncated });
      return text;
    },
  });
}

export async function runObserver(o: RunObserverOptions): Promise<ObserverResult> {
  const started = Date.now();
  const model = o.model ?? DEFAULT_MODEL;
  const ctx: ObserverCtx = { scope: o.scope, deps: o.deps, onEvent: o.onEvent, signal: o.signal, notes: {}, redactions: {} };
  const calls: ObserverResult["toolCalls"] = [];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const emit = (e: ObserverEvent) => o.onEvent?.(e);

  // One-click kinds get the current view up front so they usually cost one turn.
  let compactText: string | undefined;
  if (o.kind === "summarize" || o.kind === "errors") {
    emit({ type: "status", word: "RUNNING", note: "fetching the current view" });
    compactText = await fetchLogs.run({ errorsOnly: o.kind === "errors" }, ctx);
  }
  const selection = o.selection ? redact(o.selection.replace(/\x1b\[[0-9;]*m/g, "").slice(0, 20_000)).text : undefined;
  const messages: BetaMessageParam[] = [
    ...normalizeHistory(o.history),
    { role: "user", content: userMessageFor(o.kind, { scopeText: scopeText(o.scope), compactText, selection, userText: o.userText }) },
  ];

  const tools = toolsFor(ctx).map((t) => wrapTool(t, ctx, calls));
  emit({ type: "status", word: "RUNNING", note: "thinking" });

  const runner = o.client.beta.messages.toolRunner(
    {
      model,
      max_tokens: 16_000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools,
      messages,
      max_iterations: o.maxIterations ?? MAX_ITERATIONS,
      stream: true,
    },
    { signal: o.signal },
  );

  let iterations = 0;
  let text = "";
  let stopReason = "end_turn";
  let refusal: string | undefined;
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
  }

  if (refusal) text = (text ? text + "\n\n" : "") + `[The model declined to continue: ${refusal}]`;
  if (stopReason === "max_tokens") text += "\n\n[Answer cut off at the token limit — ask a narrower question.]";
  if (stopReason === "tool_use") text += `\n\n[Stopped after ${iterations} tool iterations without a final answer — narrow the scope or ask a more specific question.]`;

  return { text, model, usage, toolCalls: calls, iterations, stopReason, redactions: ctx.redactions, durationMs: Date.now() - started };
}
