"use client";

import { useCallback, useState } from "react";

// Client half of the two-step gate. The server (@twizz-idp/actions) issues a
// nonce fingerprinted to (tool, args); we echo it back with the SAME args. We
// never mint or reuse a nonce ourselves — the gate would reject it anyway.

export type GateResult =
  | { denied: true; reason: string }
  | { confirmationRequired: true; summary: string; instruction: string; confirm: string }
  | { done: true; result: unknown }
  | { error: string };

export type GatePhase<R = unknown> =
  | { kind: "idle" }
  | { kind: "issuing" }
  | { kind: "awaiting"; summary: string; confirm: string }
  | { kind: "confirming"; summary: string }
  | { kind: "done"; result: R }
  | { kind: "denied"; reason: string }
  | { kind: "error"; message: string }
  /** the confirm call lost its response (network drop, proxy 5xx): the server may have
   * applied it — never report that as a failure */
  | { kind: "unknown"; message: string };

/** True when the server never answered with a tRPC error: the request may have run.
 * A tRPC error response carries `shape`; a dropped connection ("Failed to fetch", nginx
 * 499) or a non-JSON proxy reply (502/504) does not. */
export function responseLost(e: unknown): boolean {
  return !(e && typeof e === "object" && "shape" in e && (e as { shape?: unknown }).shape);
}

/** The write may have happened: done, or confirm outcome unknown. Callers refresh on this. */
export function mayHaveWritten(phase: GatePhase<unknown>): boolean {
  return phase.kind === "done" || phase.kind === "unknown";
}

export function useGatedAction<A extends object, R = unknown>(run: (args: A & { confirm?: string }) => Promise<GateResult>) {
  const [phase, setPhase] = useState<GatePhase<R>>({ kind: "idle" });
  const [args, setArgs] = useState<A | null>(null);

  const settle = useCallback((r: GateResult): GatePhase<R> => {
    if ("denied" in r) return { kind: "denied", reason: r.reason };
    if ("error" in r) return { kind: "error", message: r.error };
    if ("confirmationRequired" in r) return { kind: "awaiting", summary: r.summary, confirm: r.confirm };
    return { kind: "done", result: r.result as R };
  }, []);

  /** Step 1: ask the gate. Returns the summary + nonce (or a denial). */
  const request = useCallback(
    async (a: A) => {
      setArgs(a);
      setPhase({ kind: "issuing" });
      try {
        setPhase(settle(await run({ ...a })));
      } catch (e) {
        setPhase({ kind: "error", message: (e as Error).message ?? String(e) });
      }
    },
    [run, settle],
  );

  /** Step 2: the human clicked Ember. Same args + the issued nonce. */
  const confirm = useCallback(async () => {
    if (phase.kind !== "awaiting" || !args) return;
    setPhase({ kind: "confirming", summary: phase.summary });
    try {
      setPhase(settle(await run({ ...args, confirm: phase.confirm })));
    } catch (e) {
      const message = (e as Error).message ?? String(e);
      setPhase(responseLost(e) ? { kind: "unknown", message } : { kind: "error", message });
    }
  }, [args, phase, run, settle]);

  const reset = useCallback(() => {
    setPhase({ kind: "idle" });
    setArgs(null);
  }, []);

  return { phase, request, confirm, reset };
}
