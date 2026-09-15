"use client";

import { useEffect, useMemo, useState } from "react";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { TwizzYamlV2 } from "@twizz-idp/shared";
import type { Proposal } from "@twizz-idp/observer"; // type-only
import { trpc } from "@/lib/trpc-client";
import { Pill } from "@/components/nebula/pill";
import { Button } from "@/components/nebula/button";
import { Field, inputStyle } from "@/components/nebula/plate";
import { useConfigurator } from "@/lib/nebula/use-configurator";
import { validateTwizzObject } from "@/lib/nebula/repo-spin-up";

// Config section (docs/NEBULA.md §N3.7): the human sees the repo's current
// twizz.yaml, can let the Configurator propose one (read-only, audited, capped)
// or write it by hand; the text is validated live with the same zod schema
// the server enforces. Words: STUB / DENIED / RUNNING / PASS / FAIL.

const KEY_ORDER = ["version", "name", "kind", "port", "healthPath", "dockerfile", "context", "build", "env", "secrets", "needs", "frontend", "attach"] as const;

/** Same shape as packages/actions stringifyTwizzYaml (defaults omitted). */
export function twizzYamlToText(c: TwizzYamlV2): string {
  const out: Record<string, unknown> = {};
  for (const k of KEY_ORDER) {
    const v = (c as Record<string, unknown>)[k];
    if (v === undefined) continue;
    if (k === "dockerfile" && v === "Dockerfile") continue;
    if (k === "context" && v === ".") continue;
    if (k === "build" && Object.keys(c.build.args).length === 0) continue;
    if (k === "env" && Object.keys(c.env).length === 0) continue;
    if (k === "secrets" && c.secrets.length === 0) continue;
    if (k === "needs" && !c.needs.mongo && !c.needs.redis) continue;
    out[k] = v;
  }
  return "# Nebula per-repo config (docs/NEBULA.md §N3.7). Secrets are NAMES only; values live in the Nebula dashboard.\n" + stringifyYaml(out, { lineWidth: 0 });
}

const TEMPLATES: Record<"backend" | "frontend" | "worker", string> = {
  backend: twizzYamlToText({ version: 2, kind: "backend", port: 8080, healthPath: "/health", dockerfile: "Dockerfile", context: ".", build: { args: {} }, env: {}, secrets: [], needs: { mongo: true, redis: false } }),
  worker: twizzYamlToText({ version: 2, kind: "worker", port: 8080, healthPath: "/health", dockerfile: "Dockerfile", context: ".", build: { args: {} }, env: {}, secrets: [], needs: { mongo: true, redis: false } }),
  frontend: twizzYamlToText({ version: 2, kind: "frontend", port: 80, healthPath: "/", dockerfile: "Dockerfile", context: ".", build: { args: { VITE_API_URL: "${NEBULA_API_URL}" } }, env: {}, secrets: [], needs: { mongo: false, redis: false }, frontend: { framework: "vite", apiEnvVar: "VITE_API_URL", serve: "static" } }),
};

export type ConfigState = {
  text: string;
  config: TwizzYamlV2 | null;
  issues: string[];
  proposal: Proposal | null;
  useDockerfile: boolean;
  /** true when the text is exactly the repo's current twizz.yaml and no Dockerfile is proposed */
  unchanged: boolean;
  existing: { twizzYaml: string | null; hasDockerfile: boolean; dockerfilePath: string } | null;
};

export function parseText(text: string): { config: TwizzYamlV2 | null; issues: string[] } {
  if (!text.trim()) return { config: null, issues: [] };
  let value: unknown;
  try {
    value = parseYaml(text);
  } catch (e) {
    return { config: null, issues: [`YAML: ${String((e as Error).message ?? e).split("\n")[0]}`] };
  }
  const r = validateTwizzObject({ ok: true, value });
  return r.ok ? { config: r.config, issues: [] } : { config: null, issues: r.issues };
}

