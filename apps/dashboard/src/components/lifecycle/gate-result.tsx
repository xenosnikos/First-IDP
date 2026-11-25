import type { ReactNode } from "react";
import type { createLifecyclePreview, deployLifecycleStg, requestLifecycleRun, requestLifecycleSmoke, signoffLifecycle } from "@twizz-idp/actions";
import { Pill } from "@/components/nebula/pill";
import { Row } from "@/components/nebula/plate";
import { Ext, muted } from "./parts";

// The five gated Lifecycle writes, as the page asks for them. The caller names
// only a run kind, a scope or the bundle key it is looking at — env names,
// smoke targets, image tags and pull-request lists are derived server-side and
// shown back in the gate's summary before anything is written.
export type LifecycleAction =
  | { kind: "run"; job: "plan" | "cve" }
  | { kind: "createPreview"; bundleKey: string }
  | { kind: "smoke"; scope: "preview" | "stg"; bundleKey: string }
  | { kind: "deployStg"; bundleKey: string }
  | { kind: "signoff"; bundleKey: string };

// Result shapes come from the action functions themselves (type-only imports,
// erased at build time) — not re-declared here.
type RunResult = Awaited<ReturnType<typeof requestLifecycleRun>>;
type PreviewResult = Awaited<ReturnType<typeof createLifecyclePreview>>;
type SmokeResult = Awaited<ReturnType<typeof requestLifecycleSmoke>>;
type DeployResult = Awaited<ReturnType<typeof deployLifecycleStg>>;
type SignoffResult = Awaited<ReturnType<typeof signoffLifecycle>>;

const key12 = (k: string) => k.slice(0, 12);

export function gateTitle(a: LifecycleAction | null): string {
  if (!a) return "";
  switch (a.kind) {
    case "run":
      return a.job === "plan" ? "Request a plan run" : "Request a CVE scan";
    case "createPreview":
      return `Create the preview for bundle ${key12(a.bundleKey)}`;
    case "smoke":
      return `Run the ${a.scope === "stg" ? "staging" : "preview"} smoke for bundle ${key12(a.bundleKey)}`;
    case "deployStg":
      return `Deploy bundle ${key12(a.bundleKey)} to staging`;
    case "signoff":
      return `Sign off bundle ${key12(a.bundleKey)}`;
  }
}

const Note = ({ children }: { children: ReactNode }) => <p style={{ margin: "12px 0 0", color: "var(--n-ink-muted)", lineHeight: 1.6, fontSize: 12 }}>{children}</p>;

/** What the gate's "done" phase shows, per action. `result` is whatever the
 * action returned inside the gate; it is cast by the action that was asked for. */
