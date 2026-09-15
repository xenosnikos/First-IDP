"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { trpc } from "@/lib/trpc-client";
import { Pill } from "@/components/nebula/pill";
import { Button } from "@/components/nebula/button";
import { PageHeader } from "@/components/nebula/plate";
import { GateDialog } from "@/components/nebula/gate-dialog";
import { useGatedAction, type GateResult } from "@/lib/nebula/use-gated-action";
import type { StatusWord } from "@/lib/nebula/status";
import { PreviewCard, type NamedEnvView } from "./preview-card";
import { PendingCard, type PendingEnvView } from "./pending-card";
import { AppCard, type AppView } from "./app-card";
import { SpinUpDrawer } from "./spin-up-drawer";
import { RepoSpinUpDrawer } from "./repo-spin-up-drawer";

type EnvRef = { name: string };
type CardAction =
  | { kind: "extend"; env: EnvRef; ttlHours: number }
  | { kind: "reclone"; env: EnvRef }
  | { kind: "teardown"; env: EnvRef }
  | { kind: "rebuild"; env: EnvRef }
  | { kind: "envvars"; env: EnvRef; vars: Record<string, string> };
type Origin = "NAMED" | "PR PREVIEW" | "GITOPS APP";
const ORIGINS: Origin[] = ["NAMED", "PR PREVIEW", "GITOPS APP"];
const ORIGIN_BLURB: Record<Origin, string> = {
  NAMED: "Provisioned by Nebula from twizz-gitops/named-envs — the only kind with actions.",
  "PR PREVIEW": "Created by an Argo CD ApplicationSet from a PR carrying the `preview` label; lives and dies with the label.",
  "GITOPS APP": "A standing Application in twizz-gitops (the support workbench, external to the org while the concept is proven). Read-only here.",
};

