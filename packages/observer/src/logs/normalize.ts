import { detectLevel, type Level } from "./level";

/** The shape @twizz-idp/core's getPodLogs returns (duplicated here so this
 * package stays dependency-free; structurally identical). */
export type LogLine = { timestamp: string; message: string; podName: string; containerName: string };

export type NormLine = {
  ts: string;
  pod: string;
  container: string;
  level: Level;
  context?: string;
  continuation: boolean;
  /** ANSI-stripped text; for Nest lines the prefix is removed. */
  text: string;
  /** Original message with only ANSI stripped (for display). */
  display: string;
};

export function normalizeLine(raw: LogLine): NormLine {
  const info = detectLevel(raw.message ?? "");
  return {
    ts: raw.timestamp,
    pod: raw.podName,
    container: raw.containerName,
    level: info.level,
    context: info.context,
    continuation: info.continuation,
    text: info.body,
    display: info.body === "" ? "" : raw.message.replace(/\x1b\[[0-9;]*m/g, ""),
  };
}

export type LogRecord = NormLine & { continuationLines: string[]; omitted: number };

const MAX_FOLD = 60;
const FOLD_WINDOW_MS = 5_000;
/** Head line for continuation lines whose parent is older than the fetch. */
export const ORPHAN_HEAD = "(continuation lines whose head line is older than the fetched window)";

/** Fold stack frames / dump lines into the preceding record of the same
 * pod+container when they arrive within a few seconds. Never across pods.
 * Input must be chronological. */
export function joinMultiline(lines: NormLine[]): LogRecord[] {
  const out: LogRecord[] = [];
  const lastByKey = new Map<string, LogRecord>();
  for (const l of lines) {
    const key = `${l.pod}|${l.container}`;
    const parent = lastByKey.get(key);
    const ts = Date.parse(l.ts);
    if (l.continuation && parent && Math.abs(ts - Date.parse(parent.ts)) <= FOLD_WINDOW_MS) {
      if (parent.continuationLines.length < MAX_FOLD) parent.continuationLines.push(l.text);
      else parent.omitted++;
      continue;
    }
    if (l.continuation) {
      // No parent in range: one synthetic record per pod collects the orphans
      // instead of every frame becoming its own group.
      const rec: LogRecord = { ...l, level: "UNKNOWN", continuation: false, text: ORPHAN_HEAD, continuationLines: [l.text], omitted: 0 };
      out.push(rec);
      lastByKey.set(key, rec);
      continue;
    }
    const rec: LogRecord = { ...l, continuation: false, continuationLines: [], omitted: 0 };
    out.push(rec);
    lastByKey.set(key, rec);
  }
  return out;
}

/** Colour/level helpers for the UI: continuation lines inherit their parent. */
export function assignDisplayLevels(lines: NormLine[]): Array<NormLine & { effectiveLevel: Level }> {
  const lastByKey = new Map<string, Level>();
  return lines.map((l) => {
    const key = `${l.pod}|${l.container}`;
    if (l.continuation) return { ...l, effectiveLevel: lastByKey.get(key) ?? "UNKNOWN" };
    lastByKey.set(key, l.level);
    return { ...l, effectiveLevel: l.level };
  });
}
