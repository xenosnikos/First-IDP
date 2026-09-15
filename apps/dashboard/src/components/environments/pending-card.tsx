"use client";

import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@/server/routers/_app";
import { Pill } from "@/components/nebula/pill";
import { Button } from "@/components/nebula/button";
import { Row } from "@/components/nebula/plate";

export type PendingEnvView = inferRouterOutputs<AppRouter>["nebula"]["listEnvironments"]["pending"][number];

/** A build-on-provision env that has no Argo Application yet: the central
 * builder is running (RUNNING) or failed (FAIL). Words only, never colours. */
export function PendingCard({ env, canAct, onRebuild, onTeardown }: { env: PendingEnvView; canAct: boolean; onRebuild: (env: PendingEnvView) => void; onTeardown: (env: PendingEnvView) => void }) {
  const b = env.build;
  const started = b?.startedAt ? new Date(b.startedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";
  return (
    <article className="n-plate" style={{ padding: 16, minWidth: 0, borderStyle: env.word === "FAIL" ? "solid" : "dashed" }}>
      <header style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, paddingBottom: 12, borderBottom: "1px solid var(--n-hairline)" }}>
        <div style={{ minWidth: 0 }}>
          <div className="n-display" style={{ fontSize: 22, lineHeight: 1.15, wordBreak: "break-all" }}>
            {env.name}
            <span style={{ color: "var(--n-ink-faint)" }}>.prv.twizz.com</span>
          </div>
          <div style={{ color: "var(--n-ink-muted)", fontSize: 11, marginTop: 4 }}>{env.service} · {env.kind} · not deployed yet</div>
        </div>
        <Pill word={env.word} title={b?.reason ?? (env.word === "RUNNING" ? "the central builder is producing the image" : undefined)} />
      </header>
      <div>
        <Row label="build">
          <Pill word={env.word} />
          <span style={{ color: "var(--n-ink-muted)" }}>{b?.status === "PENDING" ? "dispatched, waiting for the run" : b?.status === "RUNNING" ? "building" : b?.status === "FAIL" ? (b.reason ?? "failed") : b?.status ?? "—"}</span>
          {b?.runUrl && <a href={b.runUrl} target="_blank" rel="noreferrer" style={{ color: "var(--n-ion-soft)", textDecoration: "none" }}>run ↗</a>}
        </Row>
        <Row label="tag"><span title={b?.expectedTag}>{b?.expectedTag ?? "—"}</span><span style={{ color: "var(--n-ink-faint)", fontSize: 10 }}>started {started}</span></Row>
        {env.source && (
          <Row label="source">
            <span>{env.source.repo.replace(/^twizz-app\//, "")} @ {env.source.ref}</span>
            <span style={{ color: "var(--n-ink-faint)", fontSize: 10 }}>{env.source.sha.slice(0, 7)}</span>
            {env.source.prUrl && <a href={env.source.prUrl} target="_blank" rel="noreferrer" style={{ color: "var(--n-ion-soft)", textDecoration: "none" }}>PR #{env.source.prNumber} ↗</a>}
          </Row>
        )}
        <Row label="owner" last>
          <span>{env.owner}</span>
          <Pill word="NAMED" />
        </Row>
      </div>
      <footer style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
        <Button disabled={!canAct || env.word === "RUNNING"} onClick={() => onRebuild(env)} title={env.word === "RUNNING" ? "a build is already running" : "re-dispatch the builder at the branch's current head"}>Rebuild from ref</Button>
        <Button variant="danger" disabled={!canAct} onClick={() => onTeardown(env)} style={{ marginLeft: "auto" }}>Tear down</Button>
        {!canAct && <Pill word="READ-ONLY" title="Only the owner or a Nebula operator may act on this env" />}
      </footer>
    </article>
  );
}
