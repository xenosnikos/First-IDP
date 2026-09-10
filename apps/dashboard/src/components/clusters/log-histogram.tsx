"use client";

import { Pill } from "@/components/nebula/pill";

// Lines per bin as inline SVG bars: Ion for bins, Ion-soft for the peak, the
// word next to it (a colour never appears without its word). No chart library.
export function LogHistogram({ bins, binMinutes, status, isFetching }: { bins: Array<{ t: string; n: number }>; binMinutes: number; status?: "complete" | "timeout" | "failed"; isFetching: boolean }) {
  if (isFetching) return <div style={{ fontSize: 11, color: "var(--n-ink-muted)", padding: "6px 0" }}><Pill word="RUNNING" /> counting lines per {binMinutes} min…</div>;
  if (status && status !== "complete") return <div style={{ fontSize: 11, color: "var(--n-ink-muted)", padding: "6px 0" }}><Pill word="UNKNOWN" /> histogram query {status === "timeout" ? "timed out" : "failed"} — volume unknown</div>;
  if (!status || bins.length === 0) return null;
  const total = bins.reduce((a, b) => a + b.n, 0);
  const peak = bins.reduce((a, b) => (b.n > a.n ? b : a), bins[0]);
  const max = Math.max(1, peak.n);
  const w = 6;
  const gap = 2;
  const h = 28;
  const hhmm = (t: string) => t.replace("T", " ").slice(11, 16);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "6px 0", fontSize: 11, color: "var(--n-ink-muted)", flexWrap: "wrap" }}>
      <svg width={bins.length * (w + gap)} height={h} viewBox={`0 0 ${bins.length * (w + gap)} ${h}`} role="img" aria-label={`lines per ${binMinutes} minutes`} style={{ display: "block", flexShrink: 0 }}>
        {bins.map((b, i) => {
          const bh = Math.max(1, Math.round((b.n / max) * (h - 2)));
          return (
            <rect key={b.t + i} x={i * (w + gap)} y={h - bh} width={w} height={bh} fill={b === peak ? "var(--n-ion-soft)" : "var(--n-ion)"} rx={1}>
              <title>{`${hhmm(b.t)} UTC · ${b.n.toLocaleString()} lines`}</title>
            </rect>
          );
        })}
      </svg>
      <span>
        lines per {binMinutes} min · peak <span style={{ color: "var(--n-ion-soft)" }}>{peak.n.toLocaleString()}</span> at {hhmm(peak.t)} UTC · {total.toLocaleString()} total
      </span>
    </div>
  );
}
