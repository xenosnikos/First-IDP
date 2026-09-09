"use client";

import Link from "next/link";
import { useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { Pill } from "@/components/nebula/pill";
import { PageHeader, Row } from "@/components/nebula/plate";
import type { StatusWord } from "@/lib/nebula/status";

type Word = "DEPLOYED" | "PREVIEWABLE" | "REGISTERED" | "UNONBOARDED";
const WORDS: Word[] = ["DEPLOYED", "PREVIEWABLE", "REGISTERED", "UNONBOARDED"];
const BLURB: Record<Word, string> = {
  DEPLOYED: "an Argo Application on non-prod runs it (named env, PR preview or gitops app)",
  PREVIEWABLE: "an ApplicationSet PR generator watches it — label a PR `preview` to get an env",
  REGISTERED: "a row in Nebula's Project table (optional enrichment; nothing needs it to appear here)",
  UNONBOARDED: "the platform knows the repo exists and nothing else",
};

// Projects = repos & what the platform knows about them (docs/NEBULA.md §N3.4):
// the twizz-app org ∪ repos referenced by Applications on the cluster
// (incl. outside the org, e.g. xenosnikos/twizz-support) ∪ registered rows.
export function ProjectsGrid() {
  const q = trpc.nebula.listProjects.useQuery(undefined, { staleTime: 60_000, retry: false });
  const [filter, setFilter] = useState<Word | "ALL">("ALL");
  const list = (q.data?.projects ?? []).filter((p) => filter === "ALL" || p.words.includes(filter));
  const counts = WORDS.reduce<Record<Word, number>>((acc, w) => ({ ...acc, [w]: (q.data?.projects ?? []).filter((p) => p.words.includes(w)).length }), {} as Record<Word, number>);

  return (
    <div style={{ padding: 28, maxWidth: 1400 }}>
      <PageHeader title="Projects" kicker={`repos & what the platform knows about them · ${q.data?.org ?? "twizz-app"} ∪ cluster-referenced ∪ registered`} />

      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 18, fontSize: 11, color: "var(--n-ink-muted)" }}>
        <span>{q.isLoading ? "reading GitHub + cluster…" : `${q.data?.projects.length ?? 0} repos`}</span>
        {(["ALL", ...WORDS] as const).map((w) => (
          <button
            key={w}
            type="button"
            onClick={() => setFilter(w)}
            title={w === "ALL" ? undefined : BLURB[w]}
            style={{
              fontFamily: "inherit",
              fontSize: 10,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              padding: "3px 8px",
              borderRadius: 3,
              cursor: "pointer",
              border: `1px solid ${filter === w ? "var(--n-ion)" : "var(--n-hairline-strong)"}`,
              background: filter === w ? "color-mix(in oklab, var(--n-ion) 14%, transparent)" : "transparent",
              color: filter === w ? "var(--n-ion-soft)" : "var(--n-ink-muted)",
            }}
          >
            {w === "ALL" ? `all ${q.data?.projects.length ?? 0}` : `${w} ${counts[w] ?? 0}`}
          </button>
        ))}
        {q.data?.orgError && <span title={q.data.orgError}><Pill word="UNKNOWN" /> org listing failed — {q.data.orgError}</span>}
        {q.data && !q.data.cluster.reachable && <span title={q.data.cluster.reason}><Pill word="UNKNOWN" /> cluster not readable — DEPLOYED/PREVIEWABLE unknown</span>}
      </div>

      {q.error && (
        <div className="n-plate" style={{ padding: 16, marginBottom: 18, borderColor: "color-mix(in oklab, var(--n-fail) 50%, transparent)" }}>
          <Pill word="FAIL" /> <span style={{ marginLeft: 8, color: "var(--n-fail)" }}>{q.error.message}</span>
        </div>
      )}
      {q.isLoading && (
        <div className="n-plate" style={{ padding: 24, color: "var(--n-ink-muted)" }}>
          <Pill word="PENDING" /> <span style={{ marginLeft: 8 }}>listing org repos, Argo Applications and ApplicationSets…</span>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: 16 }}>
        {list.map((p) => (
          <article key={p.slug} className="n-plate" style={{ padding: 16, minWidth: 0 }}>
            <header style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, paddingBottom: 12, borderBottom: "1px solid var(--n-hairline)" }}>
              <div style={{ minWidth: 0 }}>
                <Link href={`/projects/${encodeURIComponent(p.name)}`} className="n-display" style={{ fontSize: 20, lineHeight: 1.15, color: "var(--n-ink)", textDecoration: "none", wordBreak: "break-all" }}>
                  {p.name}
                </Link>
                <div style={{ color: "var(--n-ink-muted)", fontSize: 11, marginTop: 4 }}>
                  <a href={p.url} target="_blank" rel="noreferrer" style={{ color: "var(--n-ink-muted)", textDecoration: "none" }}>{p.slug} ↗</a>
                  {p.private === true && <span style={{ color: "var(--n-ink-faint)" }}> · private</span>}
                  {p.language && <span style={{ color: "var(--n-ink-faint)" }}> · {p.language}</span>}
                </div>
              </div>
              <span style={{ display: "flex", gap: 4, flexWrap: "wrap", justifyContent: "flex-end" }}>
                {p.words.map((w) => <Pill key={w} word={w as StatusWord} title={BLURB[w as Word]} />)}
              </span>
            </header>
            <div>
              <Row label="runs as">
                {p.apps.length === 0 && <span style={{ color: "var(--n-ink-faint)" }}>nothing on non-prod</span>}
                {p.apps.map((a) => (
                  <Link key={a} href="/environments" style={{ color: "var(--n-ion-soft)", textDecoration: "none" }}>{a}</Link>
                ))}
              </Row>
              <Row label="nebula">
                {p.registry ? (
                  <>
                    <span>{p.registry.kind}</span>
                    <Pill word={p.registry.status} title={p.registry.status === "SHIPPED" ? "provisionable from the Environments page" : "in the registry; build-on-provision lands in N3 chunk 3"} />
                  </>
                ) : (
                  <span style={{ color: "var(--n-ink-faint)" }}>not in the service registry</span>
                )}
              </Row>
              <Row label="branch" last>
                <span>{p.defaultBranch ?? "—"}</span>
                {p.updatedAt && <span style={{ color: "var(--n-ink-faint)", fontSize: 10 }}>updated {new Date(p.updatedAt).toLocaleDateString()}</span>}
              </Row>
            </div>
          </article>
        ))}
      </div>
      {q.data && list.length === 0 && (
        <div className="n-plate" style={{ padding: 24, color: "var(--n-ink-muted)" }}>no repos match this filter</div>
      )}
    </div>
  );
}
