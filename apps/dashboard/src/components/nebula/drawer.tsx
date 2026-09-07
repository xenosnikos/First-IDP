"use client";

import { useEffect, type ReactNode } from "react";

/** Right-hand drawer on the plate (spin-up wizard). */
export function Drawer({ open, onClose, title, children, width = 520 }: { open: boolean; onClose: () => void; title: string; children: ReactNode; width?: number }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex", justifyContent: "flex-end" }}>
      <div onClick={onClose} style={{ position: "absolute", inset: 0, background: "color-mix(in oklab, var(--n-plate) 70%, transparent)" }} />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{
          position: "relative",
          width: `min(${width}px, 100vw)`,
          height: "100%",
          background: "var(--n-surface)",
          borderLeft: "1px solid var(--n-hairline)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: "1px solid var(--n-hairline)" }}>
          <h2 className="n-display" style={{ fontSize: 20, margin: 0 }}>{title}</h2>
          <button onClick={onClose} aria-label="Close" style={{ background: "none", border: "1px solid var(--n-hairline-strong)", color: "var(--n-ink-muted)", borderRadius: 3, padding: "2px 8px", cursor: "pointer", fontFamily: "inherit" }}>
            esc
          </button>
        </header>
        <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>{children}</div>
      </aside>
    </div>
  );
}
