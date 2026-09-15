"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { Pill } from "@/components/nebula/pill";
import { Field, inputStyle } from "@/components/nebula/plate";
import { DENIED_BRANCH_RE, isValidBranchName } from "@/lib/nebula/repo-spin-up";

export type RepoPick = { name: string; fullName: string; defaultBranch: string; language: string | null; pushedAt: string; private: boolean };

const listStyle = { border: "1px solid var(--n-hairline-strong)", borderRadius: "var(--n-radius)", maxHeight: 220, overflowY: "auto" as const, background: "var(--n-plate)" };
const rowStyle = (active: boolean) => ({
  display: "grid",
  gridTemplateColumns: "1fr auto",
  gap: 8,
  width: "100%",
  textAlign: "left" as const,
  padding: "7px 10px",
  background: active ? "color-mix(in oklab, var(--n-ion) 14%, transparent)" : "transparent",
  border: "none",
  borderBottom: "1px solid var(--n-hairline)",
  borderLeft: active ? "2px solid var(--n-ion)" : "2px solid transparent",
  color: "var(--n-ink)",
  fontFamily: "inherit",
  fontSize: 11,
  cursor: "pointer",
});

/** Repo section: search over twizz-app/* (session token → only what the human can already see). */
export function RepoPicker({ value, onPick, kinds }: { value: RepoPick | null; onPick: (r: RepoPick) => void; kinds?: Record<string, { kind: string; version: number } | null> }) {
  const [q, setQ] = useState("");
  const repos = trpc.project.listGithubRepos.useQuery({ q: q || undefined, limit: 60 }, { staleTime: 60_000, retry: false, placeholderData: (prev) => prev });
  return (
    <Field label="repository" hint={repos.data ? `${repos.data.total} repos in ${repos.data.org}; newest push first. Archived repos are hidden.` : undefined}>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="search twizz-app/…" style={{ ...inputStyle, marginBottom: 6 }} autoFocus={!value} />
      {repos.isLoading && <div style={{ color: "var(--n-ink-muted)", fontSize: 11 }}><Pill word="PENDING" /> listing org repos…</div>}
      {repos.error && <div style={{ color: "var(--n-fail)", fontSize: 11 }}><Pill word="FAIL" /> {repos.error.message}</div>}
      {repos.data && (
        <div style={listStyle}>
          {repos.data.repos.length === 0 && <div style={{ padding: 10, color: "var(--n-ink-muted)", fontSize: 11 }}>no repo matches “{q}”</div>}
          {repos.data.repos.map((r) => {
            const k = kinds?.[r.name];
            return (
              <button type="button" key={r.id} onClick={() => onPick({ name: r.name, fullName: r.fullName, defaultBranch: r.defaultBranch, language: r.language, pushedAt: r.pushedAt, private: r.private })} style={rowStyle(value?.fullName === r.fullName)}>
                <span style={{ wordBreak: "break-all" }}>
                  {r.name}
                  {r.language && <span style={{ color: "var(--n-ink-faint)" }}> · {r.language}</span>}
                  {k && <span style={{ color: "var(--n-ion-soft)" }}> · twizz.yaml {k.kind} v{k.version}</span>}
                </span>
                <span style={{ color: "var(--n-ink-muted)", whiteSpace: "nowrap" }}>{r.pushedAt ? new Date(r.pushedAt).toLocaleDateString() : "—"}</span>
              </button>
            );
          })}
        </div>
      )}
    </Field>
  );
}

/** Branch section: an existing branch (searchable) or a new one off a base. */
export function BranchPicker({
  repo,
  mode,
  branch,
  newBranchFrom,
  onMode,
  onBranch,
  onNewBranchFrom,
}: {
  repo: RepoPick;
  mode: "existing" | "new";
  branch: string;
  newBranchFrom: string;
  onMode: (m: "existing" | "new") => void;
  onBranch: (b: string) => void;
  onNewBranchFrom: (b: string) => void;
}) {
  const [q, setQ] = useState("");
  const [qFrom, setQFrom] = useState("");
  const branches = trpc.project.listBranches.useQuery({ repo: repo.fullName, q: (mode === "existing" ? q : qFrom) || undefined, limit: 60 }, { staleTime: 30_000, retry: false, placeholderData: (prev) => prev });
  const list = branches.data ?? [];
  const pickFrom = mode === "existing" ? branch : newBranchFrom;
  const onPickFrom = mode === "existing" ? onBranch : onNewBranchFrom;
  const newNameBad = mode === "new" && branch !== "" && (!isValidBranchName(branch) || DENIED_BRANCH_RE.test(branch));

  return (
    <Field label="branch" hint={mode === "new" ? "Nebula creates the branch at the base's head, commits the config on nebula/<env> and opens a PR into it." : "The preview builds this branch's head, pinned now; a push before you confirm is refused honestly."}>
      <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
        {(["existing", "new"] as const).map((m) => (
          <button key={m} type="button" onClick={() => onMode(m)} style={{ fontFamily: "inherit", fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", padding: "3px 8px", borderRadius: 3, cursor: "pointer", border: `1px solid ${mode === m ? "var(--n-ion)" : "var(--n-hairline-strong)"}`, background: mode === m ? "color-mix(in oklab, var(--n-ion) 14%, transparent)" : "transparent", color: mode === m ? "var(--n-ion-soft)" : "var(--n-ink-muted)" }}>
            {m === "existing" ? "existing branch" : "new branch"}
          </button>
        ))}
      </div>
      {mode === "new" && (
        <div style={{ marginBottom: 8 }}>
          <input value={branch} onChange={(e) => onBranch(e.target.value.trim())} placeholder="e.g. feature/nebula-preview" style={inputStyle} />
          {newNameBad && (
            <div style={{ marginTop: 4, fontSize: 11, color: "var(--n-fail)" }}>
              <Pill word="DENIED" /> {DENIED_BRANCH_RE.test(branch) ? "policy refuses main/master and names containing prod/staging" : "not a valid git branch name"}
            </div>
          )}
          <div className="n-label" style={{ margin: "10px 0 4px" }}>from</div>
        </div>
      )}
      <input value={mode === "existing" ? q : qFrom} onChange={(e) => (mode === "existing" ? setQ(e.target.value) : setQFrom(e.target.value))} placeholder={`search branches (default ${repo.defaultBranch})`} style={{ ...inputStyle, marginBottom: 6 }} />
      {branches.isLoading && <div style={{ color: "var(--n-ink-muted)", fontSize: 11 }}><Pill word="PENDING" /> listing branches…</div>}
      {branches.error && <div style={{ color: "var(--n-fail)", fontSize: 11 }}><Pill word="FAIL" /> {branches.error.message}</div>}
      {branches.data && (
        <div style={listStyle}>
          {list.length === 0 && <div style={{ padding: 10, color: "var(--n-ink-muted)", fontSize: 11 }}>no branch matches</div>}
          {list.map((b) => (
            <button type="button" key={b.name} onClick={() => onPickFrom(b.name)} style={rowStyle(pickFrom === b.name)}>
              <span style={{ wordBreak: "break-all" }}>
                {b.name}
                {b.name === repo.defaultBranch && <span style={{ color: "var(--n-ink-faint)" }}> · default</span>}
                {b.protected && <span style={{ color: "var(--n-ink-faint)" }}> · protected</span>}
              </span>
              <span style={{ color: "var(--n-ink-muted)", whiteSpace: "nowrap" }}>{b.sha.slice(0, 7)}</span>
            </button>
          ))}
        </div>
      )}
    </Field>
  );
}
