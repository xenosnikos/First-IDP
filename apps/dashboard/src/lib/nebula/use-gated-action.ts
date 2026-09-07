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
  | { kind: "error"; message: string };

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
      setPhase({ kind: "error", message: (e as Error).message ?? String(e) });
    }
  }, [args, phase, run, settle]);

  const reset = useCallback(() => {
    setPhase({ kind: "idle" });
    setArgs(null);
  }, []);

  return { phase, request, confirm, reset };
}
