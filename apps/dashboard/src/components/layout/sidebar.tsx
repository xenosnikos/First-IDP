"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

// Nebula nav. One line per surface (docs/NEBULA.md §N3.4) as the tooltip.
// Collapses to a 56 px rail (glyph per surface); the choice is remembered
// per browser. The Escape-free toggle sits under the wordmark so it stays
// reachable in both states.
const NAV: { href: string; label: string; glyph: string; blurb: string }[] = [
  { href: "/environments", label: "Environments", glyph: "En", blurb: "what is running on non-prod" },
  { href: "/projects", label: "Projects", glyph: "Pr", blurb: "repos & what the platform knows about them" },
  { href: "/pipelines", label: "Pipelines", glyph: "Pi", blurb: "CI runs" },
  { href: "/clusters", label: "Clusters", glyph: "Cl", blurb: "pods + logs across all three clusters (observe-only for staging/prod)" },
  { href: "/releases", label: "Release train", glyph: "Rt", blurb: "promote sentinel + admin from previews to staging by gitops PR (operators)" },
];

const STORAGE_KEY = "nebula.sidebar.collapsed";
const WIDTH_OPEN = 208;
const WIDTH_RAIL = 56;

export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  // Read the remembered state after mount so server and client render alike.
  useEffect(() => {
    try {
      if (window.localStorage.getItem(STORAGE_KEY) === "1") setCollapsed(true);
    } catch {
      /* storage unavailable: stay open */
    }
  }, []);

  const toggle = () => {
    setCollapsed((c) => {
      const next = !c;
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  return (
    <aside
      aria-label="Navigation"
      style={{
        width: collapsed ? WIDTH_RAIL : WIDTH_OPEN,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        borderRight: "1px solid var(--n-hairline)",
        background: "var(--n-surface)",
        transition: "width 160ms ease",
        overflow: "hidden",
      }}
    >
      <div style={{ height: 56, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: collapsed ? "center" : "flex-start", padding: collapsed ? 0 : "0 18px", borderBottom: "1px solid var(--n-hairline)" }}>
        <Link href="/environments" className="n-display" title="Nebula" style={{ fontSize: 22, color: "var(--n-ink)", textDecoration: "none", letterSpacing: "0.01em", whiteSpace: "nowrap" }}>
          {collapsed ? "N" : "Nebula"}
        </Link>
      </div>

      <nav style={{ padding: collapsed ? "12px 8px" : "12px 10px", display: "flex", flexDirection: "column", gap: 2 }}>
        {NAV.map((item) => {
          const active = pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              title={collapsed ? `${item.label} — ${item.blurb}` : item.blurb}
              aria-label={item.label}
              aria-current={active ? "page" : undefined}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: collapsed ? "center" : "flex-start",
                padding: collapsed ? "8px 0" : "8px 10px",
                borderRadius: "var(--n-radius)",
                textDecoration: "none",
                fontSize: 12,
                whiteSpace: "nowrap",
                color: active ? "var(--n-ion-soft)" : "var(--n-ink-muted)",
                background: active ? "color-mix(in oklab, var(--n-ion) 12%, transparent)" : "transparent",
                borderLeft: active ? "2px solid var(--n-ion)" : "2px solid transparent",
              }}
            >
              {collapsed ? <span style={{ fontSize: 11, letterSpacing: "0.06em" }}>{item.glyph}</span> : <span>{item.label}</span>}
            </Link>
          );
        })}
      </nav>

      <div style={{ marginTop: "auto", borderTop: "1px solid var(--n-hairline)" }}>
        {!collapsed && (
          <div style={{ padding: "12px 18px 4px", fontSize: 10, color: "var(--n-ink-faint)", lineHeight: 1.5 }}>The human gate is Ember and is never auto-clicked.</div>
        )}
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          title={collapsed ? "expand navigation" : "collapse navigation"}
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: collapsed ? "center" : "space-between",
            gap: 8,
            padding: collapsed ? "12px 0" : "10px 18px",
            background: "none",
            border: "none",
            cursor: "pointer",
            fontFamily: "inherit",
            fontSize: 10,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: "var(--n-ink-faint)",
            whiteSpace: "nowrap",
          }}
        >
          {!collapsed && <span>collapse</span>}
          <span aria-hidden style={{ fontSize: 12 }}>{collapsed ? "»" : "«"}</span>
        </button>
      </div>
    </aside>
  );
}
