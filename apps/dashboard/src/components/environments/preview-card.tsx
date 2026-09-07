"use client";

import { useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@/server/routers/_app";
import { Pill } from "@/components/nebula/pill";
import { Button } from "@/components/nebula/button";
import { Row } from "@/components/nebula/plate";

export type NamedEnvView = inferRouterOutputs<AppRouter>["actions"]["listEnvs"]["envs"][number];

// The signature object (docs/NEBULA.md §2): `<env>.<host>` with one row per
// fact, each a coloured WORD + a value. Every word here is real data — the
// Argo row comes from the Application CR, the TTL from the manifest.
export const ISOLATION_CAVEAT = "DB-isolated, not side-effect-isolated: SQS, S3 and third-party keys are shared with staging.";

export function PreviewCard({
  env,
  operator,
  onExtend,
  onReclone,
  onTeardown,
}: {
  env: NamedEnvView;
  operator: boolean;
  onExtend: (env: NamedEnvView, ttlHours: number) => void;
  onReclone: (env: NamedEnvView) => void;
  onTeardown: (env: NamedEnvView) => void;
}) {
  const [ttl, setTtl] = useState(168);
  const host = env.url.replace(/^https:\/\//, "");
  const shortTag = env.imageTag.replace(/^build-/, "").slice(0, 8);
  const expiresLocal = new Date(env.expiresAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

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
          <span title={env.imageTag}>build-{shortTag}…</span>
          <span style={{ color: "var(--n-ink-faint)", fontSize: 10 }}>immutable</span>
        </Row>
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
        <Row label="owner" last>
          <span>{env.owner}</span>
        </Row>
      </div>

      {/* Isolation honesty (docs/NEBULA.md §4.1a) — on every card, always */}
      <p style={{ margin: "12px 0 0", padding: "8px 10px", fontSize: 10, lineHeight: 1.5, color: "var(--n-ink-muted)", background: "var(--n-plate)", border: "1px solid var(--n-hairline)", borderRadius: "var(--n-radius)" }}>
        {ISOLATION_CAVEAT}
      </p>

      <footer style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
        {operator ? (
          <>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <Button onClick={() => onExtend(env, ttl)}>Extend</Button>
              <select
                value={ttl}
                onChange={(e) => setTtl(Number(e.target.value))}
                aria-label="Extend to (hours from now)"
                style={{ background: "var(--n-plate)", border: "1px solid var(--n-hairline-strong)", color: "var(--n-ink-muted)", borderRadius: "var(--n-radius)", fontSize: 10, padding: "6px 4px" }}
              >
                <option value={24}>+24h</option>
                <option value={72}>+3d</option>
                <option value={168}>+7d</option>
                <option value={336}>+14d</option>
              </select>
            </span>
            <Button onClick={() => onReclone(env)}>Re-clone db</Button>
            <Button variant="danger" onClick={() => onTeardown(env)} style={{ marginLeft: "auto" }}>
              Tear down
            </Button>
          </>
        ) : (
          <>
            <Button disabled>Extend</Button>
            <Button disabled>Re-clone db</Button>
            <Button disabled>Tear down</Button>
            <span style={{ marginLeft: "auto" }}>
              <Pill word="READ-ONLY" title="Your GitHub login is not in NEBULA_OPERATORS" />
            </span>
          </>
        )}
      </footer>
    </article>
  );
}
