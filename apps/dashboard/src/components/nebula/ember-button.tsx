"use client";

import type { ButtonHTMLAttributes } from "react";

// Ember is the human gate ONLY (docs/NEBULA.md §2). This is the only
// component that may paint Ember, and it is never auto-clicked — it is the one
// step Nebula never takes for you.
export function EmberButton({ children, style, disabled, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      disabled={disabled}
      style={{
        fontFamily: "inherit",
        fontSize: 11,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        padding: "9px 16px",
        borderRadius: "var(--n-radius)",
        border: "1px solid var(--n-ember-deep)",
        background: disabled ? "color-mix(in oklab, var(--n-ember) 25%, transparent)" : "var(--n-ember)",
        color: disabled ? "var(--n-ink-muted)" : "var(--n-ember-ink)",
        cursor: disabled ? "not-allowed" : "pointer",
        ...style,
      }}
    >
      {children}
    </button>
  );
}
