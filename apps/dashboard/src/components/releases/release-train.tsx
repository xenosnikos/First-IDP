"use client";

import { useCallback, useMemo, useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@/server/routers/_app";
import { trpc } from "@/lib/trpc-client";
import { Pill } from "@/components/nebula/pill";
import { Button } from "@/components/nebula/button";
import { PageHeader, Row } from "@/components/nebula/plate";
import { GateDialog } from "@/components/nebula/gate-dialog";
import { useGatedAction, type GateResult } from "@/lib/nebula/use-gated-action";

type Train = inferRouterOutputs<AppRouter>["actions"]["listReleaseTrain"];
type ServiceView = Train["services"][number];
type Candidate = ServiceView["candidates"][number];
type Promotion = Train["promotions"][number];

type TrainAction =
  | { kind: "promote"; service: string; target: "staging"; imageTag: string }
  | { kind: "merge"; prNumber: number; service: string; target: "staging"; imageTag: string };

type PromoteResult = { prNumber: number; prUrl: string; from: string | null; to: string; existing: boolean; argoApp: string; host: string };
type MergeResult = { prNumber: number; mergedSha: string; argoApp: string; host: string; imageTag: string };

const KIND_BLURB: Record<Candidate["kind"], string> = {
  main: "built by the repo's CI from main",
  pr: "built by the repo's CI for a PR",
  nebula: "built by Nebula for a named env",
  build: "release build",
};

function shortTag(tag: string): string {
  const m = tag.match(/^(main|pr-\d+|nb-[a-z0-9-]+?)-([0-9a-f]{7})[0-9a-f]*$/);
  return m ? `${m[1]}-${m[2]}…` : tag.length > 28 ? tag.slice(0, 28) + "…" : tag;
}

function when(iso?: string): string {
  if (!iso) return "";
  const ms = Date.now() - Date.parse(iso);
  const d = Math.floor(ms / 86_400_000);
  if (d > 0) return `${d}d ago`;
  const h = Math.floor(ms / 3_600_000);
  return h > 0 ? `${h}h ago` : `${Math.max(1, Math.floor(ms / 60_000))}m ago`;
}

// Release train: one plate per service on the train. Left, what staging runs
// (gitops says + Argo says); right, the immutable candidates. Promote opens
// a gitops PR (gate 1); the PR list underneath carries Merge (gate 2). Both
// are operator-only; everyone else reads the same page with the buttons off.
export function ReleaseTrain({ operator, login }: { operator: boolean; login: string }) {
  const utils = trpc.useUtils();
  const q = trpc.actions.listReleaseTrain.useQuery(undefined, { refetchInterval: 30_000, retry: false });
  const promote = trpc.actions.promoteRelease.useMutation();
  const merge = trpc.actions.mergePromotion.useMutation();
  const [action, setAction] = useState<TrainAction | null>(null);
  const [picked, setPicked] = useState<Record<string, string>>({});

  const run = useCallback(
    async (args: { action: TrainAction; confirm?: string }): Promise<GateResult> => {
      const { action: a, confirm } = args;
      if (a.kind === "promote") return (await promote.mutateAsync({ service: a.service, target: a.target, imageTag: a.imageTag, confirm })) as GateResult;
      return (await merge.mutateAsync({ prNumber: a.prNumber, service: a.service, target: a.target, imageTag: a.imageTag, confirm })) as GateResult;
    },
    [promote, merge],
  );
  const gated = useGatedAction<{ action: TrainAction }, PromoteResult | MergeResult>(run);

  const start = (a: TrainAction) => {
    setAction(a);
    void gated.request({ action: a });
  };
  const closeGate = () => {
    const wasDone = gated.phase.kind === "done";
    gated.reset();
    setAction(null);
    if (wasDone) utils.actions.listReleaseTrain.invalidate();
  };

  const title = action?.kind === "promote" ? `Promote ${action.service} → ${action.target}` : action ? `Merge promotion #${action.prNumber}` : "";
  const promotionsByService = useMemo(() => {
    const m = new Map<string, Promotion[]>();
    for (const p of q.data?.promotions ?? []) m.set(p.service, [...(m.get(p.service) ?? []), p]);
    return m;
  }, [q.data]);

  return (
    <div style={{ padding: 28, maxWidth: 1400 }}>
      <PageHeader title="Release train" kicker="previews → staging · EKS-Moly-staging ns sentinel · every step is a gitops PR">
        {!operator && <Pill word="READ-ONLY" title={`${login} is not in NEBULA_OPERATORS; promotions are operator-only`} />}
        <Pill word="PLANNED" title="prod promotion is not a target: prod is globally denied by policy" />
      </PageHeader>

      <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", marginBottom: 18, fontSize: 11, color: "var(--n-ink-muted)" }}>
        <span>{q.isLoading ? "reading ECR, twizz-gitops and Argo…" : `${q.data?.services.length ?? 0} services on the train · ${q.data?.promotions.length ?? 0} open promotion PR${(q.data?.promotions.length ?? 0) === 1 ? "" : "s"}`}</span>
        {q.data && !q.data.argo.reachable && (
          <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }} title={q.data.argo.reason}>
            <Pill word="UNKNOWN" /> Argo not readable from here — {q.data.argo.reason}
          </span>
        )}
        {q.data?.promotionsError && (
          <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            <Pill word="FAIL" /> promotion PRs unreadable — {q.data.promotionsError}
          </span>
        )}
        {q.isFetching && !q.isLoading && <span style={{ color: "var(--n-ink-faint)" }}>refreshing…</span>}
      </div>

      {q.error && (
        <div className="n-plate" style={{ padding: 16, marginBottom: 18, borderColor: "color-mix(in oklab, var(--n-fail) 50%, transparent)" }}>
          <Pill word="FAIL" /> <span style={{ marginLeft: 8, color: "var(--n-fail)" }}>{q.error.message}</span>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(560px, 1fr))", gap: 16 }}>
        {q.data?.services.map((svc) => {
          const chosen = picked[svc.service] ?? "";
          const chosenCandidate = svc.candidates.find((c) => c.tag === chosen);
          const open = promotionsByService.get(svc.service) ?? [];
          const canPromote = operator && !!chosenCandidate && chosen !== svc.current && svc.bootstrapped;
          return (
            <article key={svc.service} className="n-plate" style={{ padding: 16, display: "flex", flexDirection: "column", minWidth: 0 }}>
              <header style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, paddingBottom: 12, borderBottom: "1px solid var(--n-hairline)" }}>
                <div style={{ minWidth: 0 }}>
                  <div className="n-display" style={{ fontSize: 22, lineHeight: 1.15 }}>{svc.service}</div>
                  <div style={{ color: "var(--n-ink-muted)", fontSize: 11, marginTop: 4 }}>
                    {svc.kind} · <a href={`https://github.com/${svc.repo}`} target="_blank" rel="noreferrer" style={{ color: "var(--n-ion-soft)", textDecoration: "none" }}>{svc.repo} ↗</a> · ECR {svc.ecrRepo}
                  </div>
                </div>
                <span style={{ display: "inline-flex", gap: 6 }}>
                  <Pill word="STAGING" title={`${svc.cluster} / ns ${svc.namespace}`} />
                  <Pill word={svc.argo.word} title={svc.argo.detail} />
                </span>
              </header>

              <div>
                <Row label="staging runs">
                  {svc.stateError ? (
                    <span style={{ color: "var(--n-fail)" }}><Pill word="FAIL" /> {svc.stateError}</span>
                  ) : !svc.bootstrapped ? (
                    <span style={{ color: "var(--n-ink-muted)" }}><Pill word="PENDING" /> {svc.valuesFile} is not in twizz-gitops yet (staging target not bootstrapped)</span>
                  ) : (
                    <span title={svc.current ?? ""} style={{ wordBreak: "break-all" }}>{svc.current ? shortTag(svc.current) : "(no tag)"}</span>
                  )}
                </Row>
                <Row label="argo">
                  <Pill word={svc.argo.word} />
                  <span style={{ color: "var(--n-ink-muted)" }}>{svc.argoApp} · {svc.argo.detail}</span>
                </Row>
                <Row label="url">
                  <a href={svc.url} target="_blank" rel="noreferrer" style={{ color: "var(--n-ion-soft)", textDecoration: "none" }}>{svc.host} ↗</a>
                </Row>
                <Row label="candidates" last>
                  <div style={{ width: "100%" }}>
                    {svc.candidatesError && <span style={{ color: "var(--n-fail)" }}><Pill word="FAIL" /> {svc.candidatesError}</span>}
                    {!svc.candidatesError && svc.candidates.length === 0 && <span style={{ color: "var(--n-ink-faint)" }}>no immutable images in ECR {svc.ecrRepo}</span>}
                    {svc.candidates.length > 0 && (
                      <div style={{ border: "1px solid var(--n-hairline-strong)", borderRadius: "var(--n-radius)", maxHeight: 220, overflowY: "auto", background: "var(--n-plate)" }}>
                        {svc.candidates.map((c) => {
                          const active = c.tag === chosen;
                          const current = c.tag === svc.current;
                          return (
                            <button
                              key={c.tag}
                              type="button"
                              disabled={!operator || current}
                              onClick={() => setPicked((p) => ({ ...p, [svc.service]: c.tag }))}
                              title={`${c.tag}\n${KIND_BLURB[c.kind]}${c.aliases.length ? `\nalso tagged ${c.aliases.join(", ")}` : ""}`}
                              style={{
                                display: "flex",
                                width: "100%",
                                alignItems: "center",
                                gap: 10,
                                padding: "7px 10px",
                                fontFamily: "inherit",
                                fontSize: 11,
                                textAlign: "left",
                                cursor: !operator || current ? "default" : "pointer",
                                border: 0,
                                borderBottom: "1px solid var(--n-hairline)",
                                background: active ? "color-mix(in oklab, var(--n-ion) 14%, transparent)" : "transparent",
                                color: current ? "var(--n-ink-faint)" : "var(--n-ink)",
                              }}
                            >
                              <span style={{ width: 12, color: "var(--n-ion-soft)" }}>{active ? "●" : "○"}</span>
                              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{shortTag(c.tag)}</span>
                              <span className="n-label" style={{ color: "var(--n-ink-faint)" }}>{c.kind}</span>
                              {c.aliases.map((a) => (
                                <span key={a} style={{ fontSize: 10, padding: "0 6px", border: "1px solid var(--n-hairline-strong)", borderRadius: 3, color: "var(--n-ink-muted)" }}>{a}</span>
                              ))}
                              {current && <Pill word="DEPLOYED" title="what staging is on now (per gitops)" />}
                              <span style={{ color: "var(--n-ink-faint)", whiteSpace: "nowrap" }}>{when(c.pushedAt)}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </Row>
              </div>

              <footer style={{ marginTop: 12, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 11, color: "var(--n-ink-muted)" }}>
                  {open.length === 0 ? "no open promotion PR" : `${open.length} open promotion PR${open.length === 1 ? "" : "s"}`}
                </span>
                <Button
                  variant="ion"
                  disabled={!canPromote}
                  title={!operator ? "operators only" : !svc.bootstrapped ? "staging target not bootstrapped" : !chosenCandidate ? "pick a candidate" : `open a gitops PR: ${svc.valuesFile} → ${chosen}`}
                  onClick={() => chosenCandidate && start({ kind: "promote", service: svc.service, target: "staging", imageTag: chosenCandidate.tag })}
                >
                  Promote to staging
                </Button>
              </footer>

              {open.length > 0 && (
                <div style={{ marginTop: 12, borderTop: "1px solid var(--n-hairline)", paddingTop: 10 }}>
                  {open.map((p) => (
                    <div key={p.number} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", fontSize: 11 }}>
                      <Pill word="AWAITING HUMAN" title="a promotion PR is open; merging is the second gate" />
                      <a href={p.url} target="_blank" rel="noreferrer" style={{ color: "var(--n-ion-soft)", textDecoration: "none", whiteSpace: "nowrap" }}>#{p.number} ↗</a>
                      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--n-ink-muted)" }} title={p.imageTag}>
                        → {shortTag(p.imageTag)} · by {p.author} · {when(p.createdAt)}
                      </span>
                      <Button disabled={!operator} title={operator ? `squash-merge #${p.number} at ${p.headSha.slice(0, 7)}` : "operators only"} onClick={() => start({ kind: "merge", prNumber: p.number, service: p.service, target: p.target, imageTag: p.imageTag })}>
                        Merge
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </article>
          );
        })}
      </div>

      {q.data && q.data.services.length === 0 && (
        <div className="n-plate" style={{ padding: 32, textAlign: "center" }}>
          <div className="n-display" style={{ fontSize: 22, marginBottom: 8 }}>Nothing is on the release train</div>
          <p style={{ color: "var(--n-ink-muted)", margin: 0 }}>Add a `releaseTrain` target to a registry entry (packages/actions/src/registry.ts).</p>
        </div>
      )}

      <GateDialog<PromoteResult | MergeResult>
        title={title}
        phase={gated.phase}
        onConfirm={gated.confirm}
        onClose={closeGate}
        renderResult={(r) =>
          "prUrl" in r ? (
            <div style={{ marginBottom: 14 }}>
              <Row label="pr">
                <a href={r.prUrl} target="_blank" rel="noreferrer" style={{ color: "var(--n-ion-soft)" }}>#{r.prNumber} ↗</a>
                {r.existing && <span style={{ color: "var(--n-ink-muted)" }}>(already open — nothing new written)</span>}
              </Row>
              <Row label="from">{r.from ?? "(none)"}</Row>
              <Row label="to" last>{r.to}</Row>
              <p style={{ margin: "12px 0 0", color: "var(--n-ink-muted)", lineHeight: 1.6 }}>
                Nothing has deployed. Merge the PR (the second gate, here or on GitHub) and Argo app {r.argoApp} rolls it out to {r.host}.
              </p>
            </div>
          ) : (
            <div style={{ marginBottom: 14 }}>
              <Row label="merged">#{r.prNumber} → {r.mergedSha.slice(0, 7)}</Row>
              <Row label="image" last>{r.imageTag}</Row>
              <p style={{ margin: "12px 0 0", color: "var(--n-ink-muted)", lineHeight: 1.6 }}>
                Argo app {r.argoApp} syncs within ~3 min; the card goes <Pill word="RUNNING" /> → <Pill word="PASS" /> at {r.host}.
              </p>
            </div>
          )
        }
      />
    </div>
  );
}
