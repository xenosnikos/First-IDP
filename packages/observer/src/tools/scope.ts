import { LOG_NAME_RE } from "./names";
import type { ObserverScope } from "./types";

/** A sub-window strictly inside the scope. Offsets are minutes from the
 * scope's `from` (fromOffsetMin) and `to` (toOffsetMin, negative = earlier). */
export function clampWindow(scope: ObserverScope, o: { fromOffsetMin?: number; toOffsetMin?: number } = {}): { from: Date; to: Date; clamped: boolean } {
  const lo = Date.parse(scope.from);
  const hi = Date.parse(scope.to);
  let from = lo + Math.max(0, o.fromOffsetMin ?? 0) * 60_000;
  let to = hi + Math.min(0, o.toOffsetMin ?? 0) * 60_000;
  let clamped = false;
  if (from < lo) { from = lo; clamped = true; }
  if (to > hi) { to = hi; clamped = true; }
  if (from >= to) { from = Math.max(lo, to - 60_000); clamped = true; }
  return { from: new Date(from), to: new Date(to), clamped };
}

/** The model may only narrow the pod, never widen it. Returns the pod to use
 * or an error string (data, not a throw). */
export function podWithinScope(scope: ObserverScope, pod?: string): { ok: true; pod?: string } | { ok: false; reason: string } {
  if (!pod) return { ok: true, pod: scope.pod };
  if (!LOG_NAME_RE.test(pod) || pod.length > 253) return { ok: false, reason: `pod "${pod}" is not a valid kubernetes name` };
  if (scope.pod && !pod.startsWith(scope.pod)) {
    return { ok: false, reason: `pod "${pod}" is outside the selected scope (${scope.pod}); the human chose the scope, you cannot widen it` };
  }
  return { ok: true, pod };
}

export function scopeText(scope: ObserverScope): string {
  return [`cluster=${scope.cluster}`, `namespace=${scope.namespace}`, scope.pod ? `pod=${scope.pod}` : "pod=(all in namespace)", `window=${scope.from} → ${scope.to}`].join("  ");
}