export function GateResultView({ action, result }: { action: LifecycleAction; result: unknown }) {
  if (action.kind === "run") {
    const r = result as RunResult;
    return (
      <div style={{ marginBottom: 14 }}>
        <Row label="queued"><Pill word="PENDING" /> {r.kind} run</Row>
        <Row label="request" last>{r.requestId}</Row>
        <Note>plo-dispatch claims pending requests every 5 minutes. The new snapshot replaces what this page shows as soon as it is posted; nothing on any cluster or repository changes.</Note>
      </div>
    );
  }
  if (action.kind === "smoke") {
    const r = result as SmokeResult;
    return (
      <div style={{ marginBottom: 14 }}>
        <Row label="queued"><Pill word="PENDING" /> {r.scope === "stg" ? "staging" : "preview"} smoke</Row>
        <Row label="targets">
          <div>
            {r.targets.map((t) => (
              <div key={t.name}>{t.name} <span style={muted}>{t.baseUrl}</span></div>
            ))}
          </div>
        </Row>
        <Row label="request" last>{r.requestId}</Row>
        <Note>plo-dispatch claims it within about 5 minutes and runs the checks; the verdict appears on this tab. A new run replaces the verdict of an earlier one for this bundle.</Note>
      </div>
    );
  }
  if (action.kind === "createPreview") {
    const r = result as PreviewResult;
    return (
      <div style={{ marginBottom: 14 }}>
        {r.created.map((e, i) => (
          <Row key={e.name} label={i === 0 ? "created" : ""}>
            <Pill word="RUNNING" title="building" />
            <Ext href={e.url}>{e.name}</Ext>
            <span style={muted}>{e.service}{e.unsetSecrets.length ? ` · ${e.unsetSecrets.length} declared secret${e.unsetSecrets.length === 1 ? "" : "s"} left unset: ${e.unsetSecrets.join(", ")}` : ""}</span>
          </Row>
        ))}
        {r.existing.map((e) => (
          <Row key={e.envName} label="kept">{e.envName} <span style={muted}>already exists for this bundle</span></Row>
        ))}
        {r.skipped.map((s) => (
          <Row key={s.github} label="skipped">{s.github} <span style={muted}>{s.reason}</span></Row>
        ))}
        <Row label="expires" last>in {r.ttlHours} h</Row>
        <Note>Each env is building now; the build-watcher promotes it when its image lands (a few minutes). Run the preview smoke once every env is up.{r.created.some((e) => e.unsetSecrets.length) ? " Set the unset secrets on /environments first if the service needs them to start." : ""}</Note>
      </div>
    );
  }
  if (action.kind === "deployStg") {
    const r = result as DeployResult;
    return (
      <div style={{ marginBottom: 14 }}>
        {r.promotions.map((p) => (
          <Row key={p.service} label="pr">
            <Pill word="AWAITING HUMAN" title="open; merging is the second gate, on /releases" />
            <Ext href={p.prUrl}>#{p.prNumber}</Ext>
            <span style={muted}>{p.service} → {p.imageTag}{p.existing ? " (already open — nothing new written)" : ""}</span>
          </Row>
        ))}
        {r.already.map((a) => (
          <Row key={a.service} label="kept">{a.service} <span style={muted}>{a.reason}</span></Row>
        ))}
        {r.noRoute.map((n) => (
          <Row key={n.github} label="no route">{n.github} <span style={muted}>deploys via the repo&rsquo;s own pipeline on merge</span></Row>
        ))}
        <Note>
          Nothing has deployed. Merge each promotion pull request on <a href="/releases" style={{ color: "var(--n-ion-soft)", textDecoration: "none" }}>/releases</a> (the existing merge gate); Argo CD then rolls it out, and the staging smoke becomes available here.
        </Note>
      </div>
    );
  }
  const r = result as SignoffResult;
  return (
    <div style={{ marginBottom: 14 }}>
      <Row label="signed off"><Pill word="PASS" /> bundle {r.key12} by {r.signedOffBy}</Row>
      <Row label="evidence">the {r.scope === "stg" ? "staging" : "preview"} smoke</Row>
      {r.comments.map((c) => (
        <Row key={`${c.repo}#${c.number}`} label="comment">
          <Pill word={c.status === "failed" ? "FAIL" : "PASS"} />
          {c.url ? <Ext href={c.url}>{c.repo}#{c.number}</Ext> : <span>{c.repo}#{c.number}</span>}
          <span style={muted}>{c.status === "already" ? "already commented" : c.status === "failed" ? `not posted: ${c.error ?? "unknown error"}` : "posted"}</span>
        </Row>
      ))}
      {r.skippedPrs.map((p) => (
        <Row key={`${p.repo}#${p.number}`} label="no comment">{p.repo}#{p.number} <span style={muted}>{p.reason}</span></Row>
      ))}
      <Row label="merged" last>nothing</Row>
      <Note>The sign-off is recorded in the audit log. No pull request was merged — merging each one stays a human action in GitHub.{r.comments.some((c) => c.status === "failed") ? " A comment that could not be posted does not undo the sign-off." : ""}</Note>
    </div>
  );
}
