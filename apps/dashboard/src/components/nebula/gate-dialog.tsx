"use client";

import type { ReactNode } from "react";
import { Pill } from "./pill";
import { EmberButton } from "./ember-button";
import { Button } from "./button";
import type { GatePhase } from "@/lib/nebula/use-gated-action";

/** The human gate, as a modal. Shows the SERVER's summary of what will
 * happen, then the Ember confirm — the one step Nebula never takes for you. */
export function GateDialog<R>({
  title,
  phase,
  onConfirm,
  onClose,
  renderResult,
  inline,
}: {
  title: string;
  phase: GatePhase<R>;
  onConfirm: () => void;
  onClose: () => void;
  renderResult?: (r: R) => ReactNode;
  /** render without the modal chrome (inside the wizard drawer) */
  inline?: boolean;
}) {
  if (phase.kind === "idle") return null;

  const body = (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
        <h3 className="n-display" style={{ fontSize: 20, margin: 0 }}>{title}</h3>
        {phase.kind === "issuing" && <Pill word="PENDING" />}
        {phase.kind === "awaiting" && <Pill word="AWAITING HUMAN" />}
        {phase.kind === "confirming" && <Pill word="RUNNING" />}
        {phase.kind === "done" && <Pill word="PASS" />}
        {phase.kind === "denied" && <Pill word="DENIED" />}
        {phase.kind === "error" && <Pill word="FAIL" />}
      </div>

      {phase.kind === "issuing" && <p style={{ color: "var(--n-ink-muted)" }}>Asking the gate (policy → nonce)…</p>}

      {(phase.kind === "awaiting" || phase.kind === "confirming") && (
        <>
          <div className="n-label" style={{ marginBottom: 6 }}>the server will</div>
          <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", margin: "0 0 14px", padding: 12, background: "var(--n-plate)", border: "1px solid var(--n-hairline)", borderRadius: "var(--n-radius)", fontSize: 12, lineHeight: 1.5 }}>
            {phase.summary}
          </pre>
          <p style={{ color: "var(--n-ink-muted)", fontSize: 11, margin: "0 0 14px" }}>
            Policy allowed it. A single-use token was issued for exactly these arguments and expires in 5 minutes. Nothing has been written yet.
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button onClick={onClose} disabled={phase.kind === "confirming"}>Cancel</Button>
            <EmberButton onClick={onConfirm} disabled={phase.kind === "confirming"}>
              {phase.kind === "confirming" ? "Writing…" : "Confirm"}
            </EmberButton>
          </div>
        </>
      )}

      {phase.kind === "denied" && (
        <>
          <p style={{ color: "var(--n-fail)", margin: "0 0 14px", wordBreak: "break-word" }}>{phase.reason}</p>
          <div style={{ display: "flex", justifyContent: "flex-end" }}><Button onClick={onClose}>Close</Button></div>
        </>
      )}

      {phase.kind === "error" && (
        <>
          <p style={{ color: "var(--n-fail)", margin: "0 0 14px", wordBreak: "break-word" }}>{phase.message}</p>
          <p style={{ color: "var(--n-ink-muted)", fontSize: 11, margin: "0 0 14px" }}>The gate fails closed: the audit row records the failure and nothing partial is retried on your behalf.</p>
          <div style={{ display: "flex", justifyContent: "flex-end" }}><Button onClick={onClose}>Close</Button></div>
        </>
      )}

      {phase.kind === "done" && (
        <>
          {renderResult ? renderResult(phase.result) : (
            <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", margin: "0 0 14px", padding: 12, background: "var(--n-plate)", border: "1px solid var(--n-hairline)", borderRadius: "var(--n-radius)", fontSize: 11 }}>
              {JSON.stringify(phase.result, null, 2)}
            </pre>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end" }}><Button variant="ion" onClick={onClose}>Done</Button></div>
        </>
      )}
    </div>
  );

  if (inline) return <div className="n-plate" style={{ padding: 16 }}>{body}</div>;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 60, display: "grid", placeItems: "center", padding: 16 }}>
      <div onClick={phase.kind === "confirming" ? undefined : onClose} style={{ position: "absolute", inset: 0, background: "color-mix(in oklab, var(--n-plate) 75%, transparent)" }} />
      <div role="dialog" aria-modal="true" className="n-plate" style={{ position: "relative", width: "min(560px, 100%)", padding: 20 }}>
        {body}
      </div>
    </div>
  );
}
