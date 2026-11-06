// Event-watch verdict (docs/NEBULA.md §N5.5), pure. OK / WATCH / ACT / UNKNOWN with reasons,
// and whether the evidence points at CAPACITY (only then may a scale-up be recommended).
import type { LiveAssessment } from "@twizz-idp/actions";

export type WatchInput = {
  peakRps: number;
  requests: number; // total requests in the window
  err5xx: number; // total 5xx in the window
  p95MsLast: number | null;
  nodes: { cpuAvgPct: number; cpuMaxPct: number } | null;
  maxPodMcpu: number | null; // hottest modelled workload's avg per-pod CPU, last minutes
  atPeak: LiveAssessment | null;
  atPeakPlus30: LiveAssessment | null;
  signals: Array<{ label: string; word: string }> | null;
  edgeData: boolean;
  podData: "complete" | "timeout" | "failed" | "expired";
};

export type WatchVerdict = { status: "OK" | "WATCH" | "ACT" | "UNKNOWN"; reasons: string[]; capacityEvidence: boolean; capacityShort: boolean; dataGaps: string[] };

export function watchVerdict(i: WatchInput): WatchVerdict {
  const dataGaps: string[] = [];
  if (!i.edgeData) dataGaps.push("no edge metrics in the window");
  if (i.podData !== "complete") dataGaps.push(`pod/node metrics ${i.podData}`);
  if (!i.atPeak) dataGaps.push("no capacity model for what runs (profile or live read missing)");
  if (i.signals === null) dataGaps.push("monitor signals unavailable");
  const unknownSignals = (i.signals ?? []).filter((s) => s.word === "UNKNOWN").map((s) => s.label);
  if (unknownSignals.length) dataGaps.push(`monitor UNKNOWN: ${unknownSignals.join(", ")}`);

  const errRate = i.requests > 0 ? i.err5xx / i.requests : 0;
  const capacityEvidence = i.atPeak?.verdict === "SATURATED" || (i.nodes?.cpuMaxPct ?? 0) >= 90 || (i.maxPodMcpu ?? 0) >= 900;
  const capacityShort = capacityEvidence || (i.atPeakPlus30 !== null && i.atPeakPlus30.verdict !== "OK");
  const hot = (i.signals ?? []).filter((s) => s.word === "HOT").map((s) => s.label);
  const watchSig = (i.signals ?? []).filter((s) => s.word === "WATCH").map((s) => s.label);

  const act: string[] = [];
  if (i.atPeak?.verdict === "SATURATED") act.push(`what runs is SATURATED at the current peak (${i.peakRps} req/s)`);
  if ((i.maxPodMcpu ?? 0) >= 900) act.push(`pods at ~${i.maxPodMcpu}m (one Node core)`);
  if ((i.nodes?.cpuMaxPct ?? 0) >= 90) act.push(`a node at ${i.nodes!.cpuMaxPct}% CPU`);
  if (i.p95MsLast !== null && i.p95MsLast > 1000) act.push(`p95 ${i.p95MsLast} ms`);
  if (errRate >= 0.02) act.push(`5xx ${(errRate * 100).toFixed(1)}% of requests`);
  if (hot.length) act.push(`monitor HOT: ${hot.join(", ")}`);

  const watch: string[] = [];
  if (i.atPeakPlus30 && i.atPeakPlus30.verdict !== "OK") watch.push(`no 30% margin over the current peak (${i.atPeakPlus30.verdict} at ${Math.round(i.peakRps * 1.3)} req/s)`);
  if (i.p95MsLast !== null && i.p95MsLast > 500) watch.push(`p95 ${i.p95MsLast} ms`);
  if (errRate >= 0.005 && errRate < 0.02) watch.push(`5xx ${(errRate * 100).toFixed(2)}% of requests`);
  if ((i.nodes?.cpuAvgPct ?? 0) >= 70) watch.push(`nodes at ${i.nodes!.cpuAvgPct}% avg CPU`);
  if (watchSig.length) watch.push(`monitor WATCH: ${watchSig.join(", ")}`);

  if (act.length) return { status: "ACT", reasons: act, capacityEvidence, capacityShort, dataGaps };
  if (!i.edgeData || !i.atPeak) return { status: "UNKNOWN", reasons: dataGaps.length ? dataGaps : ["insufficient data"], capacityEvidence, capacityShort, dataGaps };
  if (watch.length || dataGaps.length) return { status: "WATCH", reasons: [...watch, ...dataGaps.map((g) => `data gap: ${g}`)], capacityEvidence, capacityShort, dataGaps };
  return { status: "OK", reasons: [], capacityEvidence, capacityShort, dataGaps };
}
