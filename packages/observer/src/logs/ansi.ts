// ANSI colour codes as emitted by NestJS' logger (and most CLIs).
export const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Hard cap applied before any regex touches a line: bounds backtracking. */
export const MAX_LINE_CHARS = 4000;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

export function capLine(s: string): string {
  return s.length > MAX_LINE_CHARS ? s.slice(0, MAX_LINE_CHARS) + " …[+" + (s.length - MAX_LINE_CHARS) + " chars]" : s;
}
