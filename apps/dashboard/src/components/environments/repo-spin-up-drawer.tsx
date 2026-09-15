"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { Drawer } from "@/components/nebula/drawer";
import { Pill } from "@/components/nebula/pill";
import { Button } from "@/components/nebula/button";
import { Field, inputStyle, Row } from "@/components/nebula/plate";
import { GateDialog } from "@/components/nebula/gate-dialog";
import { useGatedAction, type GateResult } from "@/lib/nebula/use-gated-action";
import { buildArgPreview, problemsFor, proposalToFiles, slugEnvName, TTL } from "@/lib/nebula/repo-spin-up";
import { BranchPicker, RepoPicker, type RepoPick } from "./repo-spin-up/pickers";
import { ConfigSection, type ConfigState } from "./repo-spin-up/config-section";
import { ISOLATION_CAVEAT } from "./preview-card";

// "Spin up from a repo" (docs/NEBULA.md §N3.7): any twizz-app repo, an
// existing or new branch, a twizz.yaml the Configurator proposes or the human
// writes, secrets typed here (never in git), one human gate → branch + config PR
// + pending manifest + central build. Self-service for every signed-in user.

type CreateResult = {
  name: string;
  url: string;
  service: string;
  kind: string;
  expectedTag: string;
  secret: string;
  displayTitle: string;
  source: { ref: string; sha: string };
  pr?: { number: number; url: string };
  prDefault?: { number: number; url: string };
  branchCreated: boolean;
  unsetSecrets: string[];
};

type Attach = { env: string } | { url: string } | null;

const emptyConfig: ConfigState = { text: "", config: null, issues: [], proposal: null, useDockerfile: true, unchanged: false, existing: null };

