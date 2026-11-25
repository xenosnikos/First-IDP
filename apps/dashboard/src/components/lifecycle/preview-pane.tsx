"use client";

import Link from "next/link";
import { Pill } from "@/components/nebula/pill";
import { Button } from "@/components/nebula/button";
import { EmberButton } from "@/components/nebula/ember-button";
import { Row } from "@/components/nebula/plate";
import { ttlWord } from "@/lib/nebula/status";
import {
  PREVIEW_STATE_LABEL,
  currentStepWord,
  envBuildWord,
  fmtUtc,
  previewStateWord,
  relTime,
  requestText,
  requestWord,
  shortSha,
  shortTag,
  verdictWord,
  type BundleView,
  type LifecyclePreview,
  type SmokeVerdict,
} from "@/lib/nebula/lifecycle";
import type { LifecycleAction } from "./gate-result";
import { Empty, EnvChips, Ext, Notice, Prose, Section, label, linkStyle, listStyle, muted, rowStyle, tableStyle, tdStyle, thStyle } from "./parts";

type ActionKey = keyof LifecyclePreview["actions"];

const ACTIONS: Array<{ key: ActionKey; label: string; what: string; make: (bundleKey: string) => LifecycleAction }> = [
  { key: "createPreview", label: "Create preview", what: "one named env per bundled service, built from the bundle branch (72 h)", make: (bundleKey) => ({ kind: "createPreview", bundleKey }) },
  { key: "smokePreview", label: "Run preview smoke", what: "HTTP checks against the preview envs", make: (bundleKey) => ({ kind: "smoke", scope: "preview", bundleKey }) },
  { key: "deployStg", label: "Deploy to staging", what: "open the staging promotion pull request(s) with the preview images", make: (bundleKey) => ({ kind: "deployStg", bundleKey }) },
  { key: "smokeStg", label: "Run staging smoke", what: "the same checks against the staging hosts", make: (bundleKey) => ({ kind: "smoke", scope: "stg", bundleKey }) },
  { key: "signoff", label: "Sign off", what: "record the human sign-off and comment on every bundled pull request; merges nothing", make: (bundleKey) => ({ kind: "signoff", bundleKey }) },
];

/** the action furthest down the pipeline that the server allows right now */
function primaryAction(actions: LifecyclePreview["actions"]): ActionKey | null {
  return [...ACTIONS].reverse().find((a) => actions[a.key].allowed)?.key ?? null;
}

function Stepper({ view }: { view: LifecyclePreview }) {
  return (
    <ol aria-label="Where the bundle is in the pipeline" style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(118px, 1fr))", gap: 6 }}>
      {view.steps.map((s, i) => {
        const word = currentStepWord(s, view.state);
        const current = s.status === "current" || s.status === "failed";
        return (
          <li
            key={s.key}
            aria-current={current ? "step" : undefined}
            style={{
              padding: "8px 10px",
              border: `1px solid ${current ? "var(--n-ion)" : "var(--n-hairline)"}`,
              borderRadius: "var(--n-radius)",
              background: current ? "color-mix(in oklab, var(--n-ion) 10%, transparent)" : "transparent",
              opacity: s.status === "skipped" ? 0.55 : 1,
              minWidth: 0,
            }}
          >
            <div style={{ ...label, marginBottom: 5 }}>step {i + 1}</div>
            <div style={{ fontSize: 12, marginBottom: 7, color: s.status === "todo" || s.status === "skipped" ? "var(--n-ink-muted)" : "var(--n-ink)" }}>{s.label}</div>
            {word ? <Pill word={word} /> : <span style={{ fontSize: 10, color: "var(--n-ink-faint)", letterSpacing: "0.12em", textTransform: "uppercase" }} title="nothing in this bundle has a staging route in Nebula">not applicable</span>}
          </li>
        );
      })}
    </ol>
  );
}

