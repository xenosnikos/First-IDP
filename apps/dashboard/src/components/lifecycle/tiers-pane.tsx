"use client";

import { useMemo, useState } from "react";
import { Pill } from "@/components/nebula/pill";
import { Button } from "@/components/nebula/button";
import { Drawer } from "@/components/nebula/drawer";
import { Row } from "@/components/nebula/plate";
import {
  AUTONOMY_TEXT,
  DEFAULT_COMPONENT_FILTER,
  ROLLBACK_TEXT,
  SEVERITY_WORD,
  STATUS_TEXT,
  STATUS_URGENCY,
  advisoriesForComponent,
  advisoryWord,
  environmentFilterNames,
  eolNote,
  epssPct,
  filterComponents,
  needsAttention,
  sortByRisk,
  staleNote,
  tierSummary,
  tierWord,
  versionChange,
  type ComponentFilter,
  type ComponentRow,
  type LifecycleAdvisories,
  type LifecycleEnvironments,
  type LifecycleOverview,
  type TierView,
} from "@/lib/nebula/lifecycle";
import { Empty, EnvChips, Err, Ext, FilterGroup, Notice, Prose, Section, Toggle, label, listStyle, muted, rowStyle, selectStyle, tableStyle, tdStyle, thStyle, type PaneNav } from "./parts";
import { inputStyle } from "@/components/nebula/plate";

const ROW_CAP = 50;

function Version({ c }: { c: ComponentRow }) {
  const v = versionChange(c);
  return (
    <span style={{ whiteSpace: "nowrap" }}>
      <span style={{ color: v.to ? "var(--n-ink-muted)" : undefined }}>{v.from}</span>
      {v.to && (
        <>
          <span style={{ color: "var(--n-ink-faint)" }}> → </span>
          <span>{v.to}</span>
        </>
      )}
      {v.latest && <span style={{ color: "var(--n-ink-faint)" }} title="the newest release known; PLO's target is the version before the arrow"> (latest {v.latest})</span>}
    </span>
  );
}

function AdvisoryCount({ c }: { c: ComponentRow }) {
  const a = c.advisories;
  if (a.count === 0) return <span style={{ color: "var(--n-ink-faint)" }}>—</span>;
  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center", whiteSpace: "nowrap" }}>
      <span>{a.count}</span>
      {a.from === "cve" ? (
        <Pill word={advisoryWord(a)} title={a.kev > 0 ? `${a.kev} known exploited (CISA KEV); highest severity ${a.highest ?? "unknown"}` : `highest severity ${a.highest ?? "unknown"}`} />
      ) : (
        <span style={{ color: "var(--n-ink-faint)", fontSize: 11 }} title="counted by the plan run; severities arrive with the first CVE scan">unrated</span>
      )}
    </span>
  );
}

