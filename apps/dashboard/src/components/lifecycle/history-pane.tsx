"use client";

import { Pill } from "@/components/nebula/pill";
import { fmtTook, fmtUtcStamp, relTime, requestWord, type LifecycleHistory } from "@/lib/nebula/lifecycle";
import { Section, muted, rowStyle, tableStyle, tdStyle, thStyle } from "./parts";

// History: every snapshot PLO posted and every on-demand request made here,
// newest first. Sixty snapshots per job are kept (older ones are pruned on
// ingest), so this is a recent log, not an archive.
export function HistoryPane({ view, now }: { view: LifecycleHistory; now: number }) {
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Section title="Snapshots received" right={<span style={muted}>{view.snapshots.length} most recent · the newest 60 per job are kept</span>}>
        {view.snapshots.length === 0 ? (
          <div style={{ color: "var(--n-ink-faint)", fontSize: 12 }}>Nothing received yet. A row appears here each time a PLO job finishes and posts its result.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ ...tableStyle, minWidth: 860 }}>
              <thead>
                <tr>
                  <th scope="col" style={thStyle}>job</th>
                  <th scope="col" style={thStyle}>run id</th>
                  <th scope="col" style={thStyle}>finished</th>
                  <th scope="col" style={thStyle}>took</th>
                  <th scope="col" style={thStyle}>trigger</th>
                  <th scope="col" style={thStyle}>result</th>
                  <th scope="col" style={{ ...thStyle, paddingRight: 0 }}>error</th>
                </tr>
              </thead>
              <tbody>
                {view.snapshots.map((s) => (
                  <tr key={s.id} style={rowStyle}>
                    <th scope="row" style={{ ...tdStyle, fontWeight: 400, textAlign: "left", whiteSpace: "nowrap" }}>{s.job}</th>
                    <td style={{ ...tdStyle, wordBreak: "break-all", maxWidth: 280 }}>{s.runId}</td>
                    <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                      <div>{fmtUtcStamp(s.finishedAt)}</div>
                      <div style={{ ...muted, marginTop: 2 }}>{relTime(s.finishedAt, now)}</div>
                    </td>
                    <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>{fmtTook(s.startedAt, s.finishedAt)}</td>
                    <td style={{ ...tdStyle, whiteSpace: "nowrap", color: "var(--n-ink-muted)" }} title={s.requestId ? `request ${s.requestId}` : undefined}>{s.requestId ? "on demand" : "scheduled"}</td>
                    <td style={tdStyle}><Pill word={s.ok ? "PASS" : "FAIL"} /></td>
                    <td style={{ ...tdStyle, paddingRight: 0, color: s.error ? "var(--n-fail)" : "var(--n-ink-faint)", wordBreak: "break-word", maxWidth: 360 }}>{s.error ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="On-demand requests" right={<span style={muted}>made by operators here; claimed by plo-dispatch every 5 minutes</span>}>
        {view.requests.length === 0 ? (
          <div style={{ color: "var(--n-ink-faint)", fontSize: 12 }}>No on-demand run has been requested yet.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ ...tableStyle, minWidth: 860 }}>
              <thead>
                <tr>
                  <th scope="col" style={thStyle}>request</th>
                  <th scope="col" style={thStyle}>status</th>
                  <th scope="col" style={thStyle}>requested</th>
                  <th scope="col" style={thStyle}>claimed</th>
                  <th scope="col" style={thStyle}>finished</th>
                  <th scope="col" style={thStyle}>run id</th>
                  <th scope="col" style={{ ...thStyle, paddingRight: 0 }}>error</th>
                </tr>
              </thead>
              <tbody>
                {view.requests.map((r) => (
                  <tr key={r.id} style={rowStyle}>
                    <th scope="row" style={{ ...tdStyle, fontWeight: 400, textAlign: "left", whiteSpace: "nowrap" }}>
                      {r.kind}
                      {r.scope ? <span style={{ color: "var(--n-ink-muted)" }}> · {r.scope === "stg" ? "staging" : "preview"}{r.bundleKey ? ` · bundle ${r.bundleKey.slice(0, 12)}` : ""}</span> : null}
                    </th>
                    <td style={tdStyle}><Pill word={requestWord(r.status)} /></td>
                    <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                      <div>{fmtUtcStamp(r.createdAt)}</div>
                      <div style={{ ...muted, marginTop: 2 }}>by {r.requestedBy} · {relTime(r.createdAt, now)}</div>
                    </td>
                    <td style={{ ...tdStyle, whiteSpace: "nowrap", color: r.claimedAt ? undefined : "var(--n-ink-faint)" }}>{r.claimedAt ? fmtUtcStamp(r.claimedAt) : "—"}</td>
                    <td style={{ ...tdStyle, whiteSpace: "nowrap", color: r.finishedAt ? undefined : "var(--n-ink-faint)" }}>{r.finishedAt ? fmtUtcStamp(r.finishedAt) : "—"}</td>
                    <td style={{ ...tdStyle, wordBreak: "break-all", maxWidth: 240, color: r.runId ? undefined : "var(--n-ink-faint)" }}>{r.runId ?? "—"}</td>
                    <td style={{ ...tdStyle, paddingRight: 0, color: r.error ? "var(--n-fail)" : "var(--n-ink-faint)", wordBreak: "break-word", maxWidth: 320 }}>{r.error ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}
