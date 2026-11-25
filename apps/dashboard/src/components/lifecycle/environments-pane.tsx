"use client";

import Link from "next/link";
import { Pill } from "@/components/nebula/pill";
import { Button } from "@/components/nebula/button";
import { Row } from "@/components/nebula/plate";
import {
  COVERAGE_TEXT,
  OBSERVATION_TEXT,
  envAdvisoriesLine,
  envCountsLine,
  envSeverityWord,
  fmtUtc,
  isProdEnv,
  observationLine,
  relTime,
  type EnvTierView,
  type EnvironmentView,
  type LifecycleEnvironments,
  type LifecycleTab,
} from "@/lib/nebula/lifecycle";
import { Chip, Err, Ext, Notice, Prose, Section, label, linkStyle, listStyle, muted, rowStyle, tableStyle, tdStyle, thStyle } from "./parts";

const faint = { color: "var(--n-ink-faint)" } as const;
const num = { ...tdStyle, textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" } as const;
const numTh = { ...thStyle, textAlign: "right" } as const;

/** a count cell: a zero is drawn faint so the non-zeros stand out down a column */
function N({ n }: { n: number | null }) {
  if (n === null) return <span style={faint} title="not known: no CVE scan yet">?</span>;
  return n === 0 ? <span style={faint}>0</span> : <span>{n}</span>;
}

function Observation({ e, now }: { e: EnvironmentView; now: number }) {
  const o = e.observation;
  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}>
      {/* a clean observation needs no pill: the pill is for when it is NOT clean */}
      {o.word !== "OK" && <Pill word={o.word} title={OBSERVATION_TEXT[o.state]} />}
      <span title={o.lastObserved ? `${fmtUtc(o.lastObserved.at)}${o.lastObserved.runId ? ` · run ${o.lastObserved.runId}` : ""}` : undefined} style={{ lineHeight: 1.5 }}>
        {observationLine(e, now)}
      </span>
    </span>
  );
}

function Advisories({ e }: { e: EnvironmentView }) {
  const a = e.advisories;
  const sev = envSeverityWord(a);
  if (e.kind === "preview") return <span style={faint}>—</span>;
  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}>
      {a.kev > 0 && <Pill word="KEV" title={`${a.kev} known exploited (CISA KEV)`} />}
      {sev && a.total > 0 && <Pill word={sev} title="the worst severity open here" />}
      <span style={a.scanned && a.total > 0 ? undefined : faint}>
        {a.kev > 0 ? `${a.kev} known exploited · ` : ""}
        {envAdvisoriesLine(a)}
      </span>
    </span>
  );
}

