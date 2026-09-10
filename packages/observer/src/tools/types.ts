import type { z } from "zod/v4";
import type { LogLine } from "../logs/normalize";

/** Fixed by the human's selection on the dashboard (or by explicit MCP args
 * validated by policy). Tools can only narrow inside it. ISO timestamps. */
export type ObserverScope = { cluster: string; namespace: string; pod?: string; from: string; to: string };

export type InsightsStatus = "complete" | "timeout" | "failed";

/** The slice of @twizz-idp/core the Observer needs, injected so this package
 * stays pure and the MCP server can pass the same awsService. Times in epoch
 * SECONDS, like core. */
export type ObserverDeps = {
  getPodLogs(p: {
    clusterName: string;
    namespace: string;
    podName?: string;
    startTime: number;
    endTime: number;
    filterPattern?: string;
    limit?: number;
  }): Promise<{ status: InsightsStatus; lines: LogLine[] }>;
  getLogHistogram(p: {
    clusterName: string;
    namespace: string;
    podName?: string;
    filterPattern?: string;
    startTime: number;
    endTime: number;
    binMinutes?: number;
  }): Promise<{ status: InsightsStatus; binMinutes: number; bins: Array<{ t: string; n: number }> }>;
  getLivePods(cluster: string): Promise<Array<{ podName: string; namespace: string; containerName: string; status: string; restarts: number; nodeName?: string }>>;
  getNodeMetrics?(cluster: string): Promise<Array<{ name: string; cpu: number; mem: number; pods: number }>>;
};

export type ObserverEvent =
  | { type: "status"; word: "RUNNING" | "PASS" | "FAIL" | "DENIED" | "STUB"; note?: string }
  | { type: "text"; delta: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; status?: string; lines?: number; groups?: number; chars: number; redacted?: number; ms: number; truncated?: boolean }
  | { type: "usage"; input: number; output: number; cacheRead: number; cacheWrite: number; iterations: number }
  | { type: "done"; word: "PASS"; text: string }
  | { type: "error"; word: "FAIL" | "DENIED" | "STUB"; message: string };

export type ObserverCtx = {
  scope: ObserverScope;
  deps: ObserverDeps;
  onEvent?: (e: ObserverEvent) => void;
  signal?: AbortSignal;
  /** Per-run scratch shared between tools (e.g. last groups for drill-down). */
  notes: Record<string, unknown>;
  /** Accumulated redaction counts across tool results. */
  redactions: Record<string, number>;
};

/** SDK-independent tool: the same object is wrapped for Anthropic (dashboard)
 * and for MCP (phase 2). Input schemas never carry cluster/namespace. */
export type ObserverTool<I extends z.ZodTypeAny = z.ZodTypeAny> = {
  name: string;
  description: string;
  input: I;
  run(input: z.infer<I>, ctx: ObserverCtx): Promise<string>;
};

/** Identity helper so `run(input)` is typed from the schema. */
export function defineTool<I extends z.ZodTypeAny>(t: ObserverTool<I>): ObserverTool<I> {
  return t;
}
