"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Pill } from "@/components/nebula/pill";
import type { StatusWord } from "@/lib/nebula/status";

// Nebula nav. Honest status per surface: the Environments grid + gate are
// SHIPPED (Phase 0); introspection routes are SHIPPED read-only; the six
// agents stay STUB and are shown as such rather than hidden.
// One line each (docs/NEBULA.md §N3.4) — shown as the title tooltip.
const NAV: { href: string; label: string; word: StatusWord; blurb: string }[] = [
  { href: "/environments", label: "Environments", word: "SHIPPED", blurb: "what is running on non-prod" },
  { href: "/projects", label: "Projects", word: "SHIPPED", blurb: "repos & what the platform knows about them" },
  { href: "/pipelines", label: "Pipelines", word: "SHIPPED", blurb: "CI runs" },
  { href: "/clusters", label: "Clusters", word: "SHIPPED", blurb: "pods + logs across all three clusters (observe-only for staging/prod)" },
];

const NORTH_STAR: { label: string; word: StatusWord }[] = [
  { label: "Agents", word: "STUB" },
  { label: "Release train", word: "PLANNED" },
  { label: "Audit viewer", word: "PLANNED" },
];

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside style={{ width: 208, flexShrink: 0, display: "flex", flexDirection: "column", borderRight: "1px solid var(--n-hairline)", background: "var(--n-surface)" }}>
      <div style={{ height: 56, display: "flex", alignItems: "center", padding: "0 18px", borderBottom: "1px solid var(--n-hairline)" }}>
        <Link href="/environments" className="n-display" style={{ fontSize: 22, color: "var(--n-ink)", textDecoration: "none", letterSpacing: "0.01em" }}>
          Nebula
        </Link>
        <span className="n-label" style={{ marginLeft: 10, color: "var(--n-ink-faint)" }}>phase 0</span>
      </div>

      <nav style={{ padding: "12px 10px", display: "flex", flexDirection: "column", gap: 2 }}>
        {NAV.map((item) => {
          const active = pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              title={item.blurb}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "8px 10px",
                borderRadius: "var(--n-radius)",
                textDecoration: "none",
                fontSize: 12,
                color: active ? "var(--n-ion-soft)" : "var(--n-ink-muted)",
                background: active ? "color-mix(in oklab, var(--n-ion) 12%, transparent)" : "transparent",
                borderLeft: active ? "2px solid var(--n-ion)" : "2px solid transparent",
              }}
            >
              <span>{item.label}</span>
              <Pill word={item.word} />
            </Link>
          );
        })}
      </nav>

      <div style={{ padding: "8px 10px 0", borderTop: "1px solid var(--n-hairline)", marginTop: 4 }}>
        <div className="n-label" style={{ padding: "6px 10px 4px", color: "var(--n-ink-faint)" }}>north star</div>
        {NORTH_STAR.map((s) => (
          <div key={s.label} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 10px", fontSize: 12, color: "var(--n-ink-faint)" }}>
            <span>{s.label}</span>
            <Pill word={s.word} />
          </div>
        ))}
      </div>

      <div style={{ marginTop: "auto", padding: 14, borderTop: "1px solid var(--n-hairline)", fontSize: 10, color: "var(--n-ink-faint)", lineHeight: 1.5 }}>
        The human gate is Ember and is never auto-clicked.
      </div>
    </aside>
  );
}
