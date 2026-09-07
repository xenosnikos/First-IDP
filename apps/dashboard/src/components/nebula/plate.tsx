import type { CSSProperties, ReactNode } from "react";

/** A catalogue plate: surface + hairline, no shadow. */
export function Plate({ children, style, as: Tag = "section" }: { children: ReactNode; style?: CSSProperties; as?: "section" | "div" | "article" }) {
  return (
    <Tag className="n-plate" style={style}>
      {children}
    </Tag>
  );
}

/** A labelled row on a plate: `label · value`, hairline underneath. */
export function Row({ label, children, last }: { label: string; children: ReactNode; last?: boolean }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "84px 1fr",
        gap: 12,
        alignItems: "baseline",
        padding: "7px 0",
        borderBottom: last ? "none" : "1px solid var(--n-hairline)",
        minWidth: 0,
      }}
    >
      <span className="n-label">{label}</span>
      <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0, wordBreak: "break-all" }}>{children}</span>
    </div>
  );
}

export function PageHeader({ title, kicker, children }: { title: string; kicker?: string; children?: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, marginBottom: 24, flexWrap: "wrap" }}>
      <div>
        {kicker && <div className="n-label" style={{ marginBottom: 6 }}>{kicker}</div>}
        <h1 className="n-display" style={{ fontSize: 30, lineHeight: 1.1, margin: 0 }}>
          {title}
        </h1>
      </div>
      {children && <div style={{ display: "flex", gap: 8, alignItems: "center" }}>{children}</div>}
    </div>
  );
}

export function Muted({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <span style={{ color: "var(--n-ink-muted)", ...style }}>{children}</span>;
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label style={{ display: "block", marginBottom: 14 }}>
      <div className="n-label" style={{ marginBottom: 6 }}>{label}</div>
      {children}
      {hint && <div style={{ color: "var(--n-ink-muted)", fontSize: 11, marginTop: 6, lineHeight: 1.5 }}>{hint}</div>}
    </label>
  );
}

export const inputStyle: CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  background: "var(--n-plate)",
  border: "1px solid var(--n-hairline-strong)",
  borderRadius: "var(--n-radius)",
  color: "var(--n-ink)",
  fontSize: 12,
  outline: "none",
};
