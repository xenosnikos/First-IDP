"use client";

import type { ButtonHTMLAttributes } from "react";

// Non-gate buttons: Ion (primary) or quiet (hairline). Never Ember.
export function Button({
  variant = "quiet",
  children,
  style,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "ion" | "quiet" | "danger" }) {
  const base = {
    fontFamily: "inherit",
    fontSize: 11,
    letterSpacing: "0.1em",
    textTransform: "uppercase" as const,
    padding: "7px 12px",
    borderRadius: "var(--n-radius)",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
  };
  const look =
    variant === "ion"
      ? { border: "1px solid var(--n-ion)", background: "var(--n-ion)", color: "var(--n-ion-ink)" }
      : variant === "danger"
        ? { border: "1px solid color-mix(in oklab, var(--n-fail) 60%, transparent)", background: "transparent", color: "var(--n-fail)" }
        : { border: "1px solid var(--n-hairline-strong)", background: "transparent", color: "var(--n-ink)" };
  return (
    <button {...rest} disabled={disabled} style={{ ...base, ...look, ...style }}>
      {children}
    </button>
  );
}
