import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { DEFAULT_MODEL, runAgentLoop, type AgentLoopResult } from "./agent";
import { redact } from "./logs/redact";
import { SYSTEM_PROMPT, userMessageFor, type ObserverKind } from "./prompt";
import { fetchLogs, toolsFor } from "./tools";
import { scopeText } from "./tools/scope";
import type { ObserverCtx, ObserverDeps, ObserverEvent, ObserverScope } from "./tools/types";

export { DEFAULT_MODEL };
export const MAX_ITERATIONS = 8;
export const MAX_HISTORY_TURNS = 12;
export const MAX_TURN_CHARS = 8000;

export type HistoryTurn = { role: "user" | "assistant"; content: string };

export type ObserverResult = AgentLoopResult & { redactions: Record<string, number> };

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

export async function runObserver(o: RunObserverOptions): Promise<ObserverResult> {
  const ctx: ObserverCtx = { scope: o.scope, deps: o.deps, onEvent: o.onEvent, signal: o.signal, notes: {}, redactions: {} };
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

  const r = await runAgentLoop<ObserverCtx>({
    client: o.client,
    system: SYSTEM_PROMPT,
    tools: toolsFor(ctx),
    ctx,
    messages,
    model: o.model,
    maxIterations: o.maxIterations ?? MAX_ITERATIONS,
  });
  return { ...r, redactions: ctx.redactions };
}
