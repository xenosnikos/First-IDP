"use client";

import { Pill } from "@/components/nebula/pill";
import { Button } from "@/components/nebula/button";
import { cronLabel, fmtUtc, relTime, requestText, requestWord, type LifecycleOverview, type ScheduleRow } from "@/lib/nebula/lifecycle";
import { Section, label, muted, rowStyle, tableStyle, tdStyle, thStyle } from "./parts";

const RUNNER_TEXT: Record<ScheduleRow["runner"], string> = { nebula: "in-cluster CronJob", "github-actions": "GitHub Actions" };

function runTitle(row: ScheduleRow, operator: boolean): string {
  if (!operator) return "operators only";
  if (row.inFlight) return `a ${row.job} run is already requested (${row.inFlight.status})`;
  return `queue an on-demand ${row.job} run; plo-dispatch picks it up within about 5 minutes`;
}

// Schedule: what runs when, what it last said, and (operators) "Run now" for
// the two read-only jobs. The jobs that change clusters stay in GitHub Actions
// and never report here — the table says so instead of showing an empty cell.
export function SchedulePane({ overview, now, operator, onRun }: { overview: LifecycleOverview; now: number; operator: boolean; onRun: (job: "plan" | "cve") => void }) {
  const { schedule } = overview;
  return (
    <Section
      title="Schedule"
      right={
        <span style={muted}>
          {schedule.source === "snapshot" ? "as reported by PLO (config/inventory.yaml)" : "the designed schedule — PLO has not reported its own yet"} · all times UTC
        </span>
      }
    >
      <div style={{ overflowX: "auto" }}>
        <table style={{ ...tableStyle, minWidth: 980 }}>
          <caption style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>Platform lifecycle jobs, when each runs next and how its last run went</caption>
          <thead>
            <tr>
              <th scope="col" style={thStyle}>job</th>
              <th scope="col" style={thStyle}>what it does</th>
              <th scope="col" style={thStyle}>when</th>
              <th scope="col" style={thStyle}>next run</th>
              <th scope="col" style={thStyle}>last run</th>
              <th scope="col" style={thStyle}>result</th>
              <th scope="col" style={thStyle}>runs in</th>
              <th scope="col" style={{ ...thStyle, textAlign: "right", paddingRight: 0 }}>on demand</th>
            </tr>
          </thead>
          <tbody>
            {schedule.rows.map((row) => {
              const cron = cronLabel(row);
              const external = row.runner === "github-actions";
              return (
                <tr key={row.job} style={rowStyle}>
                  <th scope="row" style={{ ...tdStyle, fontWeight: 400, textAlign: "left", whiteSpace: "nowrap" }}>{row.job}</th>
                  <td style={{ ...tdStyle, maxWidth: 360 }}>
                    <div style={{ lineHeight: 1.5 }}>{row.description}</div>
                    <div style={{ ...muted, marginTop: 2 }}>{row.mutates ? "writes: opens pull requests or changes what it targets" : "read-only: reports, changes nothing"}</div>
                  </td>
                  <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                    {cron.error ? (
                      <span title={cron.error}><Pill word="UNKNOWN" /> <code>{cron.text}</code></span>
                    ) : (
                      <>
                        <div>{cron.text}</div>
                        {cron.raw && <div style={{ ...muted, marginTop: 2 }}><code>{cron.raw}</code></div>}
                      </>
                    )}
                  </td>
                  <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                    {row.nextRun ? (
                      <>
                        <div>{fmtUtc(row.nextRun)}</div>
                        <div style={{ ...muted, marginTop: 2 }}>{relTime(row.nextRun, now)}</div>
                      </>
                    ) : (
                      <span style={{ color: "var(--n-ink-faint)" }}>{row.cronError ?? "—"}</span>
                    )}
                  </td>
                  <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                    {row.lastRun ? (
                      <>
                        <div title={fmtUtc(row.lastRun.at)}>{relTime(row.lastRun.at, now)}</div>
                        <div style={{ ...muted, marginTop: 2 }}>{row.lastRun.requested ? "on demand" : "scheduled"}{row.lastRun.runId ? ` · ${row.lastRun.runId}` : ""}</div>
                      </>
                    ) : external ? (
                      <span style={{ color: "var(--n-ink-faint)" }} title="GitHub Actions jobs do not post snapshots to Nebula">not reported to Nebula</span>
                    ) : (
                      <span style={{ color: "var(--n-ink-faint)" }}>never</span>
                    )}
                  </td>
                  <td style={{ ...tdStyle, maxWidth: 260 }}>
                    {row.lastRun ? (
                      <>
                        <Pill word={row.lastRun.ok ? "PASS" : "FAIL"} />
                        {row.lastRun.error && <div style={{ fontSize: 11, color: "var(--n-fail)", marginTop: 4, wordBreak: "break-word" }}>{row.lastRun.error}</div>}
                      </>
                    ) : (
                      <span style={{ color: "var(--n-ink-faint)" }}>—</span>
                    )}
                  </td>
                  <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>{RUNNER_TEXT[row.runner]}</td>
                  <td style={{ ...tdStyle, textAlign: "right", paddingRight: 0, whiteSpace: "nowrap" }}>
                    {row.requestable ? (
                      <Button disabled={!operator || !!row.inFlight} title={runTitle(row, operator)} onClick={() => onRun(row.job as "plan" | "cve")} aria-label={`Run ${row.job} now`}>
                        Run now
                      </Button>
                    ) : (
                      <span style={{ color: "var(--n-ink-faint)", fontSize: 11 }} title={external ? "started from GitHub Actions, never from Nebula" : "scheduled only"}>—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {schedule.rows.some((r) => r.inFlight) && (
        <div style={{ marginTop: 14 }}>
          <div style={{ ...label, marginBottom: 6 }}>on-demand runs in flight</div>
          {schedule.rows
            .filter((r) => r.inFlight)
            .map((r) => (
              <div key={r.job} role="status" style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 12, padding: "3px 0", flexWrap: "wrap" }}>
                <Pill word={requestWord(r.inFlight!.status)} />
                <span>{r.job}</span>
                <span style={muted}>{requestText(r.inFlight!, now)}</span>
              </div>
            ))}
        </div>
      )}

      <p style={{ fontSize: 10, color: "var(--n-ink-faint)", margin: "14px 0 0", lineHeight: 1.7 }}>
        In-cluster jobs never change a cluster: infrastructure tiers are planned and reported here, and applied from GitHub Actions. &ldquo;Run now&rdquo; queues a request (a database row) that the plo-dispatch CronJob claims every 5 minutes; Nebula starts no pod itself.
      </p>
    </Section>
  );
}
