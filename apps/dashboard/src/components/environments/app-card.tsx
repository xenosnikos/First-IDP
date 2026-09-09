"use client";

import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@/server/routers/_app";
import { Pill } from "@/components/nebula/pill";
import { Row } from "@/components/nebula/plate";

export type AppView = inferRouterOutputs<AppRouter>["nebula"]["listEnvironments"]["others"][number];

// A read-only card for everything on non-prod that Nebula did not provision:
// PR previews (ApplicationSet PR generator) and standing gitops apps
// (twizz-support, shared-*). Same plate, same words, no actions — and no
// isolation caveat: that claim is only made for NAMED envs.
export function AppCard({ app }: { app: AppView }) {
  const shortImages = app.images.map((i) => i.replace(/^.*\/([^/]+)$/, "$1"));
  return (
    <article className="n-plate" style={{ padding: 16, display: "flex", flexDirection: "column", minWidth: 0 }}>
      <header style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, paddingBottom: 12, borderBottom: "1px solid var(--n-hairline)" }}>
        <div style={{ minWidth: 0 }}>
          <div className="n-display" style={{ fontSize: 22, lineHeight: 1.15, wordBreak: "break-all" }}>{app.name}</div>
          <div style={{ color: "var(--n-ink-muted)", fontSize: 11, marginTop: 4 }}>
            {app.service ? `${app.service} · ` : ""}ns {app.namespace} · project {app.project}
          </div>
        </div>
        <Pill word={app.word} title={app.detail} />
      </header>
      <div>
        <Row label="origin">
          <Pill word={app.origin} />
          {app.pr && (
            <a href={app.pr.url} target="_blank" rel="noreferrer" style={{ color: "var(--n-ion-soft)", textDecoration: "none" }}>
              {app.pr.repo}#{app.pr.number} ↗
            </a>
          )}
          {!app.pr && app.sourceRepos.map((r) => (
            <a key={r} href={`https://github.com/${r}`} target="_blank" rel="noreferrer" style={{ color: "var(--n-ion-soft)", textDecoration: "none" }}>
              {r} ↗
            </a>
          ))}
        </Row>
        <Row label="url">
          {app.hosts.length === 0 && <span style={{ color: "var(--n-ink-faint)" }}>no ingress (cluster-internal)</span>}
          {app.hosts.map((h) => (
            <a key={h} href={`https://${h}`} target="_blank" rel="noreferrer" style={{ color: "var(--n-ion-soft)", textDecoration: "none" }}>
              {h} ↗
            </a>
          ))}
        </Row>
        <Row label="argo">
          <Pill word={app.word} />
          <span style={{ color: "var(--n-ink-muted)" }}>{app.detail}</span>
        </Row>
        <Row label="images" last>
          {shortImages.length === 0 && <span style={{ color: "var(--n-ink-faint)" }}>no Deployment</span>}
          {shortImages.map((i, idx) => (
            <span key={idx} title={app.images[idx]} style={{ fontSize: 10, padding: "0 6px", border: "1px solid var(--n-hairline-strong)", borderRadius: 3, color: "var(--n-ink-muted)", wordBreak: "break-all" }}>{i}</span>
          ))}
        </Row>
      </div>
      <footer style={{ marginTop: 12, display: "flex", justifyContent: "flex-end" }}>
        <Pill word="READ-ONLY" title={app.origin === "PR PREVIEW" ? "Lifecycle is the PR's `preview` label" : "Lifecycle is its gitops manifest"} />
      </footer>
    </article>
  );
}
