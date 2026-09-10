import { capLine, stripAnsi } from "./ansi";

export type Level = "FATAL" | "ERROR" | "WARN" | "INFO" | "DEBUG" | "VERBOSE" | "UNKNOWN";

export const LEVELS: readonly Level[] = ["FATAL", "ERROR", "WARN", "INFO", "DEBUG", "VERBOSE", "UNKNOWN"];

/** Higher = more severe. UNKNOWN sits between INFO and DEBUG on purpose:
 * an unlabelled line is usually application output, not chatter. */
export function severity(level: Level): number {
  switch (level) {
    case "FATAL": return 6;
    case "ERROR": return 5;
    case "WARN": return 4;
    case "INFO": return 3;
    case "UNKNOWN": return 2;
    case "DEBUG": return 1;
    case "VERBOSE": return 0;
  }
}

// `[Nest] 29  - 09/10/2026, 7:45:00 AM   DEBUG [TasksService] Cron running every 15 mins`
export const NEST_PREFIX = /^\[Nest\]\s+\d+\s+-\s+(.+?)\s+(LOG|ERROR|WARN|DEBUG|VERBOSE|FATAL)\s+(?:\[([^\]]*)\]\s+)?(.*)$/s;
const PINO_LEVEL = /^\s*\{.*"level"\s*:\s*("?)(\d+|fatal|error|warn|info|debug|trace)\1/is;
const GENERIC = /\b(FATAL|PANIC|ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE|VERBOSE)\b/;
const ERROR_SHAPES = /^(Traceback \(most recent call last\)|Unhandled(?:Promise)?Rejection|panic:|[A-Z][A-Za-z]*(?:Error|Exception)\b)/;
const CONTINUATION = /^(\s+at\s|\s{2,}\S|[}\]]|\s*\}|\s*\]|\s*\)|\s*Error:|\s*caused by)/i;

export type LevelInfo = {
  level: Level;
  /** Nest logger context, e.g. `TasksService`. */
  context?: string;
  /** Stack frames, object dumps, JSON tails: belongs to the previous record. */
  continuation: boolean;
  /** Text with ANSI stripped and (for Nest lines) the prefix removed. */
  body: string;
};

function pinoLevel(v: string): Level {
  const n = Number(v);
  if (!Number.isNaN(n)) return n >= 60 ? "FATAL" : n >= 50 ? "ERROR" : n >= 40 ? "WARN" : n >= 30 ? "INFO" : n >= 20 ? "DEBUG" : "VERBOSE";
  const u = v.toUpperCase();
  return u === "TRACE" ? "VERBOSE" : (LEVELS.includes(u as Level) ? (u as Level) : "UNKNOWN");
}

export function detectLevel(raw: string): LevelInfo {
  const text = capLine(stripAnsi(raw)).replace(/\s+$/, "");
  if (text.trim() === "") return { level: "UNKNOWN", continuation: true, body: "" };

  const nest = text.match(NEST_PREFIX);
  if (nest) {
    const word = nest[2] === "LOG" ? "INFO" : (nest[2] as Level);
    return { level: word, context: nest[3] || undefined, continuation: false, body: nest[4] };
  }
  const pino = text.match(PINO_LEVEL);
  if (pino) return { level: pinoLevel(pino[2]), continuation: false, body: text };

  if (CONTINUATION.test(text) && !ERROR_SHAPES.test(text.trim())) {
    return { level: "UNKNOWN", continuation: true, body: text };
  }
  const head = text.slice(0, 40);
  const g = head.match(GENERIC);
  if (g) {
    const w = g[1].toUpperCase();
    const level: Level = w === "PANIC" ? "FATAL" : w === "WARNING" ? "WARN" : w === "TRACE" ? "VERBOSE" : (w as Level);
    return { level, continuation: false, body: text };
  }
  if (/^panic:/i.test(text.trim())) return { level: "FATAL", continuation: false, body: text };
  if (ERROR_SHAPES.test(text.trim())) return { level: "ERROR", continuation: false, body: text };
  return { level: "UNKNOWN", continuation: false, body: text };
}

export function isErrorLevel(level: Level): boolean {
  return level === "ERROR" || level === "FATAL";
}