function TierPlate({ tier, rows, filtered, onOpen }: { tier: TierView; rows: ComponentRow[]; filtered: boolean; onOpen: (c: ComponentRow) => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, ROW_CAP);
  const hidden = tier.total - rows.length;
  return (
    <Section
      title={tier.label}
      right={
        <span style={{ display: "inline-flex", gap: 10, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
          <span style={muted}>{tierSummary(tier)}</span>
          <Pill word={tierWord(tier)} />
        </span>
      }
    >
      {tier.total === 0 ? (
        <div style={{ color: "var(--n-ink-faint)", fontSize: 12 }}>Nothing reported for this tier.</div>
      ) : rows.length === 0 ? (
        <div style={{ color: "var(--n-ink-muted)", fontSize: 12 }}>
          {filtered ? `None of the ${tier.total} components here match the filters.` : `All ${tier.total} components are up to date with no open advisory.`}
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ ...tableStyle, minWidth: 940 }}>
            <thead>
              <tr>
                <th scope="col" style={thStyle}>component</th>
                <th scope="col" style={thStyle}>target</th>
                <th scope="col" style={thStyle}>environments</th>
                <th scope="col" style={thStyle} title="running now → what PLO wants (newest known)">version</th>
                <th scope="col" style={thStyle}>bump</th>
                <th scope="col" style={thStyle}>status</th>
                <th scope="col" style={thStyle}>advisories</th>
                <th scope="col" style={{ ...thStyle, paddingRight: 0 }}>pull request</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((c) => (
                <tr key={c.id} style={rowStyle}>
                  <th scope="row" style={{ ...tdStyle, fontWeight: 400, textAlign: "left", maxWidth: 260 }}>
                    <button
                      type="button"
                      onClick={() => onOpen(c)}
                      title={`${c.name}: reasons, end of life, rollback and advisories`}
                      style={{ fontFamily: "inherit", fontSize: 12, background: "none", border: 0, padding: 0, cursor: "pointer", color: "var(--n-ink)", textAlign: "left", wordBreak: "break-word", textDecoration: "underline", textDecorationColor: "var(--n-hairline-strong)", textUnderlineOffset: 3 }}
                    >
                      {c.name}
                    </button>
                    {c.eol?.eol && <Pill word="EXPIRED" title="end of life" style={{ marginLeft: 8 }} />}
                  </th>
                  <td style={{ ...tdStyle, color: "var(--n-ink-muted)", maxWidth: 200, wordBreak: "break-word" }}>{c.target}</td>
                  <td style={tdStyle}><EnvChips names={c.environments} /></td>
                  <td style={tdStyle}><Version c={c} /></td>
                  <td style={{ ...tdStyle, whiteSpace: "nowrap", color: c.bump === "major" ? "var(--n-ink)" : "var(--n-ink-muted)" }} title={c.bump === "major" ? "a major version: expect breaking changes" : undefined}>
                    {c.bump === "none" ? "—" : c.bump}
                  </td>
                  <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                    <Pill word={c.word} /> <span style={{ ...muted, marginLeft: 4 }}>{STATUS_TEXT[c.status]}</span>
                  </td>
                  <td style={tdStyle}><AdvisoryCount c={c} /></td>
                  <td style={{ ...tdStyle, paddingRight: 0, whiteSpace: "nowrap" }}>{c.pr ? <Ext href={c.pr.url} title={`${c.pr.repo}: ${c.pr.title}`}>#{c.pr.number}</Ext> : <span style={{ color: "var(--n-ink-faint)" }}>—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(rows.length > ROW_CAP || (hidden > 0 && rows.length > 0)) && (
        <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
          {rows.length > ROW_CAP && (
            <Button onClick={() => setAll((v) => !v)}>{all ? `Show the first ${ROW_CAP}` : `Show all ${rows.length}`}</Button>
          )}
          <span style={muted}>
            showing {shown.length} of {tier.total}
            {hidden > 0 ? ` · ${hidden} hidden by the filters` : ""}
          </span>
        </div>
      )}
    </Section>
  );
}

function ComponentDrawer({ c, advisories, advisoriesError, now, onClose, goTo }: { c: ComponentRow | null; advisories: LifecycleAdvisories | null; advisoriesError: string | null; now: number; onClose: () => void } & PaneNav) {
  const eol = c ? eolNote(c.eol, now) : null;
  const mine = c && advisories ? advisoriesForComponent(advisories.advisories, c.id) : [];
  return (
    <Drawer open={!!c} onClose={onClose} title={c?.name ?? ""} width={560}>
      {c && (
        <>
          <Row label="status">
            <Pill word={c.word} /> <span>{STATUS_TEXT[c.status]}</span>
          </Row>
          <Row label="version"><Version c={c} /></Row>
          <Row label="bump">{c.bump === "none" ? "none" : c.bump}{c.bump === "major" && <span style={muted}>expect breaking changes</span>}</Row>
          <Row label="where">
            <span style={{ wordBreak: "break-word" }}>{c.target}</span>
            <EnvChips names={c.environments} />
          </Row>
          <Row label="kind"><span>{c.domain}</span><span style={muted}>reported by the {c.snapshot} run</span></Row>
          <Row label="handling"><Prose>{AUTONOMY_TEXT[c.autonomy]}</Prose></Row>
          <Row label="rollback"><Prose>{ROLLBACK_TEXT[c.rollback]}</Prose></Row>
          <Row label="support">
            {eol ? (
              <>
                {eol.word && <Pill word={eol.word} />}
                <Prose>{eol.text}</Prose>
              </>
            ) : (
              <span style={{ color: "var(--n-ink-faint)" }}>not tracked for this component</span>
            )}
          </Row>
          <Row label="pr" last>
            {c.pr ? (
              <>
                <Ext href={c.pr.url}>{c.pr.repo}#{c.pr.number}</Ext>
                <Prose style={muted}>{c.pr.title}</Prose>
              </>
            ) : (
              <span style={{ color: "var(--n-ink-faint)" }}>none open</span>
            )}
          </Row>

          <div style={{ ...label, margin: "18px 0 6px" }}>why PLO says so</div>
          {c.reasons.length === 0 ? (
            <div style={{ color: "var(--n-ink-faint)", fontSize: 12 }}>no reason recorded</div>
          ) : (
            <ul style={listStyle}>
              {c.reasons.map((r, i) => (
                <li key={i} style={{ wordBreak: "break-word" }}>{r}</li>
              ))}
            </ul>
          )}

          <div style={{ ...label, margin: "18px 0 6px" }}>advisories affecting it · {c.advisories.count}</div>
          {c.advisories.count === 0 ? (
            <div style={{ color: "var(--n-ink-faint)", fontSize: 12 }}>none known</div>
          ) : c.advisories.from === "plan" ? (
            <div style={{ color: "var(--n-ink-muted)", fontSize: 12, lineHeight: 1.6 }}>The plan run counted {c.advisories.count}; the details arrive with the first CVE scan.</div>
          ) : advisoriesError ? (
            <Err what="advisories" msg={advisoriesError} />
          ) : !advisories ? (
            <div style={{ color: "var(--n-ink-muted)", fontSize: 12 }}>reading the latest CVE scan…</div>
          ) : (
            <>
              {mine.map((a) => {
                const hit = a.affected.find((x) => x.componentId === c.id);
                return (
                  <div key={a.id} style={{ padding: "8px 0", borderTop: "1px solid var(--n-hairline)" }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <Ext href={a.url}>{a.id}</Ext>
                      {a.kev && <Pill word="KEV" title="known exploited (CISA KEV)" />}
                      <Pill word={SEVERITY_WORD[a.severity]} />
                      <span style={muted}>EPSS {epssPct(a.epss)}</span>
                    </div>
                    <div style={{ fontSize: 12, marginTop: 4, lineHeight: 1.5, wordBreak: "break-word" }}>{a.summary}</div>
                    {hit && (
                      <div style={{ ...muted, marginTop: 3 }}>
                        {hit.version} → {hit.fixedIn ? `fixed in ${hit.fixedIn}` : "no fixed version published"}
                      </div>
                    )}
                  </div>
                );
              })}
              {mine.length === 0 && <div style={{ color: "var(--n-ink-muted)", fontSize: 12 }}>{c.advisories.ids.join(", ")}</div>}
              <div style={{ marginTop: 12 }}>
                <Button onClick={() => { onClose(); goTo("advisories"); }}>Open the Advisories tab</Button>
              </div>
            </>
          )}
        </>
      )}
    </Drawer>
  );
}

// Tiers: one plate per tier, in dependency order (what must move first is
// first). The default view keeps only what needs attention — outdated, an open
// PR, a failure, or any advisory — and each plate's summary line still counts
// everything, so nothing is silently missing.
//
// The environment filter is owned by the view (`environment` / `onEnvironment`):
// the Environments pane sets it, and it stays put while the reader moves
// between Tiers and Advisories.
export function TiersPane({
  overview,
  environments,
  advisories,
  advisoriesError,
  now,
  goTo,
  environment,
  onEnvironment,
}: { overview: LifecycleOverview; environments: LifecycleEnvironments | null; advisories: LifecycleAdvisories | null; advisoriesError: string | null; now: number; environment: string | null; onEnvironment: (env: string | null) => void } & PaneNav) {
  const [rest, setRest] = useState<Omit<ComponentFilter, "environment">>(DEFAULT_COMPONENT_FILTER);
  const filter = useMemo<ComponentFilter>(() => ({ ...rest, environment }), [rest, environment]);
  const [open, setOpen] = useState<ComponentRow | null>(null);
  const set = ({ environment: env, ...patch }: Partial<ComponentFilter>) => {
    if (env !== undefined) onEnvironment(env);
    if (Object.keys(patch).length) setRest((f) => ({ ...f, ...patch }));
  };
  const envNames = environmentFilterNames(environments, overview.environments, environment);

  const perTier = useMemo(() => overview.tiers.map((t) => ({ tier: t, rows: sortByRisk(filterComponents(t.components, filter)) })), [overview.tiers, filter]);
  const total = overview.header.components;
  const matching = perTier.reduce((n, t) => n + t.rows.length, 0);
  const attention = useMemo(() => overview.tiers.reduce((n, t) => n + t.components.filter(needsAttention).length, 0), [overview.tiers]);
  const filtered = !!filter.environment || !!filter.status || !!filter.text.trim();
  const stale = staleNote("plan", overview.stale.plan, now);
  const failed = overview.runs.plan?.lastFailed ?? null;
  const planErrors = overview.discoveryErrors.filter((e) => e.job !== "cve");

  if (total === 0) {
    return (
      <Empty title="No components reported yet">
        The <strong>plan</strong> job lists every component it finds — control plane, add-ons, node images, Helm releases, base images and npm dependencies — with what is outdated or end-of-life. Its next run is on the Schedule tab; an operator can request one now.
      </Empty>
    );
  }

  return (
    <div>
      {stale && <Notice word="WATCH">{stale}</Notice>}
      {failed && (
        <Notice word="FAIL">
          The latest plan run ({failed.runId}) failed{failed.error ? `: ${failed.error}` : ""}. Showing the last successful run instead.
        </Notice>
      )}
      {overview.runs.plan && !overview.runs.plan.ok && !failed && (
        <Notice word="FAIL">The plan run shown here failed{overview.runs.plan.error ? `: ${overview.runs.plan.error}` : ""}. What it did report is below and may be incomplete.</Notice>
      )}
      {planErrors.length > 0 && (
        <Notice word="WATCH">
          {planErrors.length} source{planErrors.length === 1 ? "" : "s"} could not be read, so the list below is incomplete: {planErrors.map((e) => `${e.domain} (${e.error})`).join("; ")}
        </Notice>
      )}

      <div className="n-plate" style={{ padding: "10px 12px", marginBottom: 12, display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" }}>
        <Toggle on={filter.actionableOnly} onClick={() => set({ actionableOnly: !filter.actionableOnly })} title="keep components that are outdated, have an open PR, failed, are blocked, are end-of-life or carry an advisory">
          only what needs attention · {attention}
        </Toggle>
        <FilterGroup name="environment">
          <Toggle on={!filter.environment} onClick={() => set({ environment: null })}>all</Toggle>
          {envNames.map((e) => (
            <Toggle key={e} on={filter.environment === e} onClick={() => set({ environment: filter.environment === e ? null : e })}>{e}</Toggle>
          ))}
        </FilterGroup>
        <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <span style={label}>status</span>
          <select style={selectStyle} value={filter.status ?? ""} onChange={(e) => set({ status: (e.target.value || null) as ComponentFilter["status"] })}>
            <option value="">any</option>
            {STATUS_URGENCY.map((s) => (
              <option key={s} value={s}>{STATUS_TEXT[s]}</option>
            ))}
          </select>
        </label>
        <label style={{ display: "inline-flex", gap: 6, alignItems: "center", flex: "1 1 180px", minWidth: 160, maxWidth: 320 }}>
          <span style={label}>find</span>
          <input type="search" style={{ ...inputStyle, padding: "4px 8px", fontSize: 11, fontFamily: "inherit" }} placeholder="name or target" value={filter.text} onChange={(e) => set({ text: e.target.value })} />
        </label>
        <span style={{ ...muted, marginLeft: "auto" }} role="status">
          {matching} of {total} shown
        </span>
      </div>

      <div style={{ display: "grid", gap: 12 }}>
        {perTier.map(({ tier, rows }) => (
          <TierPlate key={tier.tier} tier={tier} rows={rows} filtered={filtered} onOpen={setOpen} />
        ))}
      </div>

      <ComponentDrawer c={open} advisories={advisories} advisoriesError={advisoriesError} now={now} onClose={() => setOpen(null)} goTo={goTo} />
    </div>
  );
}