function ActionRows({ view, operator, onAct }: { view: LifecyclePreview; operator: boolean; onAct: (a: LifecycleAction) => void }) {
  const key = view.bundleKey;
  const primary = primaryAction(view.actions);
  return (
    <div>
      {ACTIONS.map((a, i) => {
        const allow = view.actions[a.key];
        const enabled = operator && allow.allowed && !!key;
        const title = !operator ? "operators only" : allow.allowed ? a.what : allow.reason;
        const onClick = () => key && onAct(a.make(key));
        return (
          <div key={a.key} style={{ display: "grid", gridTemplateColumns: "190px 1fr", gap: 14, alignItems: "center", padding: "8px 0", borderTop: i ? "1px solid var(--n-hairline)" : "none" }}>
            <div>
              {a.key === "signoff" ? (
                <EmberButton disabled={!enabled} title={title} onClick={onClick} style={{ width: "100%", opacity: enabled ? 1 : 0.55 }}>{a.label}</EmberButton>
              ) : (
                <Button variant={a.key === primary && enabled ? "ion" : "quiet"} disabled={!enabled} title={title} onClick={onClick} style={{ width: "100%" }}>{a.label}</Button>
              )}
            </div>
            <div style={{ fontSize: 12, lineHeight: 1.5, minWidth: 0 }}>
              {allow.allowed ? (
                <span>
                  <span style={{ color: "var(--n-ink)" }}>{a.key === primary ? "Next: " : "Available: "}</span>
                  <span style={{ color: "var(--n-ink-muted)" }}>{a.what}{!operator ? " — operators only" : ""}</span>
                </span>
              ) : (
                <span style={{ color: "var(--n-ink-faint)", wordBreak: "break-word" }}>Not yet: {allow.reason}</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function BundleCard({ b, now }: { b: BundleView; now: number }) {
  const ttl = b.env ? ttlWord(b.env.expiresAt, new Date(now)) : null;
  return (
    <article className="n-plate" style={{ padding: 16, minWidth: 0 }}>
      <header style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, paddingBottom: 10, borderBottom: "1px solid var(--n-hairline)" }}>
        <div style={{ minWidth: 0 }}>
          <h3 className="n-display" style={{ fontSize: 20, lineHeight: 1.15, margin: 0, fontWeight: 400, wordBreak: "break-word" }}>{b.service ?? b.repo}</h3>
          <div style={{ ...muted, marginTop: 4 }}>
            <Ext href={`https://github.com/${b.github}`}>{b.github}</Ext>
          </div>
        </div>
        <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
          {b.previewable ? <Pill word="PREVIEWABLE" title="a Nebula registry service: gets a named env" /> : <Pill word="OBSERVE ONLY" title={b.note ?? "no preview route in Nebula"} />}
          {b.promotable && <Pill word="STAGING" title="on the release train: can be promoted to staging" />}
        </span>
      </header>

      <Row label="branch">
        {b.headSha ? <Ext href={`https://github.com/${b.github}/tree/${b.branch}`}>{b.branch}</Ext> : <span>{b.branch}</span>}
        <span style={muted}>
          {b.headSha ? `at ${shortSha(b.headSha)}` : "nothing bundled"} · onto {b.baseBranch}
        </span>
      </Row>
      <Row label="reaches"><EnvChips names={b.environments} /></Row>
      <Row label="included">
        {b.included.length === 0 ? (
          <span style={{ color: "var(--n-ink-faint)" }}>no pull request merged into the bundle</span>
        ) : (
          <div style={{ width: "100%" }}>
            {b.included.map((p) => (
              <div key={p.number} style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "2px 0" }}>
                <Ext href={p.url}>#{p.number}</Ext>
                <Prose style={{ color: "var(--n-ink-muted)" }}>{p.title}</Prose>
              </div>
            ))}
          </div>
        )}
      </Row>
      {b.conflicts.length > 0 && (
        <Row label="conflicts">
          <div style={{ width: "100%" }}>
            {b.conflicts.map((c) => (
              <div key={c.pr.number} style={{ padding: "2px 0" }}>
                <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                  <Pill word="FAIL" title="could not be merged into the bundle; it is NOT part of what gets previewed" />
                  <Ext href={c.pr.url}>#{c.pr.number}</Ext>
                  <span style={{ color: "var(--n-ink-muted)", wordBreak: "break-word" }}>{c.pr.title}</span>
                </div>
                <div style={{ ...muted, marginTop: 2, wordBreak: "break-all" }}>left out: conflicts in {c.files.slice(0, 4).join(", ")}{c.files.length > 4 ? ` +${c.files.length - 4} more` : ""}</div>
              </div>
            ))}
          </div>
        </Row>
      )}
      <Row label="preview" last={!b.staging}>
        {!b.previewable ? (
          <Prose style={{ color: "var(--n-ink-muted)" }}>{b.note ?? "no preview route in Nebula"}</Prose>
        ) : !b.env ? (
          <span style={{ color: "var(--n-ink-muted)" }}><Pill word="PLANNED" /> <span style={{ marginLeft: 6 }}>not created yet — will be {b.envName}</span></span>
        ) : (
          <>
            {b.env.build === "ready" ? <Ext href={b.env.url}>{b.env.name}</Ext> : <span>{b.env.name}</span>}
            {b.env.build === "ready" ? (
              <Pill word={b.env.argo ?? "UNKNOWN"} title={`Argo CD says ${b.env.argo ?? "nothing"} for env-${b.env.name}`} />
            ) : (
              <Pill word={envBuildWord(b.env.build)} title={b.env.build === "failed" ? (b.env.buildReason ?? "build failed") : "image building"} />
            )}
            <span style={muted}>
              {b.env.build === "ready" ? (b.env.up ? "up" : "deployed, not confirmed up") : b.env.build === "failed" ? `build failed${b.env.buildReason ? `: ${b.env.buildReason}` : ""}` : "building"}
              {ttl ? ` · expires ${ttl.remaining}` : ""}
            </span>
            {ttl?.word && <Pill word={ttl.word} />}
          </>
        )}
      </Row>
      {b.staging && (
        <Row label="staging" last>
          <div style={{ width: "100%" }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              {b.staging.host ? <Ext href={`https://${b.staging.host}`}>{b.staging.host}</Ext> : <span>no host</span>}
              {b.staging.deployed ? <Pill word="DEPLOYED" title="gitops is on this bundle's image and Argo CD confirms it rolled out" /> : b.staging.argo ? <Pill word={b.staging.argo} title="Argo CD's verdict for the staging app (whatever it runs now)" /> : null}
            </div>
            <div style={{ ...muted, marginTop: 4, wordBreak: "break-all" }} title={b.staging.currentTag ?? ""}>
              {b.staging.error ? `could not be read: ${b.staging.error}` : `runs ${shortTag(b.staging.currentTag)}${b.staging.deployed ? " (this bundle)" : b.headSha && b.staging.currentTag?.endsWith(`-${b.headSha.slice(0, 12)}`) ? " (this bundle's image; Argo CD has not confirmed the rollout)" : " (not this bundle)"}`}
            </div>
            {b.staging.promotion && (
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6, flexWrap: "wrap" }}>
                <Pill word="AWAITING HUMAN" title="the promotion pull request is open; merging it is the gate on /releases" />
                <Ext href={b.staging.promotion.url}>#{b.staging.promotion.number}</Ext>
                <Link href="/releases" style={linkStyle}>merge it on /releases →</Link>
              </div>
            )}
          </div>
        </Row>
      )}
    </article>
  );
}

function SmokeSection({ title, v, now, skipped }: { title: string; v: SmokeVerdict; now: number; skipped?: boolean }) {
  return (
    <Section title={title} right={skipped ? <span style={muted}>not applicable: nothing here has a staging route in Nebula</span> : <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}><span style={muted}>{v.detail}</span><Pill word={verdictWord(v.verdict)} /></span>}>
      {v.request && (
        <div style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 11, color: "var(--n-ink-muted)", marginBottom: v.results.length ? 10 : 0, flexWrap: "wrap" }}>
          {/* a finished request's outcome is the verdict in the header; a second pill here would contradict a failed smoke */}
          {v.request.status !== "done" && <Pill word={requestWord(v.request.status)} title={`request ${v.request.id}`} />}
          <span>{requestText(v.request, now)}</span>
          {v.finishedAt && <span title={fmtUtc(v.finishedAt)}>· result {relTime(v.finishedAt, now)}{v.runId ? ` · run ${v.runId}` : ""}</span>}
        </div>
      )}
      {!v.request && !skipped && <div style={{ color: "var(--n-ink-faint)", fontSize: 12 }}>Not requested yet for this bundle.</div>}
      {v.results.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ ...tableStyle, minWidth: 560 }}>
            <thead>
              <tr>
                <th scope="col" style={thStyle}>check</th>
                <th scope="col" style={thStyle}>result</th>
                <th scope="col" style={thStyle}>http</th>
                <th scope="col" style={thStyle}>took</th>
                <th scope="col" style={{ ...thStyle, paddingRight: 0 }}>detail</th>
              </tr>
            </thead>
            <tbody>
              {[...v.results].sort((a, b) => Number(a.ok) - Number(b.ok)).map((r) => (
                <tr key={`${r.name}:${r.url}`} style={rowStyle}>
                  <th scope="row" style={{ ...tdStyle, fontWeight: 400, textAlign: "left" }}>
                    <div>{r.name}</div>
                    <div style={{ ...muted, wordBreak: "break-all", marginTop: 2 }}>{r.url}</div>
                  </th>
                  <td style={tdStyle}><Pill word={r.ok ? "PASS" : "FAIL"} /></td>
                  <td style={tdStyle}>{r.status ?? "—"}</td>
                  <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>{Math.round(r.ms)} ms</td>
                  <td style={{ ...tdStyle, paddingRight: 0, color: r.ok ? "var(--n-ink-muted)" : "var(--n-fail)", wordBreak: "break-word" }}>{r.detail || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

// Preview: where the month's consolidated change is on its way to a human
// sign-off. Top to bottom: the pipeline (stepper), the one thing to do next
// with every other step's reason for not being available, what holds it back,
// then the evidence — the bundle per repository, the envs, the smoke results.
export function PreviewPane({ view, now, operator, onAct }: { view: LifecyclePreview; now: number; operator: boolean; onAct: (a: LifecycleAction) => void }) {
  if (view.state === "no-bundle") {
    return (
      <div>
        {view.sourceRun && !view.sourceRun.ok && (
          <Notice word="FAIL">
            The last source run ({view.sourceRun.runId}, {relTime(view.sourceRun.finishedAt, now)}) failed. A failed run&apos;s bundle is partial, so nothing here can be previewed, deployed or signed off until a source run succeeds.
          </Notice>
        )}
        {view.blockers.map((b, i) => (
          <Notice key={i} word="WATCH">{b}</Notice>
        ))}
        <Empty title="No bundle to preview">
          {view.sourceRun
            ? `The last source run (${view.sourceRun.runId}, ${relTime(view.sourceRun.finishedAt, now)}) left nothing to preview: ${view.detail}.`
            : "The source job has not reported yet."}{" "}
          Once a month the <strong>source</strong> job opens the upgrade pull requests and merges them into one branch per repository (<code>plo/bundle/&lt;yyyy-mm&gt;</code>). That bundle is what gets previewed, smoke-tested, taken to staging and signed off here.
        </Empty>
      </div>
    );
  }

  const noStaging = view.steps.some((s) => s.status === "skipped");
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Section
        title={`Bundle ${view.key12 ?? ""}`}
        right={
          <span style={{ display: "inline-flex", gap: 10, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
            {view.sourceRun && <span style={muted} title={fmtUtc(view.sourceRun.finishedAt)}>built by source run {view.sourceRun.runId} · {relTime(view.sourceRun.finishedAt, now)}</span>}
            <Pill word={previewStateWord(view.state)} title={PREVIEW_STATE_LABEL[view.state]} />
          </span>
        }
      >
        <p style={{ margin: "2px 0 12px", fontSize: 13, lineHeight: 1.6 }}>
          <span>{PREVIEW_STATE_LABEL[view.state].charAt(0).toUpperCase() + PREVIEW_STATE_LABEL[view.state].slice(1)}</span>
          <span style={{ color: "var(--n-ink-muted)" }}> — {view.detail}</span>
        </p>
        <Stepper view={view} />
        {view.signoff && (
          <div style={{ display: "flex", gap: 8, alignItems: "baseline", marginTop: 12, fontSize: 12 }}>
            <Pill word="PASS" /> <span>Signed off by {view.signoff.by}, {fmtUtc(view.signoff.at)} ({relTime(view.signoff.at, now)}). Merging the pull requests stays a human action in GitHub.</span>
          </div>
        )}
      </Section>

      {view.blockers.length > 0 && (
        <Section title="Holding it back" right={<Pill word="WATCH" />}>
          <ul style={listStyle}>
            {view.blockers.map((b, i) => (
              <li key={i} style={{ wordBreak: "break-word" }}>{b}</li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="What can be done now" right={!operator ? <Pill word="READ-ONLY" title="these are operator actions; you can follow the state here" /> : <span style={muted}>every action shows what it will do and asks for a confirm</span>}>
        <ActionRows view={view} operator={operator} onAct={onAct} />
      </Section>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(460px, 1fr))", gap: 12, alignItems: "start" }}>
        {view.bundles.map((b) => (
          <BundleCard key={b.github} b={b} now={now} />
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(460px, 1fr))", gap: 12, alignItems: "start" }}>
        <SmokeSection title="Preview smoke" v={view.smoke.preview} now={now} />
        <SmokeSection title="Staging smoke" v={view.smoke.stg} now={now} skipped={noStaging} />
      </div>
    </div>
  );
}