// Environments = what is running on non-prod (docs/NEBULA.md §N3.4): every
// Argo Application on EKS-Twizz-NonProd, grouped by origin. NAMED cards carry
// the gated actions; everything else is read-only.
export function EnvironmentsGrid({ operator, login }: { operator: boolean; login: string }) {
  const utils = trpc.useUtils();
  const q = trpc.nebula.listEnvironments.useQuery(undefined, { refetchInterval: 30_000, retry: false });
  const [wizardOpen, setWizardOpen] = useState(false);
  const [repoOpen, setRepoOpen] = useState(false);
  const me = trpc.actions.me.useQuery(undefined, { staleTime: 60_000 });
  const [action, setAction] = useState<CardAction | null>(null);
  const [filter, setFilter] = useState<Origin | "ALL">("ALL");

  const extend = trpc.actions.extendNamedEnv.useMutation();
  const reclone = trpc.actions.cloneStagingDb.useMutation();
  const teardown = trpc.actions.teardownNamedEnv.useMutation();
  const rebuild = trpc.actions.rebuildFromRef.useMutation();
  const envvars = trpc.actions.setEnvVars.useMutation();

  // The action rides inside the gated args so the nonce is bound to it
  // server-side; there is no stale-closure path to confirm a different env.
  const run = useCallback(
    async (args: { action: CardAction; confirm?: string }): Promise<GateResult> => {
      const { action: a, confirm } = args;
      if (a.kind === "extend") return (await extend.mutateAsync({ name: a.env.name, ttlHours: a.ttlHours, confirm })) as GateResult;
      if (a.kind === "reclone") return (await reclone.mutateAsync({ name: a.env.name, confirm })) as GateResult;
      if (a.kind === "rebuild") return (await rebuild.mutateAsync({ name: a.env.name, confirm })) as GateResult;
      if (a.kind === "envvars") return (await envvars.mutateAsync({ name: a.env.name, vars: a.vars, confirm })) as GateResult;
      return (await teardown.mutateAsync({ name: a.env.name, confirm })) as GateResult;
    },
    [extend, reclone, teardown, rebuild, envvars],
  );
  const gated = useGatedAction<{ action: CardAction }>(run);

  const start = (a: CardAction) => {
    setAction(a);
    void gated.request({ action: a });
  };
  const closeGate = () => {
    const wasDone = gated.phase.kind === "done";
    gated.reset();
    setAction(null);
    if (wasDone) utils.nebula.listEnvironments.invalidate();
  };

  const title =
    action?.kind === "extend"
      ? `Extend ${action.env.name} (+${action.ttlHours}h)`
      : action?.kind === "reclone"
        ? `Re-clone db into ${action.env.name}`
        : action?.kind === "rebuild"
          ? `Rebuild ${action.env.name} from its branch`
          : action?.kind === "envvars"
            ? `Set env vars on ${action.env.name}`
            : action
              ? `Tear down ${action.env.name}`
              : "";

  const named = useMemo(() => q.data?.named ?? [], [q.data]);
  const pending = useMemo(() => q.data?.pending ?? [], [q.data]);
  const broken = q.data?.broken ?? [];
  const others = useMemo(() => q.data?.others ?? [], [q.data]);
  const ownerLabel = (me.data?.ownerLabel ?? login).toLowerCase();
  const isOwner = (owner: string) => owner.toLowerCase() === ownerLabel;
  const groups = useMemo(() => {
    const g: Record<Origin, Array<{ kind: "named"; env: NamedEnvView } | { kind: "pending"; env: PendingEnvView } | { kind: "app"; app: AppView }>> = { NAMED: [], "PR PREVIEW": [], "GITOPS APP": [] };
    for (const env of pending) g.NAMED.push({ kind: "pending", env });
    for (const env of named) g.NAMED.push({ kind: "named", env });
    for (const app of others) g[app.origin as Origin].push({ kind: "app", app });
    return g;
  }, [named, pending, others]);
  const total = named.length + pending.length + others.length;
  const healthCounts = [...named.map((e) => e.argo.word), ...pending.map((e) => e.word), ...others.map((a) => a.word)].reduce<Record<string, number>>((acc, w) => ({ ...acc, [w]: (acc[w] ?? 0) + 1 }), {});
  const visible = filter === "ALL" ? ORIGINS : [filter];

  return (
    <div style={{ padding: 28, maxWidth: 1400 }}>
      <PageHeader title="Environments" kicker="what is running on non-prod · EKS-Twizz-NonProd · every Argo Application">
        <Link href="/environments/topology" style={{ color: "var(--n-ink-muted)", fontSize: 11, textDecoration: "none", marginRight: 8 }}>
          topology (all tiers) →
        </Link>
        <Button variant="ion" onClick={() => setRepoOpen(true)} title="any twizz-app repo/branch; Nebula builds it (self-service, through the gate)">Spin up from a repo</Button>
        {operator ? (
          <Button onClick={() => setWizardOpen(true)} title="moly-backend from an existing release image (operators)">Release image</Button>
        ) : (
          <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
            <Button disabled title="release-image spin-ups are operator-only">Release image</Button>
            <Pill word="READ-ONLY" title={`${login} is not in NEBULA_OPERATORS; you can still spin up from a repo and manage your own envs`} />
          </span>
        )}
      </PageHeader>

      {/* Honest summary strip: every count carries its word; filter by origin */}
      <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", marginBottom: 18, fontSize: 11, color: "var(--n-ink-muted)" }}>
        <span>{q.isLoading ? "reading cluster + named-envs…" : `${total} application${total === 1 ? "" : "s"}`}</span>
        {Object.entries(healthCounts).map(([word, n]) => (
          <span key={word} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            <Pill word={word as StatusWord} /> {n}
          </span>
        ))}
        <span style={{ marginLeft: "auto", display: "inline-flex", gap: 6, alignItems: "center" }}>
          <span className="n-label">show</span>
          {(["ALL", ...ORIGINS] as const).map((o) => (
            <button
              key={o}
              type="button"
              onClick={() => setFilter(o)}
              style={{
                fontFamily: "inherit",
                fontSize: 10,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                padding: "3px 8px",
                borderRadius: 3,
                cursor: "pointer",
                border: `1px solid ${filter === o ? "var(--n-ion)" : "var(--n-hairline-strong)"}`,
                background: filter === o ? "color-mix(in oklab, var(--n-ion) 14%, transparent)" : "transparent",
                color: filter === o ? "var(--n-ion-soft)" : "var(--n-ink-muted)",
              }}
            >
              {o === "ALL" ? "all" : o} {o === "ALL" ? total : groups[o].length}
            </button>
          ))}
        </span>
        {q.data && !q.data.cluster.reachable && (
          <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexBasis: "100%" }} title={q.data.cluster.reason}>
            <Pill word="UNKNOWN" /> cluster not readable from here — {q.data.cluster.reason}
          </span>
        )}
        {q.data?.gitopsError && (
          <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexBasis: "100%" }}>
            <Pill word="FAIL" /> named-envs unreadable — {q.data.gitopsError}
          </span>
        )}
        {broken.map((b) => (
          <span key={b.path} style={{ display: "inline-flex", gap: 6, alignItems: "center", flexBasis: "100%" }} title={b.error}>
            <Pill word="UNKNOWN" /> {b.path} did not parse — {b.error}
          </span>
        ))}
        {q.isFetching && !q.isLoading && <span style={{ color: "var(--n-ink-faint)" }}>refreshing…</span>}
      </div>

      {q.error && (
        <div className="n-plate" style={{ padding: 16, marginBottom: 18, borderColor: "color-mix(in oklab, var(--n-fail) 50%, transparent)" }}>
          <Pill word="FAIL" /> <span style={{ marginLeft: 8, color: "var(--n-fail)" }}>{q.error.message}</span>
        </div>
      )}

      {q.isLoading && (
        <div className="n-plate" style={{ padding: 24, color: "var(--n-ink-muted)" }}>
          <Pill word="PENDING" /> <span style={{ marginLeft: 8 }}>listing Argo Applications, Ingresses, Deployments and twizz-gitops/named-envs…</span>
        </div>
      )}

      {q.data && total === 0 && (
        <div className="n-plate" style={{ padding: 32, textAlign: "center" }}>
          <div className="n-display" style={{ fontSize: 22, marginBottom: 8 }}>Nothing is running on non-prod</div>
          <p style={{ color: "var(--n-ink-muted)", margin: 0 }}>Spin up a preview from any twizz-app repo, or label a PR `preview`.</p>
        </div>
      )}

      {visible.map((origin) => {
        const items = groups[origin];
        if (q.data && items.length === 0 && filter !== "ALL") {
          return (
            <div key={origin} className="n-plate" style={{ padding: 24, color: "var(--n-ink-muted)" }}>
              <Pill word={origin} /> <span style={{ marginLeft: 8 }}>none right now — {ORIGIN_BLURB[origin]}</span>
            </div>
          );
        }
        if (items.length === 0) return null;
        return (
          <section key={origin} style={{ marginBottom: 28 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
              <Pill word={origin} />
              <span style={{ fontSize: 11, color: "var(--n-ink-muted)" }}>{items.length} · {ORIGIN_BLURB[origin]}</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))", gap: 16 }}>
              {items.map((it) =>
                it.kind === "named" ? (
                  <PreviewCard
                    key={it.env.name}
                    env={it.env}
                    operator={operator}
                    owner={isOwner(it.env.owner)}
                    onExtend={(e, ttlHours) => start({ kind: "extend", env: e, ttlHours })}
                    onReclone={(e) => start({ kind: "reclone", env: e })}
                    onTeardown={(e) => start({ kind: "teardown", env: e })}
                    onRebuild={(e) => start({ kind: "rebuild", env: e })}
                    onEnvVars={(e, vars) => start({ kind: "envvars", env: e, vars })}
                  />
                ) : it.kind === "pending" ? (
                  <PendingCard key={`pending-${it.env.name}`} env={it.env} canAct={operator || isOwner(it.env.owner)} onRebuild={(e) => start({ kind: "rebuild", env: e })} onTeardown={(e) => start({ kind: "teardown", env: e })} />
                ) : (
                  <AppCard key={it.app.name} app={it.app} />
                ),
              )}
            </div>
          </section>
        );
      })}

      <GateDialog title={title} phase={gated.phase} onConfirm={gated.confirm} onClose={closeGate} />

      <SpinUpDrawer open={wizardOpen} onClose={() => setWizardOpen(false)} onCreated={() => utils.nebula.listEnvironments.invalidate()} />
      <RepoSpinUpDrawer open={repoOpen} onClose={() => setRepoOpen(false)} onCreated={() => utils.nebula.listEnvironments.invalidate()} />
    </div>
  );
}
