// URL ⇄ state for the Clusters logs panel so a log view can be shared.
// Params: c=cluster ns=namespace pod=pod w=minutes q=filter err=1

export const WINDOW_OPTIONS = [15, 30, 60, 180, 720, 1440] as const;

export type LogsUrlState = { cluster: string; namespace: string; pod?: string; minutesBack: number; filter: string; errorsOnly: boolean };

export function encodeLogsState(s: LogsUrlState): string {
  const p = new URLSearchParams();
  p.set("c", s.cluster);
  p.set("ns", s.namespace);
  if (s.pod) p.set("pod", s.pod);
  p.set("w", String(s.minutesBack));
  if (s.filter) p.set("q", s.filter);
  if (s.errorsOnly) p.set("err", "1");
  return p.toString();
}

const NAME = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

export function decodeLogsState(sp: URLSearchParams | string, clusters: readonly string[]): LogsUrlState | null {
  const p = typeof sp === "string" ? new URLSearchParams(sp) : sp;
  const cluster = p.get("c") ?? "";
  const namespace = p.get("ns") ?? "";
  if (!clusters.includes(cluster) || !NAME.test(namespace) || namespace.length > 63) return null;
  const pod = p.get("pod") ?? undefined;
  const w = Number(p.get("w") ?? 30);
  const minutesBack = (WINDOW_OPTIONS as readonly number[]).includes(w) ? w : 30;
  return {
    cluster,
    namespace,
    pod: pod && NAME.test(pod) && pod.length <= 253 ? pod : undefined,
    minutesBack,
    filter: (p.get("q") ?? "").slice(0, 200),
    errorsOnly: p.get("err") === "1",
  };
}
