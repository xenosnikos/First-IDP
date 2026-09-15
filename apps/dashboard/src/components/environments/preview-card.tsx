"use client";

import { useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@/server/routers/_app";
import { Pill } from "@/components/nebula/pill";
import { Button } from "@/components/nebula/button";
import { Row } from "@/components/nebula/plate";

export type NamedEnvView = inferRouterOutputs<AppRouter>["nebula"]["listEnvironments"]["named"][number];

// The signature object (docs/NEBULA.md §2): `<env>.<host>` with one row per
// fact, each a coloured WORD + a value. Every word here is real data — the
// Argo row comes from the Application CR, the TTL from the manifest.
export const ISOLATION_CAVEAT = "DB-isolated, not side-effect-isolated: SQS, S3 and third-party keys are shared with staging.";

export function PreviewCard({
  env,
  operator,
  owner,
  onExtend,
  onReclone,
  onTeardown,
  onRebuild,
  onEnvVars,
}: {
  env: NamedEnvView;
  operator: boolean;
  /** the signed-in human owns this env (manifest.owner) */
  owner: boolean;
  onExtend: (env: NamedEnvView, ttlHours: number) => void;
  onReclone: (env: NamedEnvView) => void;
  onTeardown: (env: NamedEnvView) => void;
  onRebuild?: (env: NamedEnvView) => void;
  onEnvVars?: (env: NamedEnvView, vars: Record<string, string>) => void;
}) {
  const [ttl, setTtl] = useState(168);
  const [varsOpen, setVarsOpen] = useState(false);
  const [varsText, setVarsText] = useState("");
  const host = env.url.replace(/^https:\/\//, "");
  const nebulaBuilt = !!env.source;
  const shortTag = (env.imageTag ?? "building").replace(/^build-/, "").replace(/^nb-.*-([0-9a-f]{12})$/, "$1").slice(0, 12);
  const expiresLocal = new Date(env.expiresAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const canAct = operator || owner;
  const parsedVars = (() => {
    const out: Record<string, string> = {};
    let bad = 0;
    for (const line of varsText.split("\n")) {
      if (!line.trim()) continue;
      const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (m) out[m[1]] = m[2].trim();
      else bad++;
    }
    return { out, bad };
  })();

  return (
    <article className="n-plate" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 0, minWidth: 0 }}>
      <header style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, paddingBottom: 12, borderBottom: "1px solid var(--n-hairline)" }}>
        <div style={{ minWidth: 0 }}>
          <div className="n-display" style={{ fontSize: 22, lineHeight: 1.15, wordBreak: "break-all" }}>
            {env.name}
            <span style={{ color: "var(--n-ink-faint)" }}>.prv.twizz.com</span>
          </div>
          <div style={{ color: "var(--n-ink-muted)", fontSize: 11, marginTop: 4 }}>
            {env.service} · ns {env.namespace}
          </div>
        </div>
        <Pill word={env.argo.word} title={env.argo.detail} />
      </header>

      <div>
        <Row label="url">
          <a href={env.url} target="_blank" rel="noreferrer" style={{ color: "var(--n-ion-soft)", textDecoration: "none" }}>
            {host} ↗
          </a>
          <span style={{ color: "var(--n-ink-faint)", fontSize: 10 }}>VPN + SSO</span>
        </Row>
        <Row label="release">
          <span title={env.imageTag}>{nebulaBuilt ? `nb-…${shortTag}` : `build-${shortTag}…`}</span>
          <span style={{ color: "var(--n-ink-faint)", fontSize: 10 }}>immutable</span>
        </Row>
        {env.source && (
          <Row label="source">
            <span>{env.source.repo.replace(/^twizz-app\//, "")} @ {env.source.ref}</span>
            <span style={{ color: "var(--n-ink-faint)", fontSize: 10 }}>{env.source.sha.slice(0, 7)}</span>
            {env.source.prUrl && <a href={env.source.prUrl} target="_blank" rel="noreferrer" style={{ color: "var(--n-ion-soft)", textDecoration: "none" }}>PR #{env.source.prNumber} ↗</a>}
          </Row>
        )}
        {env.build && (
          <Row label="build">
            <Pill word={env.build.status === "PASS" ? "PASS" : env.build.status === "FAIL" ? "FAIL" : env.build.status === "RUNNING" ? "RUNNING" : "PENDING"} title={env.build.reason} />
            <span style={{ color: "var(--n-ink-muted)" }}>{env.build.finishedAt ? new Date(env.build.finishedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : env.build.reason ?? ""}</span>
            {env.build.runUrl && <a href={env.build.runUrl} target="_blank" rel="noreferrer" style={{ color: "var(--n-ion-soft)", textDecoration: "none" }}>run ↗</a>}
            {env.config && <span style={{ color: "var(--n-ink-faint)", fontSize: 10 }}>config rev {env.config.rev}</span>}
          </Row>
        )}
        <Row label="argo">
          <Pill word={env.argo.word} />
          <span style={{ color: "var(--n-ink-muted)" }}>{env.argo.detail}</span>
        </Row>
        <Row label="db">
          <span>{env.db.mode}</span>
          <span style={{ color: "var(--n-ink-muted)" }}>{env.dbName}</span>
          <span style={{ color: "var(--n-ink-faint)", fontSize: 10 }}>gen {env.db.generation}</span>
        </Row>
        <Row label="expires">
          {env.ttl.word && <Pill word={env.ttl.word} />}
          <span>{env.ttl.remaining}</span>
          <span style={{ color: "var(--n-ink-faint)", fontSize: 10 }} title={env.expiresAt}>{expiresLocal}</span>
        </Row>
        <Row label="origins">
          {env.frontendOrigins.length === 0 && <span style={{ color: "var(--n-ink-faint)" }}>none (no CORS)</span>}
          {env.frontendOrigins.map((o) => (
            <span key={o} style={{ fontSize: 10, padding: "0 6px", border: "1px solid var(--n-hairline-strong)", borderRadius: 3, color: "var(--n-ink-muted)" }}>{o.replace(/^https:\/\//, "")}</span>
          ))}
        </Row>
        <Row label="owner" last>
          <span>{env.owner}</span>
          <Pill word="NAMED" title="Provisioned by Nebula from named-envs/<name>.yaml; the only kind with actions" />
          {owner && <span style={{ color: "var(--n-ink-faint)", fontSize: 10 }}>you</span>}
        </Row>
      </div>

      {/* Isolation honesty (docs/NEBULA.md §4.1a) — on every card, always */}
      <p style={{ margin: "12px 0 0", padding: "8px 10px", fontSize: 10, lineHeight: 1.5, color: "var(--n-ink-muted)", background: "var(--n-plate)", border: "1px solid var(--n-hairline)", borderRadius: "var(--n-radius)" }}>
        {ISOLATION_CAVEAT}
      </p>

      <footer style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <Button disabled={!canAct} onClick={() => onExtend(env, ttl)}>Extend</Button>
          <select
            value={ttl}
            onChange={(e) => setTtl(Number(e.target.value))}
            aria-label="Extend to (hours from now)"
            disabled={!canAct}
            style={{ background: "var(--n-plate)", border: "1px solid var(--n-hairline-strong)", color: "var(--n-ink-muted)", borderRadius: "var(--n-radius)", fontSize: 10, padding: "6px 4px" }}
          >
            <option value={24}>+24h</option>
            <option value={72}>+3d</option>
            <option value={168}>+7d</option>
            <option value={336}>+14d</option>
          </select>
        </span>
        {env.service === "moly-backend" && <Button disabled={!operator} onClick={() => onReclone(env)} title={operator ? undefined : "operators only"}>Re-clone db</Button>}
        {nebulaBuilt && onRebuild && <Button disabled={!canAct || env.build?.status === "RUNNING" || env.build?.status === "PENDING"} onClick={() => onRebuild(env)} title="re-dispatch the builder at the branch's current head">Rebuild from ref</Button>}
        {nebulaBuilt && onEnvVars && <Button disabled={!canAct} onClick={() => setVarsOpen((v) => !v)}>Env vars</Button>}
        <Button variant="danger" disabled={!canAct} onClick={() => onTeardown(env)} style={{ marginLeft: "auto" }}>
          Tear down
        </Button>
        {!canAct && <Pill word="READ-ONLY" title="Only the owner or a Nebula operator may act on this env" />}
      </footer>
      {varsOpen && onEnvVars && (
        <div style={{ marginTop: 10 }}>
          <div className="n-label" style={{ marginBottom: 4 }}>env vars · KEY=value per line · blank value deletes</div>
          {env.config && env.config.envVarNames.length > 0 && <div style={{ fontSize: 10, color: "var(--n-ink-faint)", marginBottom: 4 }}>set now: {env.config.envVarNames.join(", ")} (values are never shown)</div>}
          <textarea value={varsText} onChange={(e) => setVarsText(e.target.value)} rows={3} spellCheck={false} placeholder={"LOG_LEVEL=debug\nOLD_KEY="} style={{ width: "100%", padding: "6px 8px", background: "var(--n-plate)", border: "1px solid var(--n-hairline-strong)", borderRadius: "var(--n-radius)", color: "var(--n-ink)", fontSize: 11, fontFamily: "inherit", resize: "vertical" }} />
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 6, alignItems: "center" }}>
            {parsedVars.bad > 0 && <span style={{ fontSize: 10, color: "var(--n-fail)" }}>{parsedVars.bad} line{parsedVars.bad === 1 ? "" : "s"} not KEY=value</span>}
            <Button disabled={Object.keys(parsedVars.out).length === 0 || parsedVars.bad > 0} onClick={() => { onEnvVars(env, parsedVars.out); setVarsText(""); setVarsOpen(false); }}>Review with the gate</Button>
          </div>
        </div>
      )}
    </article>
  );
}
