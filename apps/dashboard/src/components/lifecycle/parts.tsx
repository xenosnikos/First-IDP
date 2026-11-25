import type { CSSProperties, ReactNode } from "react";
import { Pill } from "@/components/nebula/pill";
import { isProdEnv, safeExternalHref, type LifecycleTab } from "@/lib/nebula/lifecycle";

// Small building blocks shared by the /lifecycle panes. Same look as the
// other Nebula surfaces: plates, hairlines, 10 px small-caps labels, inline
// styles on the brand tokens. Nothing here paints a colour without its word.

export const label: CSSProperties = { fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--n-ink-faint)" };
export const muted: CSSProperties = { fontSize: 11, color: "var(--n-ink-muted)" };
export const linkStyle: CSSProperties = { color: "var(--n-ion-soft)", textDecoration: "none", whiteSpace: "nowrap" };
export const tableStyle: CSSProperties = { width: "100%", fontSize: 12, borderCollapse: "collapse" };
export const thStyle: CSSProperties = { ...label, fontWeight: 400, textAlign: "left", padding: "4px 10px 6px 0", whiteSpace: "nowrap", verticalAlign: "bottom" };
export const tdStyle: CSSProperties = { padding: "7px 10px 7px 0", verticalAlign: "top", minWidth: 0 };
export const rowStyle: CSSProperties = { borderTop: "1px solid var(--n-hairline)" };

/** what every pane gets from the view */
export type PaneNav = { goTo: (tab: LifecycleTab) => void };

export function Section({ title, right, children, style }: { title: string; right?: ReactNode; children: ReactNode; style?: CSSProperties }) {
  return (
    <section className="n-plate" style={{ padding: 16, minWidth: 0, ...style }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, paddingBottom: 10, marginBottom: 8, borderBottom: "1px solid var(--n-hairline)", flexWrap: "wrap" }}>
        <h2 className="n-display" style={{ fontSize: 18, margin: 0, fontWeight: 400 }}>{title}</h2>
        {right}
      </header>
      {children}
    </section>
  );
}

/** A link that leaves Nebula: Ion-soft, no underline, ↗. The target is checked
 * HERE as well as at ingest (`safeExternalHref`: https, an allowlisted host):
 * anything else is shown as plain text with the reason, never as a link — so
 * a `javascript:` URL cannot break the render and a look-alike host cannot be
 * clicked. */
export function Ext({ href, children, title }: { href: string | null | undefined; children: ReactNode; title?: string }) {
  const safe = safeExternalHref(href);
  if (!safe) return <span title="no link: the address is not an https URL on a host Nebula links to" style={{ whiteSpace: "nowrap" }}>{children}</span>;
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer" title={title} style={linkStyle}>
      {children} ↗
    </a>
  );
}

/** A neutral tag (an environment, an alias): hairline, no colour. */
export function Chip({ children, title, strong }: { children: ReactNode; title?: string; strong?: boolean }) {
  return (
    <span
      title={title}
      style={{
        display: "inline-block",
        fontSize: 10,
        lineHeight: "16px",
        padding: "0 6px",
        border: `1px solid ${strong ? "var(--n-ink-muted)" : "var(--n-hairline-strong)"}`,
        borderRadius: 3,
        color: strong ? "var(--n-ink)" : "var(--n-ink-muted)",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

/** Environment names as chips; a production environment is drawn stronger
 * (ink, not a colour) so "this reaches prod" is visible in a long table. */
export function EnvChips({ names }: { names: readonly string[] }) {
  if (names.length === 0) return <span style={{ color: "var(--n-ink-faint)" }}>—</span>;
  return (
    <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
      {names.map((n) => (
        <Chip key={n} strong={isProdEnv(n)} title={isProdEnv(n) ? `${n}: a production environment` : n}>
          {n}
        </Chip>
      ))}
    </span>
  );
}

/** Running text inside a plate `Row` (which breaks anywhere, for tags and shas): break between words. */
export function Prose({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <span style={{ wordBreak: "normal", overflowWrap: "anywhere", lineHeight: 1.5, ...style }}>{children}</span>;
}

export const listStyle: CSSProperties = { margin: 0, paddingLeft: 18, lineHeight: 1.7, fontSize: 12, listStyle: "disc" };

/** A sub-source that failed, as data: the pane stays up, this says what is missing. */
export function Err({ what, msg }: { what: string; msg: string }) {
  return (
    <div role="alert" style={{ fontSize: 11, color: "var(--n-ink-muted)", display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
      <Pill word="FAIL" /> <span style={{ wordBreak: "break-word" }}>{what}: {msg}</span>
    </div>
  );
}

/** A full-width notice above a pane (stale data, a failed latest run). */
export function Notice({ word, children }: { word: "WATCH" | "FAIL" | "UNKNOWN"; children: ReactNode }) {
  return (
    <div className="n-plate" role="status" style={{ padding: "10px 12px", marginBottom: 12, display: "flex", gap: 10, alignItems: "baseline", fontSize: 12, lineHeight: 1.6 }}>
      <Pill word={word} />
      <span style={{ minWidth: 0, wordBreak: "break-word" }}>{children}</span>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="n-plate" style={{ padding: 28, textAlign: "center" }}>
      <div className="n-display" style={{ fontSize: 20, marginBottom: 8 }}>{title}</div>
      <div style={{ color: "var(--n-ink-muted)", lineHeight: 1.7, maxWidth: 720, margin: "0 auto" }}>{children}</div>
    </div>
  );
}

/** A filter option drawn as a pressed/unpressed button (real button, aria-pressed). */
export function Toggle({ on, onClick, children, title }: { on: boolean; onClick: () => void; children: ReactNode; title?: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      title={title}
      style={{
        fontFamily: "inherit",
        fontSize: 11,
        padding: "4px 9px",
        cursor: "pointer",
        borderRadius: "var(--n-radius)",
        border: `1px solid ${on ? "var(--n-ion)" : "var(--n-hairline-strong)"}`,
        background: on ? "color-mix(in oklab, var(--n-ion) 14%, transparent)" : "transparent",
        color: on ? "var(--n-ink)" : "var(--n-ink-muted)",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}

export const selectStyle: CSSProperties = {
  fontFamily: "inherit",
  fontSize: 11,
  padding: "4px 8px",
  background: "var(--n-plate)",
  border: "1px solid var(--n-hairline-strong)",
  borderRadius: "var(--n-radius)",
  color: "var(--n-ink)",
};

export function FilterGroup({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={name} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      <span style={label}>{name}</span>
      {children}
    </div>
  );
}
