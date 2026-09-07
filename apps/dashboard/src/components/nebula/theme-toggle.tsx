"use client";

import { useEffect, useState } from "react";

type Theme = "system" | "dark" | "light";

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");

  useEffect(() => {
    try {
      const t = localStorage.getItem("nebula-theme");
      if (t === "dark" || t === "light") setTheme(t);
    } catch {}
  }, []);

  const apply = (t: Theme) => {
    setTheme(t);
    try {
      if (t === "system") {
        localStorage.removeItem("nebula-theme");
        document.documentElement.removeAttribute("data-theme");
      } else {
        localStorage.setItem("nebula-theme", t);
        document.documentElement.setAttribute("data-theme", t);
      }
    } catch {}
  };

  const next: Theme = theme === "system" ? "dark" : theme === "dark" ? "light" : "system";
  const label = theme === "system" ? "auto" : theme === "dark" ? "plate" : "paper";
  return (
    <button
      onClick={() => apply(next)}
      title={`theme: ${label} (click for ${next})`}
      style={{ background: "none", border: "1px solid var(--n-hairline-strong)", color: "var(--n-ink-muted)", borderRadius: 3, padding: "2px 8px", fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", cursor: "pointer", fontFamily: "inherit" }}
    >
      {label}
    </button>
  );
}
