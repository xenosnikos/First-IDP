"use client";

import { useMemo, useState } from "react";
import { Pill } from "@/components/nebula/pill";
import { Button } from "@/components/nebula/button";
import { inputStyle } from "@/components/nebula/plate";
import {
  DEFAULT_ADVISORY_FILTER,
  advisoriesEmptyLine,
  SEVERITIES,
  SEVERITY_WORD,
  STATUS_TEXT,
  environmentFilterNames,
  epssPct,
  filterAdvisories,
  fmtUtc,
  relTime,
  staleNote,
  type AdvisoryFilter,
  type AdvisoryRow,
  type LifecycleAdvisories,
  type LifecycleEnvironments,
} from "@/lib/nebula/lifecycle";
import { Chip, Empty, EnvChips, Ext, FilterGroup, Notice, Section, Toggle, label, muted, rowStyle, selectStyle, tableStyle, tdStyle, thStyle } from "./parts";

const ROW_CAP = 60;
const AFFECTED_CAP = 3;

const TIER_TEXT: Record<AdvisoryRow["affected"][number]["tier"], string> = {
  "control-plane": "Control plane",
  addons: "Add-ons",
  nodes: "Nodes",
  helm: "Helm",
  "base-images": "Base images",
  "npm-direct": "npm direct",
  "npm-transitive": "npm transitive",
};

function Affected({ a }: { a: AdvisoryRow }) {
  const [all, setAll] = useState(false);
  const shown = all ? a.affected : a.affected.slice(0, AFFECTED_CAP);
  return (
    <div>
      {shown.map((x, i) => (
        <div key={`${x.componentId}:${i}`} style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", padding: "1px 0 5px" }}>
          <span style={{ wordBreak: "break-word" }}>{x.name}</span>
          <span style={{ whiteSpace: "nowrap" }}>
            <span style={{ color: "var(--n-ink-muted)" }}>{x.version}</span>
            <span style={{ color: "var(--n-ink-faint)" }}> → </span>
            {x.fixedIn ? <span title="the first version with the fix">{x.fixedIn}</span> : <span style={{ color: "var(--n-ink-faint)" }} title="no fixed version has been published">no fix yet</span>}
          </span>
          <span style={{ ...muted, wordBreak: "break-word" }}>{x.target}</span>
          <EnvChips names={x.environments} />
          {x.pr ? (
            <Ext href={x.pr.url} title={`upgrade pull request: ${x.pr.title}`}>#{x.pr.number}</Ext>
          ) : x.status && x.status !== "current" ? (
            <span style={muted}>{STATUS_TEXT[x.status]}</span>
          ) : null}
        </div>
      ))}
      {a.affected.length > AFFECTED_CAP && (
        <button type="button" onClick={() => setAll((v) => !v)} style={{ fontFamily: "inherit", fontSize: 11, background: "none", border: 0, padding: 0, cursor: "pointer", color: "var(--n-ion-soft)" }}>
          {all ? "show fewer" : `+ ${a.affected.length - AFFECTED_CAP} more affected`}
        </button>
      )}
    </div>
  );
}

