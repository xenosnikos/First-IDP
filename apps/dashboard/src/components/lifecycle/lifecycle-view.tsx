"use client";

import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { trpc } from "@/lib/trpc-client";
import { Pill } from "@/components/nebula/pill";
import { Button } from "@/components/nebula/button";
import { PageHeader } from "@/components/nebula/plate";
import { GateDialog } from "@/components/nebula/gate-dialog";
import { mayHaveWritten, useGatedAction, type GateResult } from "@/lib/nebula/use-gated-action";
import { LIFECYCLE_TABS, TAB_LABEL, emptyStateLines, fmtUtc, hasAnySnapshot, headerTiles, needsAttention, nextAction, relTime, type LifecycleTab } from "@/lib/nebula/lifecycle";
import { GateResultView, gateTitle, type LifecycleAction } from "./gate-result";
import { Err, label, linkStyle, muted } from "./parts";
import { SchedulePane } from "./schedule-pane";
import { TiersPane } from "./tiers-pane";
import { AdvisoriesPane } from "./advisories-pane";
import { PreviewPane } from "./preview-pane";
import { HistoryPane } from "./history-pane";

const REFRESH_MS = 30_000;
const keep = <T,>(prev: T | undefined) => prev;

// Lifecycle (docs/NEBULA.md §N9): what the Platform Lifecycle Orchestrator
// last reported, on one page. The header answers the four questions a reader
// arrives with — what is outdated, what is at risk, where this month's bundle
// is, and what to do next; the sub-tabs hold the evidence. Reads are open to
// every signed-in user; the five writes are operator-only and go through the
// gate (summary → Ember confirm → audit), like every other Nebula write.
export function LifecycleView({ operator, login }: { operator: boolean; login: string }) {
  const utils = trpc.useUtils();
  const [tab, setTab] = useState<LifecycleTab>("tiers");
  const [action, setAction] = useState<LifecycleAction | null>(null);

  const overviewQ = trpc.lifecycle.overview.useQuery(undefined, { refetchInterval: REFRESH_MS, retry: false, placeholderData: keep });
  const previewQ = trpc.lifecycle.preview.useQuery(undefined, { refetchInterval: REFRESH_MS, retry: false, placeholderData: keep });
  const advisoriesQ = trpc.lifecycle.advisories.useQuery(undefined, { enabled: tab === "advisories" || tab === "tiers", refetchInterval: 2 * REFRESH_MS, retry: false, placeholderData: keep });
  const historyQ = trpc.lifecycle.history.useQuery(undefined, { enabled: tab === "history", refetchInterval: REFRESH_MS, retry: false, placeholderData: keep });

  // "5 minutes ago" keeps moving between polls
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  const requestRun = trpc.actions.lifecycleRequestRun.useMutation();
  const createPreview = trpc.actions.lifecycleCreatePreview.useMutation();
  const requestSmoke = trpc.actions.lifecycleRequestSmoke.useMutation();
  const deployStg = trpc.actions.lifecycleDeployStg.useMutation();
  const signoff = trpc.actions.lifecycleSignoff.useMutation();
  const run = useCallback(
    async (args: { action: LifecycleAction; confirm?: string }): Promise<GateResult> => {
      const { action: a, confirm } = args;
      if (a.kind === "run") return (await requestRun.mutateAsync({ kind: a.job, confirm })) as GateResult;
      if (a.kind === "createPreview") return (await createPreview.mutateAsync({ bundleKey: a.bundleKey, confirm })) as GateResult;
      if (a.kind === "smoke") return (await requestSmoke.mutateAsync({ scope: a.scope, bundleKey: a.bundleKey, confirm })) as GateResult;
      if (a.kind === "deployStg") return (await deployStg.mutateAsync({ bundleKey: a.bundleKey, confirm })) as GateResult;
      return (await signoff.mutateAsync({ bundleKey: a.bundleKey, confirm })) as GateResult;
    },
    [requestRun, createPreview, requestSmoke, deployStg, signoff],
  );
  const gated = useGatedAction<{ action: LifecycleAction }>(run);
  const start = (a: LifecycleAction) => {
    setAction(a);
    void gated.request({ action: a });
  };
  const closeGate = () => {
    const wasDone = mayHaveWritten(gated.phase);
    gated.reset();
    setAction(null);
    if (wasDone) void utils.lifecycle.invalidate();
  };

  const overview = overviewQ.data && "ok" in overviewQ.data.data ? overviewQ.data.data.ok : null;
  const overviewError = overviewQ.error?.message ?? (overviewQ.data && "error" in overviewQ.data.data ? overviewQ.data.data.error : null);
  const preview = previewQ.data && "ok" in previewQ.data.data ? previewQ.data.data.ok : null;
  const previewError = previewQ.error?.message ?? (previewQ.data && "error" in previewQ.data.data ? previewQ.data.data.error : null);
  const advisories = advisoriesQ.data && "ok" in advisoriesQ.data.data ? advisoriesQ.data.data.ok : null;
  const advisoriesError = advisoriesQ.error?.message ?? (advisoriesQ.data && "error" in advisoriesQ.data.data ? advisoriesQ.data.data.error : null);
  const history = historyQ.data && "ok" in historyQ.data.data ? historyQ.data.data.ok : null;
  const historyError = historyQ.error?.message ?? (historyQ.data && "error" in historyQ.data.data ? historyQ.data.data.error : null);

  // the bundle tile prefers the full preview read; the overview carries a summary as a fallback
  const bundleTile = preview ? { state: preview.state, detail: preview.detail, key12: preview.key12 } : overviewQ.data ? ("ok" in overviewQ.data.bundle ? overviewQ.data.bundle.ok : overviewQ.data.bundle) : null;
  const tiles = overview ? headerTiles(overview, bundleTile, now) : [];
  const next = overview && (preview || previewError || !previewQ.isLoading) ? nextAction({ overview, preview, previewError }) : null;
  const empty = overview ? (hasAnySnapshot(overview) ? [] : emptyStateLines(overview)) : [];
  const fetching = overviewQ.isFetching || previewQ.isFetching;

  const goTo = (t: LifecycleTab) => setTab(t);
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = LIFECYCLE_TABS.indexOf(tab);
    const to = e.key === "ArrowRight" ? LIFECYCLE_TABS[(i + 1) % LIFECYCLE_TABS.length] : e.key === "ArrowLeft" ? LIFECYCLE_TABS[(i + LIFECYCLE_TABS.length - 1) % LIFECYCLE_TABS.length] : e.key === "Home" ? LIFECYCLE_TABS[0] : e.key === "End" ? LIFECYCLE_TABS[LIFECYCLE_TABS.length - 1] : null;
    if (!to) return;
    e.preventDefault();
    setTab(to);
    document.getElementById(`lifecycle-tab-${to}`)?.focus();
  };
  const tabCount: Partial<Record<LifecycleTab, number>> = overview ? { tiers: overview.tiers.reduce((n, t) => n + t.components.filter(needsAttention).length, 0), advisories: overview.header.criticalHigh } : {};
  const tabCountTitle: Partial<Record<LifecycleTab, string>> = { tiers: "components that need attention", advisories: "critical or high advisories" };

  return (
    <div style={{ padding: 28, maxWidth: 1500 }}>
      <PageHeader title="Lifecycle" kicker="what is outdated, what is at risk and where this month's upgrade is · reported by the Platform Lifecycle Orchestrator">
        <span style={muted} aria-live="polite">
          {fetching ? "refreshing…" : overviewQ.data ? `updated ${relTime(overviewQ.data.at, Math.max(now, Date.parse(overviewQ.data.at)))} · every 30 s` : ""}
        </span>
        {!operator && <Pill word="READ-ONLY" title={`${login} is not in NEBULA_OPERATORS; requesting runs, previews and the sign-off are operator-only`} />}
      </PageHeader>

      {overviewQ.isLoading && <div style={{ color: "var(--n-ink-muted)", marginBottom: 16 }}>reading the latest PLO snapshots…</div>}
      {overviewError && (
        <div className="n-plate" role="alert" style={{ padding: 12, marginBottom: 12, borderColor: "color-mix(in oklab, var(--n-fail) 50%, transparent)" }}>
          <Pill word="FAIL" /> <span style={{ marginLeft: 8, color: "var(--n-fail)", wordBreak: "break-word" }}>The lifecycle snapshots could not be read: {overviewError}</span>
        </div>
      )}

      {overview && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12, marginBottom: 12 }}>
            {tiles.map((t) => (
              <button
                key={t.key}
                type="button"
                className="n-plate"
                onClick={() => goTo(t.tab)}
                title={`${t.detail} — open ${TAB_LABEL[t.tab]}`}
                style={{ padding: "10px 12px", minWidth: 0, textAlign: "left", fontFamily: "inherit", color: "var(--n-ink)", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "flex-start", justifyContent: "flex-start" }}
              >
                <span style={{ ...label, display: "block", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.label}</span>
                <span style={{ display: "block", maxWidth: "100%", fontSize: 18, lineHeight: 1.2, margin: "6px 0 7px" }}>{t.value}</span>
                <Pill word={t.word} />
                <span style={{ fontSize: 10, color: "var(--n-ink-muted)", marginTop: 6, lineHeight: 1.5, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{t.detail}</span>
              </button>
            ))}
          </div>

          {next && (
            <div className="n-plate" role="status" style={{ padding: "12px 14px", marginBottom: 16, display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", borderColor: "var(--n-hairline-strong)" }}>
              <span style={label}>next</span>
              <Pill word={next.word} />
              <div style={{ flex: "1 1 420px", minWidth: 0 }}>
                <div style={{ fontSize: 14 }}>{next.title}</div>
                <div style={{ ...muted, marginTop: 3, lineHeight: 1.5, wordBreak: "break-word" }}>
                  {next.detail}
                  {next.operatorOnly && !operator ? " (an operator does this)" : ""}
                </div>
              </div>
              {next.href && <Link href={next.href} style={linkStyle}>open {next.href} →</Link>}
              {next.tab && next.tab !== tab && <Button onClick={() => goTo(next.tab!)}>Open {TAB_LABEL[next.tab]}</Button>}
            </div>
          )}

          {empty.length > 0 && !hasAnySnapshot(overview) && (
            <div className="n-plate" style={{ padding: 20, marginBottom: 16 }}>
              <div className="n-display" style={{ fontSize: 20, marginBottom: 8 }}>Nothing has reported yet</div>
              <p style={{ color: "var(--n-ink-muted)", margin: "0 0 12px", lineHeight: 1.7, maxWidth: 900 }}>
                This tab shows what the Platform Lifecycle Orchestrator (PLO) posts after each of its runs in the cluster. No snapshot has arrived, so every pane is empty for now. This is what fills it, and when each job runs next:
              </p>
              {empty.map((l) => (
                <div key={l.job} style={{ display: "grid", gridTemplateColumns: "84px 1fr", gap: 12, alignItems: "baseline", padding: "7px 0", borderTop: "1px solid var(--n-hairline)" }}>
                  <span className="n-label">{l.job}</span>
                  <span>
                    {l.fills}
                    <span style={{ color: "var(--n-ink-muted)" }}>
                      {" "}· {l.cronText} · {l.nextRun ? `next ${fmtUtc(l.nextRun)} (${relTime(l.nextRun, now)})` : "no next run known"}
                    </span>
                  </span>
                </div>
              ))}
              <p style={{ color: "var(--n-ink-faint)", fontSize: 11, margin: "12px 0 0", lineHeight: 1.7 }}>
                If the next-run times pass and this stays empty, the plo CronJobs are not running or cannot reach Nebula (they ship suspended; see docs/NEBULA.md §N9, rollout order). {operator ? "You can request a plan or CVE run on the Schedule tab; it also needs plo-dispatch to be running." : "An operator can request a plan or CVE run on the Schedule tab."}
              </p>
            </div>
          )}

          <div role="tablist" aria-label="Lifecycle sections" style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
            {LIFECYCLE_TABS.map((t) => (
              <Button
                key={t}
                role="tab"
                id={`lifecycle-tab-${t}`}
                aria-selected={t === tab}
                aria-controls="lifecycle-panel"
                tabIndex={t === tab ? 0 : -1}
                variant={t === tab ? "ion" : "quiet"}
                onClick={() => goTo(t)}
                onKeyDown={onTabKey}
              >
                {TAB_LABEL[t]}
                {tabCount[t] ? <span title={tabCountTitle[t]} style={{ marginLeft: 8, opacity: 0.75 }}>{tabCount[t]}</span> : null}
              </Button>
            ))}
          </div>

          <div role="tabpanel" id="lifecycle-panel" aria-labelledby={`lifecycle-tab-${tab}`}>
            {tab === "schedule" && <SchedulePane overview={overview} now={now} operator={operator} onRun={(job) => start({ kind: "run", job })} />}
            {tab === "tiers" && <TiersPane overview={overview} advisories={advisories} advisoriesError={advisoriesError} now={now} goTo={goTo} />}
            {tab === "advisories" &&
              (advisories ? (
                <AdvisoriesPane view={advisories} now={now} />
              ) : advisoriesError ? (
                <div className="n-plate" style={{ padding: 16 }}><Err what="The CVE scan could not be read" msg={advisoriesError} /></div>
              ) : (
                <div style={{ color: "var(--n-ink-muted)" }}>reading the latest CVE scan…</div>
              ))}
            {tab === "preview" &&
              (preview ? (
                <PreviewPane view={preview} now={now} operator={operator} onAct={start} />
              ) : previewError ? (
                <div className="n-plate" style={{ padding: 16 }}><Err what="The bundle state could not be read" msg={previewError} /></div>
              ) : (
                <div style={{ color: "var(--n-ink-muted)" }}>reading the bundle, twizz-gitops and Argo…</div>
              ))}
            {tab === "history" &&
              (history ? (
                <HistoryPane view={history} now={now} />
              ) : historyError ? (
                <div className="n-plate" style={{ padding: 16 }}><Err what="The history could not be read" msg={historyError} /></div>
              ) : (
                <div style={{ color: "var(--n-ink-muted)" }}>reading the snapshot log…</div>
              ))}
          </div>
        </>
      )}

      <GateDialog title={gateTitle(action)} phase={gated.phase} onConfirm={gated.confirm} onClose={closeGate} renderResult={(r) => (action ? <GateResultView action={action} result={r} /> : null)} />
    </div>
  );
}