export function RepoSpinUpDrawer({ open, onClose, onCreated, preselect }: { open: boolean; onClose: () => void; onCreated: () => void; preselect?: RepoPick | null }) {
  const [repo, setRepo] = useState<RepoPick | null>(preselect ?? null);
  const [branchMode, setBranchMode] = useState<"existing" | "new">("existing");
  const [branch, setBranch] = useState("");
  const [newBranchFrom, setNewBranchFrom] = useState("");
  const [cfg, setCfg] = useState<ConfigState>(emptyConfig);
  const [envName, setEnvName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [ttlHours, setTtlHours] = useState<number>(TTL.default);
  const [db, setDb] = useState<"isolated" | "clone" | "none">("none");
  const [attach, setAttach] = useState<Attach>(null);
  const [attachUrlText, setAttachUrlText] = useState("");
  const [prTarget, setPrTarget] = useState<"chosen" | "chosen+default">("chosen");
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [overridesText, setOverridesText] = useState("");
  const secretsRef = useRef<Record<string, string>>({});
  secretsRef.current = secretValues;

  useEffect(() => {
    if (open && preselect) {
      setRepo(preselect);
      setBranch(preselect.defaultBranch);
      setNewBranchFrom(preselect.defaultBranch);
    }
  }, [open, preselect]);

  const pinnedBranch = branchMode === "existing" ? branch : newBranchFrom;
  const head = trpc.project.getBranchHead.useQuery({ repo: repo?.fullName ?? "", branch: pinnedBranch }, { enabled: !!repo && !!pinnedBranch, staleTime: 15_000, retry: false });
  const headSha = head.data?.sha ?? null;
  const me = trpc.actions.me.useQuery(undefined, { staleTime: 60_000 });
  const envs = trpc.nebula.listEnvironments.useQuery(undefined, { enabled: open, staleTime: 30_000, retry: false });
  const backends = useMemo(() => (envs.data?.named ?? []).filter((e) => e.kind === "backend"), [envs.data]);

  // env name follows repo + branch until the human edits it
  useEffect(() => {
    if (!nameTouched && repo) setEnvName(slugEnvName(repo.fullName, branchMode === "existing" ? branch : branch || newBranchFrom));
  }, [repo, branch, newBranchFrom, branchMode, nameTouched]);

  // db mode follows the config
  useEffect(() => {
    if (!cfg.config) return;
    const isMoly = /moly-backend/i.test(repo?.fullName ?? "");
    setDb((d) => (cfg.config!.needs.mongo || isMoly ? (d === "none" ? "isolated" : d) : "none"));
  }, [cfg.config, repo]);

  const overrides = useMemo(() => {
    const out: Record<string, string> = {};
    for (const line of overridesText.split("\n")) {
      const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (m) out[m[1]] = m[2].trim();
    }
    return out;
  }, [overridesText]);
  const badOverrideLines = overridesText.split("\n").filter((l) => l.trim() && !/^\s*[A-Z][A-Z0-9_]*\s*=/.test(l));

  const secretNames = cfg.config?.secrets ?? [];
  const attachUrl = attach && "env" in attach ? `https://${attach.env}.prv.twizz.com` : attach && "url" in attach ? attach.url : undefined;
  const files = cfg.unchanged ? [] : proposalToFiles(cfg.text, cfg.proposal, cfg.useDockerfile);
  const dockerfileMissing = !!cfg.config && !!cfg.existing && !cfg.existing.hasDockerfile && !(cfg.useDockerfile && cfg.proposal?.dockerfile);

  const problems = problemsFor({ repo: repo?.fullName ?? null, branchMode, branch, newBranchFrom, headSha, envName, ttlHours, config: cfg.config, configIssues: cfg.issues, attach, db });
  if (dockerfileMissing) problems.push(`no Dockerfile at ${cfg.existing?.dockerfilePath ?? "Dockerfile"} — let Nebula configure it (it proposes one) or set dockerfile/context in twizz.yaml`);
  if (badOverrideLines.length) problems.push(`env overrides must be KEY=value lines (${badOverrideLines.length} bad line${badOverrideLines.length === 1 ? "" : "s"})`);
  if (head.error) problems.push(`branch head: ${head.error.message}`);
  const ready = problems.length === 0;

  const create = trpc.actions.createEnvFromRepo.useMutation();
  type Args = { name: string; repo: string; ref: string; sha: string; newBranch?: { from: string }; defaultBranch?: string; db: "isolated" | "clone" | "none"; ttlHours: number; attach?: { env: string } | { url: string }; files: Array<{ path: string; content: string }>; twizzYaml: string; secretNames: string[]; envOverrides: Record<string, string>; prTarget: "chosen" | "chosen+default" };
  const run = useCallback(
    async (args: Args & { confirm?: string }): Promise<GateResult> => {
      // secret VALUES ride only with the confirm nonce; the request call carries names
      const secretValues = args.confirm ? Object.fromEntries(args.secretNames.map((k) => [k, secretsRef.current[k] ?? ""])) : undefined;
      return (await create.mutateAsync({ ...args, secretValues })) as GateResult;
    },
    [create],
  );
  const gated = useGatedAction<Args, CreateResult>(run);

  const request = () => {
    if (!repo || !headSha) return;
    void gated.request({
      name: envName,
      repo: repo.fullName,
      ref: branch,
      sha: headSha,
      newBranch: branchMode === "new" ? { from: newBranchFrom } : undefined,
      defaultBranch: repo.defaultBranch,
      db,
      ttlHours,
      attach: attach ?? undefined,
      files,
      twizzYaml: cfg.text,
      secretNames,
      envOverrides: overrides,
      prTarget,
    });
  };

  const close = () => {
    gated.reset();
    onClose();
  };
  const finish = () => {
    gated.reset();
    onCreated();
    onClose();
  };
  const locked = gated.phase.kind !== "idle";
  const argPreview = buildArgPreview(cfg.config, { envName, attachUrl });

  return (
    <Drawer open={open} onClose={close} title="Spin up from a repo" width={640}>
      <p style={{ color: "var(--n-ink-muted)", margin: "0 0 18px", lineHeight: 1.6 }}>
        Any <b style={{ color: "var(--n-ink)" }}>twizz-app</b> repo, any branch: Nebula builds the commit with its Dockerfile and runs it at{" "}
        <span style={{ color: "var(--n-ion-soft)" }}>{envName || "<name>"}.prv.twizz.com</span> (VPN + SSO). The config lands as a PR into your branch; the preview does not wait for the merge.
      </p>

      {locked ? (
        <GateDialog<CreateResult>
          inline
          title="Create preview env"
          phase={gated.phase}
          onConfirm={gated.confirm}
          onClose={gated.phase.kind === "done" ? finish : () => gated.reset()}
          renderResult={(r) => (
            <div style={{ marginBottom: 14 }}>
              <Row label="url"><a href={r.url} target="_blank" rel="noreferrer" style={{ color: "var(--n-ion-soft)" }}>{r.url} ↗</a></Row>
              <Row label="build"><Pill word="PENDING" /> <span>{r.expectedTag}</span></Row>
              <Row label="source">{r.source.ref} @ {r.source.sha.slice(0, 7)}{r.branchCreated && <span style={{ color: "var(--n-ink-faint)", fontSize: 10 }}>branch created</span>}</Row>
              {r.pr && <Row label="config pr"><a href={r.pr.url} target="_blank" rel="noreferrer" style={{ color: "var(--n-ion-soft)" }}>#{r.pr.number} ↗</a>{r.prDefault && <a href={r.prDefault.url} target="_blank" rel="noreferrer" style={{ color: "var(--n-ion-soft)" }}>#{r.prDefault.number} → default ↗</a>}</Row>}
              <Row label="secret" last={r.unsetSecrets.length === 0}>{r.secret}</Row>
              {r.unsetSecrets.length > 0 && <Row label="unset" last><Pill word="AWAITING HUMAN" /> <span>{r.unsetSecrets.join(", ")} — set later from the card (env vars)</span></Row>}
              <p style={{ margin: "12px 0 0", color: "var(--n-ink-muted)", lineHeight: 1.6 }}>
                The builder runs in GitHub Actions (~2–6 min); the card shows <Pill word="RUNNING" /> with the run link, then the build-watcher promotes it and Argo brings the pod up: <Pill word="PASS" />.
              </p>
            </div>
          )}
        />
      ) : (
        <>
          <RepoPicker value={repo} onPick={(r) => { setRepo(r); setBranch(r.defaultBranch); setNewBranchFrom(r.defaultBranch); setNameTouched(false); setCfg(emptyConfig); setAttach(null); }} />

          {repo && <BranchPicker repo={repo} mode={branchMode} branch={branchMode === "existing" ? branch : branch} newBranchFrom={newBranchFrom} onMode={(m) => { setBranchMode(m); setBranch(m === "existing" ? repo.defaultBranch : ""); setNewBranchFrom(repo.defaultBranch); }} onBranch={setBranch} onNewBranchFrom={setNewBranchFrom} />}

          {repo && pinnedBranch && (
            <div style={{ fontSize: 11, color: "var(--n-ink-muted)", margin: "-6px 0 14px", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              {head.isLoading && <><Pill word="PENDING" /> reading head of {pinnedBranch}…</>}
              {head.error && <><Pill word="FAIL" /> {head.error.message}</>}
              {head.data && <><Pill word="PASS" /> {pinnedBranch} @ {head.data.sha.slice(0, 7)} · {head.data.message}{head.data.author ? ` · ${head.data.author}` : ""}{head.data.committedAt ? ` · ${new Date(head.data.committedAt).toLocaleString()}` : ""}</>}
            </div>
          )}

          {repo && headSha && <ConfigSection repo={repo.fullName} ref={pinnedBranch} sha={headSha} onChange={setCfg} />}

          {cfg.config && (
            <>
              <Field label="environment name" hint="DNS label; becomes namespace env-<name>, host <name>.prv.twizz.com, db nebula_<name>.">
                <input value={envName} onChange={(e) => { setNameTouched(true); setEnvName(e.target.value.trim().toLowerCase()); }} style={inputStyle} />
              </Field>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <Field label="ttl (hours)" hint={`Default ${TTL.default}h, max ${TTL.max}h; extend from the card.`}>
                  <input type="number" min={TTL.min} max={TTL.max} value={ttlHours} onChange={(e) => setTtlHours(Number(e.target.value))} style={inputStyle} />
                </Field>
                <Field label="database" hint={cfg.config.needs.mongo || /moly-backend/i.test(repo?.fullName ?? "") ? "isolated = an empty per-env db on the non-prod Atlas cluster." : "twizz.yaml does not declare needs.mongo → no database."}>
                  <select value={db} onChange={(e) => setDb(e.target.value as typeof db)} style={inputStyle} disabled={!cfg.config.needs.mongo && !/moly-backend/i.test(repo?.fullName ?? "")}>
                    <option value="none">none</option>
                    <option value="isolated">isolated (empty db)</option>
                    {/moly-backend/i.test(repo?.fullName ?? "") && <option value="clone">clone staging (moly-backend only)</option>}
                  </select>
                </Field>
              </div>

              {cfg.config.kind === "frontend" && (
                <Field label="attach to a backend" hint="The API this frontend is built against: a NAMED backend env (its CORS list gains this env's origin), the staging API, or any https://…twizz.com origin.">
                  <select value={attach && "env" in attach ? `env:${attach.env}` : attach && "url" in attach ? (attach.url === me.data?.stagingApiUrl ? "staging" : "custom") : ""} onChange={(e) => { const v = e.target.value; if (v.startsWith("env:")) setAttach({ env: v.slice(4) }); else if (v === "staging" && me.data?.stagingApiUrl) setAttach({ url: me.data.stagingApiUrl }); else if (v === "custom") setAttach(attachUrlText ? { url: attachUrlText } : null); else setAttach(null); }} style={{ ...inputStyle, marginBottom: 6 }}>
                    <option value="">— pick —</option>
                    {backends.map((b) => <option key={b.name} value={`env:${b.name}`}>{b.name} ({b.service}, {b.argo.word})</option>)}
                    {me.data?.stagingApiUrl && <option value="staging">staging API ({me.data.stagingApiUrl})</option>}
                    <option value="custom">custom https://…twizz.com origin</option>
                  </select>
                  {attach && "url" in attach && attach.url !== me.data?.stagingApiUrl && (
                    <input value={attachUrlText} onChange={(e) => { setAttachUrlText(e.target.value.trim()); setAttach({ url: e.target.value.trim() }); }} placeholder="https://api-x.prv.twizz.com" style={inputStyle} />
                  )}
                  {argPreview.length > 0 && (
                    <div style={{ marginTop: 6, fontSize: 10, color: "var(--n-ink-muted)" }}>
                      build args the image will bake:
                      {argPreview.map((a) => <div key={a.key} style={{ wordBreak: "break-all" }}>{a.key}={a.value}</div>)}
                    </div>
                  )}
                </Field>
              )}

              {secretNames.length > 0 && (
                <Field label="secrets" hint="Values go straight to AWS Secrets Manager (preview/<service>/<env>) and into the pod as env vars. Never in git, never in the audit log. Blank = set later from the card.">
                  {secretNames.map((k) => (
                    <div key={k} style={{ display: "grid", gridTemplateColumns: "minmax(120px, 1fr) 2fr", gap: 8, alignItems: "center", marginBottom: 6 }}>
                      <code style={{ fontSize: 11, wordBreak: "break-all" }}>{k}</code>
                      <input type="password" autoComplete="off" value={secretValues[k] ?? ""} onChange={(e) => setSecretValues((s) => ({ ...s, [k]: e.target.value }))} placeholder="(blank = set later)" style={inputStyle} />
                    </div>
                  ))}
                </Field>
              )}

              <Field label="env overrides (optional, KEY=value per line)" hint="Non-secret runtime values on top of twizz.yaml's env block. Anything credential-shaped is refused — declare it as a secret instead.">
                <textarea value={overridesText} onChange={(e) => setOverridesText(e.target.value)} rows={3} placeholder={"LOG_LEVEL=debug\nFEATURE_X=on"} style={{ ...inputStyle, fontFamily: "inherit", resize: "vertical" }} spellCheck={false} />
              </Field>

              <Field label="config pr" hint={cfg.unchanged ? "The branch already carries this exact twizz.yaml and a Dockerfile: nothing to commit, the commit builds as is." : `Nebula commits ${files.map((f) => f.path).join(" + ")} on nebula/${envName || "<name>"} and opens a PR into ${branch || "<branch>"}.`}>
                {!cfg.unchanged && repo && branch !== repo.defaultBranch && (
                  <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 11 }}>
                    <input type="checkbox" checked={prTarget === "chosen+default"} onChange={(e) => setPrTarget(e.target.checked ? "chosen+default" : "chosen")} /> also open a PR into {repo.defaultBranch} (the default branch)
                  </label>
                )}
                {(cfg.unchanged || !repo || branch === repo.defaultBranch) && <span style={{ fontSize: 11, color: "var(--n-ink-faint)" }}>{cfg.unchanged ? "no PR" : `→ ${branch || "<branch>"}`}</span>}
              </Field>
            </>
          )}

          <p style={{ margin: "4px 0 16px", padding: "8px 10px", fontSize: 10, lineHeight: 1.5, color: "var(--n-ink-muted)", background: "var(--n-plate)", border: "1px solid var(--n-hairline)", borderRadius: "var(--n-radius)" }}>{ISOLATION_CAVEAT}</p>

          {problems.length > 0 && repo && (
            <ul style={{ margin: "0 0 14px", paddingLeft: 16, color: "var(--n-fail)", fontSize: 11 }}>
              {problems.map((p) => <li key={p}>{p}</li>)}
            </ul>
          )}

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <span style={{ color: "var(--n-ink-faint)", fontSize: 10 }}>{me.data ? `as ${me.data.login} (owner of the env)` : ""}</span>
            <Button variant="ion" disabled={!ready} onClick={request}>Review with the gate</Button>
          </div>
        </>
      )}
    </Drawer>
  );
}