// Advisories: the CVE watch over what actually runs. The server sorts KEV
// first, then severity, then EPSS, and that order is kept. Every row says
// which component and which environments are affected and what version fixes
// it — "is this us, where, and what do we do" without leaving the page.
// The environment filter is owned by the view, as in the Tiers pane.
export function AdvisoriesPane({ view, now, environments, environment, onEnvironment }: { view: LifecycleAdvisories; now: number; environments: LifecycleEnvironments | null; environment: string | null; onEnvironment: (env: string | null) => void }) {
  const [rest, setRest] = useState<Omit<AdvisoryFilter, "environment">>(DEFAULT_ADVISORY_FILTER);
  const filter = useMemo<AdvisoryFilter>(() => ({ ...rest, environment }), [rest, environment]);
  const [all, setAll] = useState(false);
  const set = ({ environment: env, ...patch }: Partial<AdvisoryFilter>) => {
    if (env !== undefined) onEnvironment(env);
    if (Object.keys(patch).length) setRest((f) => ({ ...f, ...patch }));
  };
  const envNames = environmentFilterNames(environments, view.facets.environments, environment);
  const rows = useMemo(() => filterAdvisories(view.advisories, filter), [view.advisories, filter]);
  const shown = all ? rows : rows.slice(0, ROW_CAP);
  const stale = staleNote("cve", view.stale, now);
  // "none" only from a scan that ran and read everything; otherwise "none found", in WATCH
  const none = advisoriesEmptyLine(view);

  if (!view.scan) {
    return (
      <Empty title="No CVE scan yet">
        The <strong>cve</strong> job checks every component and every npm lock file against OSV, the Node.js release feed, CISA&rsquo;s Known Exploited Vulnerabilities catalogue and EPSS. It runs daily; an operator can request a scan now on the Schedule tab.
      </Empty>
    );
  }

  return (
    <div>
      {stale && <Notice word="WATCH">{stale}</Notice>}
      {!view.scan.ok && <Notice word="FAIL">The scan shown here ({view.scan.runId}) reported a failure; the list may be incomplete.</Notice>}
      {view.discoveryErrors.length > 0 && (
        <Notice word="WATCH">
          {view.discoveryErrors.length} source{view.discoveryErrors.length === 1 ? "" : "s"} did not answer, so advisories may be missing: {view.discoveryErrors.map((e) => `${e.domain} (${e.error})`).join("; ")}
        </Notice>
      )}

      <Section
        title="Advisories"
        right={
          <span style={muted} title={fmtUtc(view.scan.finishedAt)}>
            scan {view.scan.runId} · {relTime(view.scan.finishedAt, now)}
            {view.comparedTo ? ` · "new" is measured against the scan ${relTime(view.comparedTo.finishedAt, now)}` : " · first scan: nothing to compare with yet"}
          </span>
        }
      >
        <div style={{ display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
          <FilterGroup name="severity">
            <Toggle on={!filter.severity} onClick={() => set({ severity: null })}>all · {view.total}</Toggle>
            {SEVERITIES.filter((s) => view.counts[s] > 0).map((s) => (
              <Toggle key={s} on={filter.severity === s} onClick={() => set({ severity: filter.severity === s ? null : s })}>
                {s} · {view.counts[s]}
              </Toggle>
            ))}
          </FilterGroup>
          <FilterGroup name="only">
            <Toggle on={filter.kevOnly} onClick={() => set({ kevOnly: !filter.kevOnly })} title="in CISA's catalogue of vulnerabilities exploited in the wild">known exploited · {view.kev}</Toggle>
            <Toggle on={filter.newOnly} onClick={() => set({ newOnly: !filter.newOnly })} title="not in the previous scan">new · {view.new}</Toggle>
          </FilterGroup>
          {envNames.length > 0 && (
            <FilterGroup name="environment">
              <Toggle on={!filter.environment} onClick={() => set({ environment: null })}>all</Toggle>
              {envNames.map((e) => (
                <Toggle key={e} on={filter.environment === e} onClick={() => set({ environment: filter.environment === e ? null : e })}>{e}</Toggle>
              ))}
            </FilterGroup>
          )}
          <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            <span style={label}>tier</span>
            <select style={selectStyle} value={filter.tier ?? ""} onChange={(e) => set({ tier: (e.target.value || null) as AdvisoryFilter["tier"] })}>
              <option value="">any</option>
              {view.facets.tiers.map((t) => (
                <option key={t} value={t}>{TIER_TEXT[t]}</option>
              ))}
            </select>
          </label>
          <label style={{ display: "inline-flex", gap: 6, alignItems: "center", flex: "1 1 180px", minWidth: 160, maxWidth: 300 }}>
            <span style={label}>find</span>
            <input type="search" style={{ ...inputStyle, padding: "4px 8px", fontSize: 11, fontFamily: "inherit" }} placeholder="CVE, GHSA or package" value={filter.text} onChange={(e) => set({ text: e.target.value })} />
          </label>
          <span style={{ ...muted, marginLeft: "auto" }} role="status">{rows.length} of {view.total} shown</span>
        </div>

        {view.total === 0 ? (
          <div style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 12 }}>
            <Pill word={none.word} /> <span>{none.text}</span>
          </div>
        ) : rows.length === 0 ? (
          <div style={{ color: "var(--n-ink-muted)", fontSize: 12 }}>
            No advisory matches the filters{filter.environment && !view.facets.environments.includes(filter.environment) ? ` — the scan names no advisory for ${filter.environment}. That is "none found by this scan", not proof the environment was scanned: see the Environments tab for what was read.` : "."}
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ ...tableStyle, minWidth: 1040 }}>
              <thead>
                <tr>
                  <th scope="col" style={thStyle}>advisory</th>
                  <th scope="col" style={thStyle}>severity</th>
                  <th scope="col" style={thStyle} title="EPSS: the estimated probability this is exploited in the next 30 days">epss</th>
                  <th scope="col" style={thStyle}>what it is</th>
                  <th scope="col" style={{ ...thStyle, paddingRight: 0 }}>affected here · running → fixed in · where</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((a) => (
                  <tr key={a.id} style={rowStyle}>
                    <th scope="row" style={{ ...tdStyle, fontWeight: 400, textAlign: "left", whiteSpace: "nowrap" }}>
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <Ext href={a.url}>{a.id}</Ext>
                        {a.isNew && <Chip strong title="not in the previous scan">new</Chip>}
                      </div>
                      {a.aliases.length > 0 && <div style={{ ...muted, marginTop: 3, whiteSpace: "normal", maxWidth: 200, wordBreak: "break-word" }}>{a.aliases.slice(0, 3).join(", ")}{a.aliases.length > 3 ? ` +${a.aliases.length - 3}` : ""}</div>}
                    </th>
                    <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                      <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                        {a.kev && <Pill word="KEV" title="known exploited: in CISA's catalogue of vulnerabilities exploited in the wild" />}
                        <Pill word={SEVERITY_WORD[a.severity]} />
                      </span>
                      {a.cvss !== undefined && <div style={{ ...muted, marginTop: 3 }}>CVSS {a.cvss.toFixed(1)}</div>}
                    </td>
                    <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>{epssPct(a.epss)}</td>
                    <td style={{ ...tdStyle, maxWidth: 340, lineHeight: 1.5, wordBreak: "break-word" }}>
                      {a.summary || <span style={{ color: "var(--n-ink-faint)" }}>no summary published</span>}
                      <div style={{ ...muted, marginTop: 3 }}>
                        source {a.source}
                        {a.published ? ` · published ${a.published.slice(0, 10)}` : ""}
                      </div>
                    </td>
                    <td style={{ ...tdStyle, paddingRight: 0 }}><Affected a={a} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rows.length > ROW_CAP && (
          <div style={{ marginTop: 10, display: "flex", gap: 12, alignItems: "center" }}>
            <Button onClick={() => setAll((v) => !v)}>{all ? `Show the first ${ROW_CAP}` : `Show all ${rows.length}`}</Button>
            <span style={muted}>showing {shown.length} of {rows.length}</span>
          </div>
        )}
        <p style={{ fontSize: 10, color: "var(--n-ink-faint)", margin: "14px 0 0", lineHeight: 1.7 }}>
          Order: known exploited first, then severity, then EPSS. Sources: OSV (npm lock files and mapped infrastructure packages), the Node.js release feed, CISA KEV and EPSS. Only a package name and version ever leave the cluster for these lookups.
        </p>
      </Section>
    </div>
  );
}