export function ConfigSection({ repo, ref, sha, kindHint, onChange, disabled }: { repo: string; ref: string; sha: string | null; kindHint?: "backend" | "frontend" | "worker"; onChange: (s: ConfigState) => void; disabled?: boolean }) {
  const existing = trpc.project.repoConfig.useQuery({ repo, sha: sha ?? "" }, { enabled: !!sha, staleTime: 60_000, retry: false });
  const status = trpc.observer.configuratorStatus.useQuery(undefined, { refetchInterval: 60_000, retry: false });
  const cfg = useConfigurator();
  const [text, setText] = useState("");
  const [hints, setHints] = useState("");
  const [useDockerfile, setUseDockerfile] = useState(true);
  const [seeded, setSeeded] = useState<string | null>(null);

  // seed the editor with the repo's own twizz.yaml once per commit
  useEffect(() => {
    if (!existing.data || seeded === sha) return;
    setSeeded(sha);
    setText(existing.data.twizzYaml ?? "");
    cfg.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existing.data, sha]);

  // a proposal lands in the editor as text (the human keeps editing it)
  useEffect(() => {
    if (cfg.run.proposal) {
      setText(twizzYamlToText(cfg.run.proposal.twizzYaml));
      setUseDockerfile(!!cfg.run.proposal.dockerfile);
    }
  }, [cfg.run.proposal]);

  const parsed = useMemo(() => parseText(text), [text]);
  useEffect(() => {
    const ex = existing.data ? { twizzYaml: existing.data.twizzYaml, hasDockerfile: existing.data.hasDockerfile, dockerfilePath: existing.data.dockerfilePath } : null;
    const unchanged = !!ex && ex.twizzYaml !== null && ex.twizzYaml === text && !(useDockerfile && cfg.run.proposal?.dockerfile);
    onChange({ text, config: parsed.config, issues: parsed.issues, proposal: cfg.run.proposal, useDockerfile, unchanged, existing: ex });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, parsed, cfg.run.proposal, useDockerfile, existing.data]);

  const word = cfg.run.word ?? (status.data?.word === "PASS" ? null : status.data?.word ?? null);
  const canRun = !!sha && !!status.data?.configured && status.data.word !== "DENIED" && !cfg.busy && !disabled;
  const p = cfg.run.proposal;

  return (
    <Field label="configuration" hint="twizz.yaml v2 is the repo's Nebula contract: kind, port, health path, build args (public only), secret NAMES. It is committed on a nebula/<env> branch and proposed as a PR into your branch.">
      {existing.isLoading && sha && <div style={{ fontSize: 11, color: "var(--n-ink-muted)", marginBottom: 8 }}><Pill word="PENDING" /> reading twizz.yaml + Dockerfile at {sha.slice(0, 7)}…</div>}
      {existing.data && (
        <div style={{ fontSize: 11, color: "var(--n-ink-muted)", marginBottom: 8, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {existing.data.twizzYaml === null ? <><Pill word="UNONBOARDED" /> no twizz.yaml in the repo yet</> : existing.data.valid ? <><Pill word="PASS" /> twizz.yaml {existing.data.legacy ? "v1 (legacy — upgraded on the fly)" : "v2"} found</> : <><Pill word="FAIL" /> twizz.yaml exists but is invalid</>}
          <span>· {existing.data.hasDockerfile ? `Dockerfile at ${existing.data.dockerfilePath}` : `no Dockerfile at ${existing.data.dockerfilePath}`}</span>
        </div>
      )}

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
        <Button variant="ion" disabled={!canRun} onClick={() => cfg.start({ repo, ref, sha: sha!, hints: hints || undefined, kindHint })} style={{ padding: "5px 9px", fontSize: 10 }} title={status.data?.reason}>
          Let Nebula configure it
        </Button>
        {cfg.busy && <Button variant="danger" onClick={cfg.stop} style={{ padding: "5px 9px", fontSize: 10 }}>Stop</Button>}
        {(["backend", "frontend", "worker"] as const).map((k) => (
          <Button key={k} disabled={disabled || cfg.busy} onClick={() => { cfg.reset(); setText(TEMPLATES[k]); }} style={{ padding: "5px 9px", fontSize: 10 }}>
            by hand · {k}
          </Button>
        ))}
        {word && <Pill word={word} title={cfg.run.error ?? status.data?.reason} />}
        {status.data && <span style={{ fontSize: 10, color: "var(--n-ink-faint)" }}>runs today {status.data.actorRunsToday}/{status.data.perActorCap} (you) · {status.data.runsToday}/{status.data.dailyCap} (all)</span>}
      </div>
      <input value={hints} onChange={(e) => setHints(e.target.value)} disabled={cfg.busy || disabled} placeholder="hints for the Configurator (optional): e.g. Vite app, API var is VITE_API_URL; monorepo package apps/api" style={{ ...inputStyle, marginBottom: 8, fontSize: 11 }} maxLength={2000} />

      {(cfg.busy || cfg.run.tools.length > 0 || cfg.run.error) && (
        <div style={{ background: "var(--n-plate)", border: `1px solid ${cfg.busy ? "var(--n-ion)" : "var(--n-hairline)"}`, borderRadius: "var(--n-radius)", padding: "8px 10px", marginBottom: 8, fontSize: 10, color: "var(--n-ink-muted)" }}>
          {cfg.run.tools.map((t, i) => <div key={i} style={{ wordBreak: "break-word" }}>⌁ {t}</div>)}
          {cfg.busy && <div><Pill word="RUNNING" /> {cfg.run.note || "thinking…"}</div>}
          {cfg.run.error && <div style={{ color: "var(--n-fail)" }}><Pill word={cfg.run.word ?? "FAIL"} /> {cfg.run.error}</div>}
          {cfg.run.text && !cfg.busy && <div style={{ whiteSpace: "pre-wrap", color: "var(--n-ink)", marginTop: 4 }}>{cfg.run.text}</div>}
        </div>
      )}

      {p && (
        <div style={{ background: "var(--n-plate)", border: "1px solid var(--n-hairline)", borderRadius: "var(--n-radius)", padding: "8px 10px", marginBottom: 8, fontSize: 11, lineHeight: 1.5 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <Pill word="PASS" /> proposal · <span style={{ color: "var(--n-ink-muted)" }}>confidence: {p.confidence}</span>
          </div>
          {p.basedOn.length > 0 && <div style={{ color: "var(--n-ink-muted)", marginTop: 4 }}>based on: {p.basedOn.join(" · ")}</div>}
          {p.notes.length > 0 && <ul style={{ margin: "4px 0 0", paddingLeft: 16 }}>{p.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
          {p.needsHuman.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <Pill word="AWAITING HUMAN" /> <span style={{ color: "var(--n-ink-muted)" }}>decisions the Configurator could not make:</span>
              <ul style={{ margin: "4px 0 0", paddingLeft: 16 }}>{p.needsHuman.map((n, i) => <li key={i}>{n}</li>)}</ul>
            </div>
          )}
          {p.dockerfile && (
            <details style={{ marginTop: 8 }}>
              <summary style={{ cursor: "pointer" }}>
                <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }} onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={useDockerfile} onChange={(e) => setUseDockerfile(e.target.checked)} disabled={disabled} /> commit proposed {p.dockerfile.path}
                </label>
                <span style={{ color: "var(--n-ink-muted)" }}> — {p.dockerfile.reason}</span>
              </summary>
              <pre style={{ margin: "6px 0 0", padding: 8, fontSize: 10, background: "var(--n-surface)", border: "1px solid var(--n-hairline)", borderRadius: "var(--n-radius)", overflowX: "auto", maxHeight: 260 }}>{p.dockerfile.content}</pre>
            </details>
          )}
        </div>
      )}

      <textarea value={text} onChange={(e) => setText(e.target.value)} disabled={disabled || cfg.busy} rows={Math.min(22, Math.max(8, text.split("\n").length + 1))} spellCheck={false} placeholder="# twizz.yaml — let Nebula configure it, pick a template, or paste your own" style={{ ...inputStyle, fontFamily: "inherit", fontSize: 11, lineHeight: 1.5, resize: "vertical", whiteSpace: "pre" }} />
      <div style={{ marginTop: 6, fontSize: 11 }}>
        {text.trim() && parsed.config && <span style={{ color: "var(--n-ink-muted)" }}><Pill word="PASS" /> valid v2 · {parsed.config.kind} · port {parsed.config.port} · health {parsed.config.healthPath}{parsed.config.secrets.length ? ` · ${parsed.config.secrets.length} secret name${parsed.config.secrets.length === 1 ? "" : "s"}` : ""}</span>}
        {parsed.issues.length > 0 && (
          <ul style={{ margin: 0, paddingLeft: 16, color: "var(--n-fail)" }}>{parsed.issues.map((i) => <li key={i}>{i}</li>)}</ul>
        )}
      </div>
    </Field>
  );
}
