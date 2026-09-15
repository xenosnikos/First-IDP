import type Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { runAgentLoop, type AgentUsage, type ToolCallRecord } from "../agent";
import { CONFIGURATOR_SYSTEM_PROMPT, NUDGE_MESSAGE, configuratorUserMessage } from "./prompt";
import { CONFIGURATOR_TOOLS } from "./tools";
import type { ConfiguratorCtx, ConfiguratorEvent, Proposal, RepoReader } from "./types";

export const CONFIGURATOR_MAX_ITERATIONS = 14;

export type RunConfiguratorOptions = {
  client: Anthropic;
  repo: string;
  ref: string;
  sha: string;
  reader: RepoReader;
  hints?: string;
  kindHint?: "backend" | "frontend" | "worker";
  onEvent?: (e: ConfiguratorEvent) => void;
  signal?: AbortSignal;
  model?: string;
  maxIterations?: number;
};

export type ConfiguratorResult = {
  proposal: Proposal | null;
  text: string;
  model: string;
  usage: AgentUsage;
  toolCalls: ToolCallRecord[];
  iterations: number;
  stopReason: string;
  rejected: number;
  redactions: Record<string, number>;
  durationMs: number;
};

const TERMINAL_TOOL = "propose_config";

/** One run: loop until propose_config is accepted; if the model stops
 * without one, a single nudge turn; then `proposal: null` (honest FAIL). */
export async function runConfigurator(o: RunConfiguratorOptions): Promise<ConfiguratorResult> {
  const started = Date.now();
  const ctx: ConfiguratorCtx = { repo: o.repo, ref: o.ref, sha: o.sha, reader: o.reader, onEvent: o.onEvent, signal: o.signal, notes: {}, redactions: {}, rejected: 0 };
  const messages: BetaMessageParam[] = [{ role: "user", content: configuratorUserMessage({ repo: o.repo, ref: o.ref, sha: o.sha, hints: o.hints, kindHint: o.kindHint }) }];
  const usage: AgentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const toolCalls: ToolCallRecord[] = [];
  let iterations = 0;
  let text = "";
  let stopReason = "end_turn";
  let model = o.model ?? "";

  const runOnce = async (msgs: BetaMessageParam[], max: number) => {
    const r = await runAgentLoop<ConfiguratorCtx>({
      client: o.client,
      system: CONFIGURATOR_SYSTEM_PROMPT,
      tools: CONFIGURATOR_TOOLS,
      ctx,
      messages: msgs,
      model: o.model,
      maxIterations: max,
      maxTokens: 20_000,
      effort: "high",
      terminal: { tools: [TERMINAL_TOOL], shouldStop: () => !!ctx.proposal },
    });
    usage.input += r.usage.input;
    usage.output += r.usage.output;
    usage.cacheRead += r.usage.cacheRead;
    usage.cacheWrite += r.usage.cacheWrite;
    toolCalls.push(...r.toolCalls);
    iterations += r.iterations;
    text = r.text || text;
    stopReason = r.stopReason;
    model = r.model;
    return r;
  };

  const first = await runOnce(messages, o.maxIterations ?? CONFIGURATOR_MAX_ITERATIONS);
  if (!ctx.proposal && !o.signal?.aborted && first.stopReason !== "refusal") {
    o.onEvent?.({ type: "status", word: "RUNNING", note: "no proposal yet — asking once more" });
    await runOnce([...first.messages, { role: "user", content: NUDGE_MESSAGE }], 3);
  }
  if (ctx.proposal) o.onEvent?.({ type: "proposal", word: "PASS", proposal: ctx.proposal });

  return { proposal: ctx.proposal ?? null, text, model, usage, toolCalls, iterations, stopReason, rejected: ctx.rejected, redactions: ctx.redactions, durationMs: Date.now() - started };
}
