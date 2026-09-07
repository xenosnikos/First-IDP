import type { CSSProperties } from "react";
import { toneOf, type StatusWord, type Tone } from "@/lib/nebula/status";

// The brand's status pill: a WORD in its colour. There is no "dot" variant on
// purpose — a colour never appears without its word.

const TONE_VAR: Record<Tone, string> = {
  ion: "var(--n-ion)",
  pass: "var(--n-pass)",
  fail: "var(--n-fail)",
  pending: "var(--n-pending)",
  ember: "var(--n-ember)",
  muted: "var(--n-ink-muted)",
};

export function Pill({ word, title, style }: { word: StatusWord; title?: string; style?: CSSProperties }) {
  const colour = TONE_VAR[toneOf(word)];
  return (
    <span
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "1px 7px",
        border: `1px solid color-mix(in oklab, ${colour} 55%, transparent)`,
        borderRadius: 3,
        color: colour,
        background: `color-mix(in oklab, ${colour} 12%, transparent)`,
        fontSize: 10,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        whiteSpace: "nowrap",
        lineHeight: "16px",
        ...style,
      }}
    >
      {word}
    </span>
  );
}