function ChangeSets({ e }: { e: EnvironmentView }) {
  if (e.kind === "preview") return <span style={faint}>—</span>;
  if (e.changeSetsTotal === 0) return <span style={faint}>none pending</span>;
  const prs = e.changeSets.flatMap((c) => (c.pr ? [c.pr] : []));
  return (
    <span style={{ display: "inline-flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
      <span>{e.changeSetsTotal} pending</span>
      {prs.slice(0, 3).map((p) => (
        <Ext key={`${p.repo}#${p.number}`} href={p.url} title={`${p.repo}: ${p.title}`}>#{p.number}</Ext>
      ))}
      {prs.length > 3 && <span style={muted}>+{prs.length - 3} PRs</span>}
    </span>
  );
}

function Stage({ e }: { e: EnvironmentView }) {
  if (e.stage.length === 0) return <span style={faint}>—</span>;
  return (
    <span style={{ display: "grid", gap: 4 }}>
      {e.stage.map((s) => (
        <span key={s.label} style={{ display: "inline-flex", gap: 6, alignItems: "baseline", whiteSpace: "nowrap" }} title={s.detail}>
          <Pill word={s.word} /> <span style={muted}>{s.label}</span>
        </span>
      ))}
    </span>
  );
}

function TierTable({ tiers }: { tiers: EnvTierView[] }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ ...tableStyle, minWidth: 700 }}>
        <thead>
          <tr>
            <th scope="col" style={thStyle}>tier</th>
            <th scope="col" style={thStyle} title="what the run read of this tier in this environment">read</th>
            <th scope="col" style={numTh} title="up to date, or upgraded by PLO">current</th>
            <th scope="col" style={numTh} title="outdated, an upgrade PR is open, or awaiting approval">behind</th>
            <th scope="col" style={numTh}>blocked</th>
            <th scope="col" style={numTh} title="escalated to a human">escalated</th>
            <th scope="col" style={numTh} title="past end of life">eol</th>
            <th scope="col" style={numTh} title="distinct open advisories naming a component of this tier here">advisories</th>
            <th scope="col" style={{ ...thStyle, paddingRight: 0, textAlign: "right" }}>status</th>
          </tr>
        </thead>
        <tbody>
          {tiers.map((t) => {
            const off = t.state === "not-applicable" || t.state === "not-observed";
            return (
              <tr key={t.tier} style={rowStyle}>
                <th scope="row" style={{ ...tdStyle, fontWeight: 400, textAlign: "left", whiteSpace: "nowrap" }}>
                  {t.label}
                  {/* the two counts that have no column of their own */}
                  {t.failed + t.unknown > 0 && <div style={{ ...muted, marginTop: 2 }}>{[t.failed ? `${t.failed} failed` : "", t.unknown ? `${t.unknown} not assessed` : ""].filter(Boolean).join(" · ")}</div>}
                </th>
                <td style={{ ...tdStyle, whiteSpace: "nowrap", color: t.state === "observed" ? "var(--n-ink-muted)" : t.state === "not-applicable" ? "var(--n-ink-faint)" : "var(--n-ink)" }} title={t.reasons.join("\n") || (t.from ? `${t.from.job} run ${t.from.runId}` : undefined)}>
                  {COVERAGE_TEXT[t.state]}
                </td>
                {off ? (
                  <td colSpan={6} style={{ ...tdStyle, ...faint, fontSize: 11, lineHeight: 1.5, wordBreak: "break-word" }}>
                    {t.state === "not-applicable" ? "nothing of this tier belongs to this environment" : (t.reasons[0] ?? "nothing was read")}
                  </td>
                ) : (
                  <>
                    <td style={num}><N n={t.current} /></td>
                    <td style={num}><N n={t.behind} /></td>
                    <td style={num}><N n={t.blocked} /></td>
                    <td style={num}><N n={t.escalated} /></td>
                    <td style={num}><N n={t.eol} /></td>
                    <td style={num}>
                      {t.kev > 0 && <Pill word="KEV" title={`${t.kev} known exploited`} style={{ marginRight: 6 }} />}
                      <N n={t.advisories} />
                    </td>
                  </>
                )}
                <td style={{ ...tdStyle, paddingRight: 0, textAlign: "right", whiteSpace: "nowrap" }}>{t.word ? <Pill word={t.word} /> : <span style={faint}>—</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Detail({ e, now, onFilter }: { e: EnvironmentView; now: number; onFilter: (env: string, tab: LifecycleTab) => void }) {
  const o = e.observation;
  // a tier that was not read says why in its own row; one read in part shows numbers, so its gap goes below the table
  const gaps = e.tiers.filter((t) => t.state === "partial");
  const clusterRead = e.tiers.some((t) => t.tier === "control-plane" && t.state !== "not-observed");
  return (
    <Section
      title={e.name}
      right={
        <span style={{ display: "inline-flex", gap: 10, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end", minWidth: 0 }}>
          <span style={{ ...muted, wordBreak: "break-word" }}>{e.clusters.join(", ") || "no cluster"}</span>
          <Pill word={e.word} />
        </span>
      }
    >
      <div style={{ fontSize: 13, lineHeight: 1.6, marginBottom: 10, wordBreak: "break-word" }}>{e.headline}</div>

      {o.state !== "observed" && (
        <div role="status" style={{ border: "1px solid var(--n-hairline-strong)", borderRadius: "var(--n-radius)", padding: "8px 10px", marginBottom: 12, fontSize: 12, lineHeight: 1.6 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
            <Pill word={o.word} />
            <span>
              {o.state === "not-observed"
                ? clusterRead || e.clusters.length === 0
                  ? "This environment was not read, so nothing is known about how it stands now."
                  : `${e.clusters.join(", ")} was not read, so nothing is known about what runs in it now. The numbers below come only from the tiers marked "read".`
                : o.state === "stale"
                  ? "The data for this environment is older than its job's schedule allows."
                  : "Only part of this environment was read; the counts below leave out what was not."}
            </span>
          </div>
          {o.reasons.length > 0 && (
            <ul style={{ ...listStyle, marginTop: 6, color: "var(--n-ink-muted)" }}>
              {o.reasons.map((r, i) => (
                <li key={i} style={{ wordBreak: "break-word" }}>{r}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: "16px 28px", alignItems: "flex-start" }}>
        <div style={{ flex: "3 1 700px", minWidth: 0 }}>
          {e.kind === "preview" ? (
            <>
              <div style={{ ...label, marginBottom: 6 }}>preview env</div>
              <Row label="service">{e.preview?.service ?? "—"}</Row>
              <Row label="address">{e.preview ? <Ext href={e.preview.url}>{e.preview.url.replace(/^https:\/\//, "")}</Ext> : "—"}</Row>
              <Row label="bundle">{e.preview?.bundleKey12 ?? "—"}</Row>
              <Row label="expires" last>{e.preview?.expiresAt ? <span title={fmtUtc(e.preview.expiresAt)}>{relTime(e.preview.expiresAt, now)}</span> : "—"}</Row>
            </>
          ) : (
            <>
              <div style={{ ...label, marginBottom: 6 }}>per tier · {envCountsLine(e.counts)}</div>
              <TierTable tiers={e.tiers} />
              {gaps.length > 0 && (
                <ul style={{ ...listStyle, fontSize: 11, color: "var(--n-ink-muted)", marginTop: 8 }}>
                  {gaps.flatMap((t) => t.reasons.slice(0, 2).map((r, i) => <li key={`${t.tier}:${i}`} style={{ wordBreak: "break-word" }}>{t.label}: {r}</li>))}
                </ul>
              )}
            </>
          )}
        </div>

        <div style={{ flex: "2 1 380px", minWidth: 0 }}>
          <div style={{ ...label, marginBottom: 6 }}>how fresh</div>
          <Row label="observed"><Prose><Observation e={e} now={now} /></Prose></Row>
          {e.freshness.map((f) => (
            <Row key={f.job} label={f.job}>
              {f.word !== "OK" && <Pill word={f.word} />}
              <Prose>
                {f.at ? <span title={`${fmtUtc(f.at)}${f.runId ? ` · run ${f.runId}` : ""}`}>finished {relTime(f.at, Math.max(now, Date.parse(f.at) || now))}</span> : "never"}
                <span style={muted}> · {f.detail}</span>
              </Prose>
            </Row>
          ))}
          {e.kind !== "preview" && (
            <Row label="advisories"><Advisories e={e} /></Row>
          )}
          {e.kind !== "preview" && e.advisories.gaps.length > 0 && (
            <ul style={{ ...listStyle, fontSize: 11, color: "var(--n-ink-muted)", margin: "4px 0 8px" }} aria-label="what the CVE scan did not read of this environment">
              {e.advisories.gaps.slice(0, 5).map((g, i) => (
                <li key={i} style={{ wordBreak: "break-word" }}>not scanned: {g}</li>
              ))}
              {e.advisories.gaps.length > 5 && <li>and {e.advisories.gaps.length - 5} more</li>}
            </ul>
          )}
          {e.stage.map((s, i) => (
            <Row key={s.label} label={s.label} last={i === e.stage.length - 1 && e.kind === "preview"}>
              <Pill word={s.word} />
              <Prose>{s.detail}</Prose>
            </Row>
          ))}
          {e.kind !== "preview" && e.stage.length === 0 && <Row label="bundle"><span style={faint}>no bundle touches this environment now</span></Row>}
          {e.kind !== "preview" && (
            <Row label="runtime" last>
              {e.monitor ? (
                <Link href={`/monitor?tier=${e.monitor}`} style={linkStyle}>open /monitor ({e.monitor}) →</Link>
              ) : (
                <span style={faint}>not on /monitor (traffic, pods and headroom are shown there for staging and prod only)</span>
              )}
            </Row>
          )}
        </div>
      </div>

      {e.kind !== "preview" && (
        <>
          <div style={{ ...label, margin: "16px 0 6px" }}>
            pending change sets · {e.changeSetsTotal}
            {e.changeSetsTotal > e.changeSets.length ? ` (showing the ${e.changeSets.length} most urgent)` : ""}
          </div>
          {e.changeSets.length === 0 ? (
            <div style={{ ...faint, fontSize: 12 }}>{o.state === "not-observed" ? "none known — the environment was not read" : "nothing is waiting to be changed here"}</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ ...tableStyle, minWidth: 760 }}>
                <thead>
                  <tr>
                    <th scope="col" style={thStyle}>change set</th>
                    <th scope="col" style={thStyle}>tier</th>
                    <th scope="col" style={thStyle}>target</th>
                    <th scope="col" style={numTh}>components</th>
                    <th scope="col" style={thStyle}>status</th>
                    <th scope="col" style={{ ...thStyle, paddingRight: 0 }}>pull request / issue</th>
                  </tr>
                </thead>
                <tbody>
                  {e.changeSets.map((c) => (
                    <tr key={c.id} style={rowStyle}>
                      <th scope="row" style={{ ...tdStyle, fontWeight: 400, textAlign: "left", maxWidth: 380, wordBreak: "break-word" }}>{c.id}</th>
                      <td style={{ ...tdStyle, whiteSpace: "nowrap", color: "var(--n-ink-muted)" }}>{c.tier}</td>
                      <td style={{ ...tdStyle, color: "var(--n-ink-muted)", wordBreak: "break-word" }}>{c.target}</td>
                      <td style={num}>{c.components}</td>
                      <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                        <Pill word={c.word} title={c.word === "OBSERVE ONLY" ? "an audit-only environment: PLO reports this and never applies it" : undefined} /> <span style={{ ...muted, marginLeft: 4 }}>{c.status}</span>
                      </td>
                      <td style={{ ...tdStyle, paddingRight: 0, whiteSpace: "nowrap" }}>
                        {c.pr ? <Ext href={c.pr.url} title={`${c.pr.repo}: ${c.pr.title}`}>#{c.pr.number}</Ext> : c.escalationUrl ? <Ext href={c.escalationUrl}>issue</Ext> : <span style={faint}>—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 14, flexWrap: "wrap" }}>
            <Button onClick={() => onFilter(e.name, "tiers")} title={`open Tiers with the environment filter set to ${e.name}`}>Components in {e.name}</Button>
            <Button onClick={() => onFilter(e.name, "advisories")} title={`open Advisories with the environment filter set to ${e.name}`}>Advisories in {e.name}</Button>
          </div>
        </>
      )}
    </Section>
  );
}

// Environments: the Tiers pane turned ninety degrees. One row per environment
// — the three of PLO's inventory ALWAYS, then the live preview envs of the
// current bundle — and one detail plate for the environment that is selected.
// A row never reads as fine because nothing was said about it: the "observed"
// column says what the latest runs really read, and an unread environment
// carries UNKNOWN with the reason, whatever older rows exist.
export function EnvironmentsPane({ view, error, now, selected, onSelect, onFilter }: { view: LifecycleEnvironments | null; error: string | null; now: number; selected: string | null; onSelect: (env: string) => void; onFilter: (env: string, tab: LifecycleTab) => void }) {
  if (!view) {
    return error ? (
      <div className="n-plate" style={{ padding: 16 }}><Err what="How each environment stands could not be read" msg={error} /></div>
    ) : (
      <div style={{ color: "var(--n-ink-muted)" }}>reading how each environment stands…</div>
    );
  }
  const current = view.environments.find((e) => e.name === selected) ?? view.environments[0] ?? null;
  return (
    <div>
      {view.notes.length > 0 && (
        <Notice word="WATCH">
          {view.notes.length === 1 ? (
            view.notes[0]
          ) : (
            <>
              {view.notes.length} things could not be read, so what depends on them is missing below:
              <ul style={{ ...listStyle, marginTop: 4, color: "var(--n-ink-muted)" }}>
                {view.notes.map((n, i) => (
                  <li key={i} style={{ wordBreak: "break-word" }}>{n}</li>
                ))}
              </ul>
            </>
          )}
        </Notice>
      )}
      <Section title="Environments" right={<span style={muted}>{view.observed} of {view.fixed} observed by the latest runs · select one for its detail</span>} style={{ marginBottom: 12 }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ ...tableStyle, minWidth: 1080 }}>
            <thead>
              <tr>
                <th scope="col" style={thStyle}>environment</th>
                <th scope="col" style={thStyle}>status</th>
                <th scope="col" style={thStyle} title="what the latest runs really read of this environment, and when">observed</th>
                <th scope="col" style={thStyle}>components</th>
                <th scope="col" style={thStyle}>open advisories</th>
                <th scope="col" style={thStyle}>change sets</th>
                <th scope="col" style={{ ...thStyle, paddingRight: 0 }}>bundle</th>
              </tr>
            </thead>
            <tbody>
              {view.environments.map((e) => {
                const on = current?.name === e.name;
                return (
                  <tr key={e.name} style={{ ...rowStyle, background: on ? "color-mix(in oklab, var(--n-ion) 8%, transparent)" : undefined }}>
                    <th scope="row" style={{ ...tdStyle, fontWeight: 400, textAlign: "left", paddingLeft: 8, minWidth: 170 }}>
                      <button
                        type="button"
                        aria-pressed={on}
                        onClick={() => onSelect(e.name)}
                        title={`show the detail for ${e.name}`}
                        style={{ fontFamily: "inherit", fontSize: 13, background: "none", border: 0, padding: 0, cursor: "pointer", color: "var(--n-ink)", textAlign: "left", fontWeight: isProdEnv(e.name) ? 600 : 400, textDecoration: "underline", textDecorationColor: on ? "var(--n-ion)" : "var(--n-hairline-strong)", textUnderlineOffset: 3, wordBreak: "break-word" }}
                      >
                        {e.name}
                      </button>
                      <div style={{ ...muted, marginTop: 3, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                        {e.kind === "preview" && <Chip title="a named env built from the bundle branch; lives for 72 h">preview env</Chip>}
                        {e.kind === "reported" && <Chip title="named by a snapshot but not in the fixed environment list">reported</Chip>}
                        <span style={{ wordBreak: "break-word" }}>{e.clusters.join(", ")}</span>
                      </div>
                    </th>
                    <td style={{ ...tdStyle, maxWidth: 300 }}>
                      <Pill word={e.word} />
                      <div style={{ ...muted, marginTop: 4, lineHeight: 1.5, wordBreak: "break-word" }}>{e.headline}</div>
                    </td>
                    <td style={{ ...tdStyle, maxWidth: 230, fontSize: 11, color: e.observation.state === "observed" ? "var(--n-ink-muted)" : "var(--n-ink)" }}><Observation e={e} now={now} /></td>
                    <td style={{ ...tdStyle, maxWidth: 220, lineHeight: 1.5, color: e.counts.total === 0 ? "var(--n-ink-faint)" : undefined }}>{e.kind === "preview" ? <span style={faint}>—</span> : e.observation.state === "not-observed" && e.counts.total === 0 ? "not known" : envCountsLine(e.counts)}</td>
                    <td style={{ ...tdStyle, maxWidth: 220, lineHeight: 1.5 }}><Advisories e={e} /></td>
                    <td style={{ ...tdStyle, maxWidth: 200 }}><ChangeSets e={e} /></td>
                    <td style={{ ...tdStyle, paddingRight: 0 }}><Stage e={e} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p style={{ fontSize: 10, color: "var(--n-ink-faint)", margin: "12px 0 0", lineHeight: 1.7 }}>
          An environment is OK only when the latest plan run read every tier that applies to it, that run and the CVE scan are within their schedule, everything is up to date and no advisory is open. Anything PLO did not read is shown as not observed, never as fine. Runtime health (traffic, pods, headroom) is on /monitor.
        </p>
      </Section>

      {current && <Detail e={current} now={now} onFilter={onFilter} />}
    </div>
  );
}
