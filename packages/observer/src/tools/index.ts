import { z } from "zod/v4";
import { groupLines, renderCompact, timeline, type LogGroup } from "../logs/compact";
import { isErrorLevel } from "../logs/level";
import { normalizeLine, type NormLine } from "../logs/normalize";
import { mergeCounts, redact } from "../logs/redact";
import { clampWindow, podWithinScope } from "./scope";
import { defineTool, type ObserverCtx, type ObserverTool } from "./types";

const sec = (d: Date) => Math.floor(d.getTime() / 1000);
const SAFE_RE = /(\+|\*|\{\d*,?\d*\})\s*[)\]]?\s*(\+|\*|\{)/;
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

export const TOOL_RESULT_CHARS = 40_000;

const statusLine = (status: string, lines: number, limit: number) =>
  status === "complete"
    ? lines >= limit
      ? `query complete but hit the ${limit}-line limit: older lines in this window exist and were not fetched`
      : "query complete"
    : status === "timeout"
      ? "query TIMED OUT after ~22 s (Logs Insights) — this is not 'no logs'; narrow the window, pod or filter"
      : "query FAILED (Logs Insights error) — this is not 'no logs'";

/** fetch_logs — newest N lines in a (sub)window, compacted. */
export const fetchLogs = defineTool({
  name: "fetch_logs",
  description:
    "Fetch the newest lines in the selected namespace (optionally one pod) and return them grouped by signature: [LEVEL ×count first→last pods] then a redacted sample. Use filter (regex on log text or pod name), errorsOnly, and offsets to narrow. You cannot widen the scope.",
  input: z
    .object({
      pod: z.string().max(253).optional().describe("Pod name (or prefix) inside the selected namespace"),
      filter: z.string().max(200).optional().describe("Regex matched against log text and pod name, e.g. ENTITY_NOT_FOUND|429"),
      errorsOnly: z.boolean().optional().describe("Only ERROR/FATAL/WARN lines and their stack frames"),
      fromOffsetMin: z.number().int().min(0).max(1440).optional().describe("Start this many minutes after the window start"),
      toOffsetMin: z.number().int().min(-1440).max(0).optional().describe("End this many minutes before the window end (negative)"),
      limit: z.number().int().min(50).max(1000).optional().describe("Newest N lines (default 300)"),
    })
    .strict(),
  async run(input, ctx) {
    const pod = podWithinScope(ctx.scope, input.pod);
    if (!pod.ok) return pod.reason;
    if (input.filter && SAFE_RE.test(input.filter)) return "filter rejected: nested quantifiers are not allowed (catastrophic backtracking)";
    const w = clampWindow(ctx.scope, input);
    const limit = input.limit ?? 300;
    const preFilter = input.errorsOnly ? (input.filter ? `(${input.filter}).*(ERROR|FATAL|WARN)|(ERROR|FATAL|WARN).*(${input.filter})` : "ERROR|FATAL|WARN|Error|Exception|panic") : input.filter;
    const t0 = Date.now();
    const { status, lines } = await ctx.deps.getPodLogs({
      clusterName: ctx.scope.cluster,
      namespace: ctx.scope.namespace,
      podName: pod.pod,
      startTime: sec(w.from),
      endTime: sec(w.to),
      filterPattern: preFilter || undefined,
      limit,
    });
    let norm: NormLine[] = lines.map(normalizeLine);
    if (input.errorsOnly) {
      // keep error-level records and the continuation lines that follow them
      const keep: NormLine[] = [];
      let keeping = false;
      for (const l of norm) {
        if (!l.continuation) keeping = isErrorLevel(l.level) || l.level === "WARN";
        if (keeping) keep.push(l);
      }
      norm = keep;
    }
    const groups = groupLines(norm);
    ctx.notes.lastGroups = groups;
    ctx.notes.lastWindow = { from: w.from.toISOString(), to: w.to.toISOString(), pod: pod.pod };
    const rendered = renderCompact(groups, {
      maxChars: TOOL_RESULT_CHARS,
      totalLines: norm.length,
      status,
      limitHit: status === "complete" && lines.length >= limit,
      timeline: timeline(norm, Math.max(1, Math.round((w.to.getTime() - w.from.getTime()) / 60_000 / 12))),
      window: { from: w.from.toISOString(), to: w.to.toISOString() },
    });
    for (const g of groups) if (g.sampleRedactions) ctx.redactions = mergeCounts(ctx.redactions, { sample: g.sampleRedactions });
    ctx.onEvent?.({ type: "tool_result", id: "", name: "fetch_logs", status, lines: lines.length, groups: groups.length, chars: rendered.chars, redacted: groups.reduce((a, g) => a + g.sampleRedactions, 0), ms: Date.now() - t0 });
    const head = `${statusLine(status, lines.length, limit)}${w.clamped ? " (offsets clamped to the selected window)" : ""}${pod.pod ? ` pod=${pod.pod}` : ""}`;
    return head + "\n" + rendered.text;
  },
});

export const logHistogram = defineTool({
  name: "log_histogram",
  description: "Line counts per time bin for the selected scope (optionally one pod / a regex filter). Cheap: use it first to find bursts before fetching lines.",
  input: z
    .object({
      pod: z.string().max(253).optional(),
      filter: z.string().max(200).optional(),
      binMinutes: z.union([z.literal(5), z.literal(15), z.literal(60)]).optional(),
    })
    .strict(),
  async run(input, ctx) {
    const pod = podWithinScope(ctx.scope, input.pod);
    if (!pod.ok) return pod.reason;
    if (input.filter && SAFE_RE.test(input.filter)) return "filter rejected: nested quantifiers are not allowed";
    const w = clampWindow(ctx.scope);
    const t0 = Date.now();
    const r = await ctx.deps.getLogHistogram({
      clusterName: ctx.scope.cluster,
      namespace: ctx.scope.namespace,
      podName: pod.pod,
      filterPattern: input.filter,
      startTime: sec(w.from),
      endTime: sec(w.to),
      binMinutes: input.binMinutes ?? 15,
    });
    ctx.onEvent?.({ type: "tool_result", id: "", name: "log_histogram", status: r.status, lines: r.bins.reduce((a, b) => a + b.n, 0), chars: 0, ms: Date.now() - t0 });
    if (r.status !== "complete") return `histogram query ${r.status.toUpperCase()} — not "no logs"`;
    if (r.bins.length === 0) return "histogram complete: 0 lines in the window for this scope";
    const total = r.bins.reduce((a, b) => a + b.n, 0);
    const peak = r.bins.reduce((a, b) => (b.n > a.n ? b : a), r.bins[0]);
    return [`bin=${r.binMinutes}m total=${total} peak=${peak.n} at ${peak.t}`, ...r.bins.map((b) => `${b.t}  ${b.n}`)].join("\n");
  },
});

export const listPods = defineTool({
  name: "list_pods",
  description: "Live pods in the selected namespace (status, restarts, node) from Container Insights performance metrics (last 5 minutes).",
  input: z.object({}).strict(),
  async run(_input, ctx) {
    const t0 = Date.now();
    const pods = (await ctx.deps.getLivePods(ctx.scope.cluster)).filter((p) => p.namespace === ctx.scope.namespace && (!ctx.scope.pod || p.podName.startsWith(ctx.scope.pod)));
    ctx.onEvent?.({ type: "tool_result", id: "", name: "list_pods", lines: pods.length, chars: 0, ms: Date.now() - t0 });
    if (pods.length === 0) return `no live pods reported in ${ctx.scope.namespace} in the last 5 minutes (metrics lag ~1–2 min; a pod that just started may be missing)`;
    return pods.map((p) => `${p.podName}  container=${p.containerName}  status=${p.status}  restarts=${p.restarts}${p.nodeName ? `  node=${p.nodeName}` : ""}`).join("\n");
  },
});

export const getGroupSamples = defineTool({
  name: "get_group_samples",
  description: "Raw (redacted) lines around the first or last occurrence of a group from the last fetch_logs, matched by a stable token of its signature. Use to see the full context of one failure mode.",
  input: z
    .object({
      signature: z.string().max(200).describe("The signature text as shown by fetch_logs (or a distinctive literal substring of it)"),
      n: z.number().int().min(1).max(20).optional(),
      around: z.enum(["first", "last"]).optional(),
    })
    .strict(),
  async run(input, ctx) {
    const groups = (ctx.notes.lastGroups as LogGroup[] | undefined) ?? [];
    const g = groups.find((x) => x.signature === input.signature) ?? groups.find((x) => x.signature.includes(input.signature));
    if (!g) return "no such group in the last fetch_logs result; call fetch_logs first";
    // longest run without placeholders
    const token = g.signature.split(/:[a-z]+\b/).map((s) => s.trim()).sort((a, b) => b.length - a.length)[0] ?? "";
    if (token.length < 6) return "the signature has no stable literal to search for; narrow with fetch_logs filter instead";
    const at = Date.parse(input.around === "last" ? g.last : g.first);
    const lo = Date.parse(ctx.scope.from);
    const hi = Date.parse(ctx.scope.to);
    const from = new Date(Math.max(lo, at - 120_000));
    const to = new Date(Math.min(hi, at + 120_000));
    const t0 = Date.now();
    const { status, lines } = await ctx.deps.getPodLogs({
      clusterName: ctx.scope.cluster,
      namespace: ctx.scope.namespace,
      podName: ctx.scope.pod ?? Object.keys(g.pods)[0],
      startTime: sec(from),
      endTime: sec(to),
      filterPattern: escapeRegex(token.slice(0, 80)),
      limit: 200,
    });
    const n = input.n ?? 5;
    const picked = (input.around === "last" ? lines.slice(-n) : lines.slice(0, n)).map((l) => {
      const r = redact(l.message.replace(/\x1b\[[0-9;]*m/g, ""));
      ctx.redactions = mergeCounts(ctx.redactions, r.counts);
      return `${l.timestamp} ${l.podName} ${r.text}`;
    });
    ctx.onEvent?.({ type: "tool_result", id: "", name: "get_group_samples", status, lines: lines.length, chars: picked.join("\n").length, ms: Date.now() - t0 });
    if (status !== "complete") return `query ${status.toUpperCase()} — not "no logs"`;
    if (picked.length === 0) return `no lines matched "${token}" within ±2 min of ${input.around === "last" ? g.last : g.first}`;
    return picked.join("\n");
  },
});

export const nodeMetrics = defineTool({
  name: "node_metrics",
  description: "Node CPU/memory utilisation and running pod counts for the cluster (last 5 minutes).",
  input: z.object({}).strict(),
  async run(_input, ctx) {
    if (!ctx.deps.getNodeMetrics) return "node metrics are not available in this context";
    const t0 = Date.now();
    const nodes = await ctx.deps.getNodeMetrics(ctx.scope.cluster);
    ctx.onEvent?.({ type: "tool_result", id: "", name: "node_metrics", lines: nodes.length, chars: 0, ms: Date.now() - t0 });
    if (nodes.length === 0) return "no node metrics returned (query may have timed out)";
    return nodes.map((n) => `${n.name}  cpu=${n.cpu.toFixed(1)}%  mem=${n.mem.toFixed(1)}%  pods=${n.pods}`).join("\n");
  },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const OBSERVER_TOOLS: readonly ObserverTool<any>[] = [fetchLogs, logHistogram, listPods, getGroupSamples, nodeMetrics];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toolsFor(ctx: ObserverCtx): readonly ObserverTool<any>[] {
  return ctx.deps.getNodeMetrics ? OBSERVER_TOOLS : OBSERVER_TOOLS.filter((t) => t.name !== "node_metrics");
}

export { clampWindow, podWithinScope, scopeText } from "./scope";
export * from "./types";
