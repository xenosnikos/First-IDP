// CloudWatch Logs Insights query builders for Container Insights application
// logs. Pure and dependency-free so the escaping rules are unit-tested and
// shared by every caller (dashboard clusters router, Observer tools, MCP).

/** Kubernetes namespace / pod names: DNS-1123 labels plus dots. */
export const LOG_NAME_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

export type InsightsStatus = "complete" | "timeout" | "failed";

/** Escape a value for an Insights `"…"` string literal. */
export function quoteString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Escape a user regex for an Insights `/…/` literal: only `/` needs care
 * (the user's own regex syntax is passed through). Newlines are dropped. */
export function regexLiteral(s: string): string {
  return `/${s.replace(/[\r\n]/g, " ").replace(/\\\//g, "/").replace(/\//g, "\\/")}/`;
}

/** Cheap guard against catastrophic backtracking: nested quantifiers. */
export function isSafeRegex(s: string): boolean {
  return !/(\+|\*|\{\d*,?\d*\})\s*[)\]]?\s*(\+|\*|\{)/.test(s) && s.length <= 200;
}

export type LogsQueryParams = {
  namespace: string;
  podName?: string;
  containerName?: string;
  /** Regex applied to the log text AND the pod name (either matches). */
  filter?: string;
  limit: number;
};

export function buildLogsQuery(p: LogsQueryParams): string {
  const parts = [
    "fields @timestamp, log, kubernetes.pod_name, kubernetes.container_name",
    `filter kubernetes.namespace_name = ${quoteString(p.namespace)}`,
  ];
  if (p.podName) parts.push(`filter kubernetes.pod_name like ${quoteString(p.podName)}`);
  if (p.containerName) parts.push(`filter kubernetes.container_name = ${quoteString(p.containerName)}`);
  if (p.filter) {
    const re = regexLiteral(p.filter);
    parts.push(`filter (log like ${re} or kubernetes.pod_name like ${re})`);
  }
  parts.push("sort @timestamp desc", `limit ${Math.max(1, Math.floor(p.limit))}`);
  return parts.join("\n| ");
}

export type HistogramQueryParams = {
  namespace: string;
  podName?: string;
  filter?: string;
  binMinutes: number;
};

export function buildHistogramQuery(p: HistogramQueryParams): string {
  const parts = [`filter kubernetes.namespace_name = ${quoteString(p.namespace)}`];
  if (p.podName) parts.push(`filter kubernetes.pod_name like ${quoteString(p.podName)}`);
  if (p.filter) {
    const re = regexLiteral(p.filter);
    parts.push(`filter (log like ${re} or kubernetes.pod_name like ${re})`);
  }
  const m = Math.max(1, Math.floor(p.binMinutes));
  parts.push(`stats count(*) as n by bin(${m}m) as t`, "sort t asc");
  return parts.join("\n| ");
}
