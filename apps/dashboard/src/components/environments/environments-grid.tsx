"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { trpc } from "@/lib/trpc-client";
import { Pill } from "@/components/nebula/pill";
import { Button } from "@/components/nebula/button";
import { PageHeader } from "@/components/nebula/plate";
import { GateDialog } from "@/components/nebula/gate-dialog";
import { useGatedAction, type GateResult } from "@/lib/nebula/use-gated-action";
import { PreviewCard, type NamedEnvView } from "./preview-card";
import { SpinUpDrawer } from "./spin-up-drawer";

type CardAction = { kind: "extend"; env: NamedEnvView; ttlHours: number } | { kind: "reclone"; env: NamedEnvView } | { kind: "teardown"; env: NamedEnvView };

export function EnvironmentsGrid({ operator, login }: { operator: boolean; login: string }) {
  const utils = trpc.useUtils();
  const envs = trpc.actions.listEnvs.useQuery(undefined, { refetchInterval: 30_000, retry: false });
  const [wizardOpen, setWizardOpen] = useState(false);
  const [action, setAction] = useState<CardAction | null>(null);

  const extend = trpc.actions.extendNamedEnv.useMutation();
  const reclone = trpc.actions.cloneStagingDb.useMutation();
  const teardown = trpc.actions.teardownNamedEnv.useMutation();

  // The action rides inside the gated args so the nonce is bound to it
  // server-side; there is no stale-closure path to confirm a different env.
  const run = useCallback(
    async (args: { action: CardAction; confirm?: string }): Promise<GateResult> => {
      const { action: a, confirm } = args;
      if (a.kind === "extend") return (await extend.mutateAsync({ name: a.env.name, ttlHours: a.ttlHours, confirm })) as GateResult;
      if (a.kind === "reclone") return (await reclone.mutateAsync({ name: a.env.name, confirm })) as GateResult;
      return (await teardown.mutateAsync({ name: a.env.name, confirm })) as GateResult;
    },
    [extend, reclone, teardown],
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
    if (wasDone) utils.actions.listEnvs.invalidate();
  };

  const title =
    action?.kind === "extend" ? `Extend ${action.env.name} (+${action.ttlHours}h)` : action?.kind === "reclone" ? `Re-clone db into ${action.env.name}` : action ? `Tear down ${action.env.name}` : "";

  const list = envs.data?.envs ?? [];
  const counts = list.reduce<Record<string, number>>((acc, e) => ({ ...acc, [e.argo.word]: (acc[e.argo.word] ?? 0) + 1 }), {});

  return (
    <div style={{ padding: 28, maxWidth: 1400 }}>
      <PageHeader title="Environments" kicker="nebula · named envs · twizz-gitops/named-envs">
        <Link href="/environments/topology" style={{ color: "var(--n-ink-muted)", fontSize: 11, textDecoration: "none", marginRight: 8 }}>
          topology (all tiers) →
        </Link>
        {operator ? (
          <Button variant="ion" onClick={() => setWizardOpen(true)}>Spin up</Button>
        ) : (
          <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
            <Button disabled>Spin up</Button>
            <Pill word="READ-ONLY" title={`${login} is not in NEBULA_OPERATORS`} />
          </span>
        )}
      </PageHeader>

      {/* Honest summary strip: every count carries its word */}
      <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", marginBottom: 18, fontSize: 11, color: "var(--n-ink-muted)" }}>
        <span>{envs.isLoading ? "reading named-envs…" : `${list.length} env${list.length === 1 ? "" : "s"}`}</span>
        {Object.entries(counts).map(([word, n]) => (
          <span key={word} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            <Pill word={word as NamedEnvView["argo"]["word"]} /> {n}
          </span>
        ))}
        {envs.data && !envs.data.argo.reachable && (
          <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }} title={envs.data.argo.reason}>
            <Pill word="UNKNOWN" /> argo not readable from here — {envs.data.argo.reason}
          </span>
        )}
        {envs.isFetching && !envs.isLoading && <span style={{ color: "var(--n-ink-faint)" }}>refreshing…</span>}
      </div>

      {envs.error && (
        <div className="n-plate" style={{ padding: 16, marginBottom: 18, borderColor: "color-mix(in oklab, var(--n-fail) 50%, transparent)" }}>
          <Pill word="FAIL" /> <span style={{ marginLeft: 8, color: "var(--n-fail)" }}>{envs.error.message}</span>
        </div>
      )}

      {envs.isLoading && (
        <div className="n-plate" style={{ padding: 24, color: "var(--n-ink-muted)" }}>
          <Pill word="PENDING" /> <span style={{ marginLeft: 8 }}>listing twizz-gitops/named-envs and Argo Applications…</span>
        </div>
      )}

      {envs.data && list.length === 0 && (
        <div className="n-plate" style={{ padding: 32, textAlign: "center" }}>
          <div className="n-display" style={{ fontSize: 22, marginBottom: 8 }}>No named environments</div>
          <p style={{ color: "var(--n-ink-muted)", margin: 0 }}>Spin one up from an existing release image. Nothing is built; capacity is used only when someone asks.</p>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))", gap: 16 }}>
        {list.map((env) => (
          <PreviewCard
            key={env.name}
            env={env}
            operator={operator}
            onExtend={(e, ttlHours) => start({ kind: "extend", env: e, ttlHours })}
            onReclone={(e) => start({ kind: "reclone", env: e })}
            onTeardown={(e) => start({ kind: "teardown", env: e })}
          />
        ))}
      </div>

      <GateDialog title={title} phase={gated.phase} onConfirm={gated.confirm} onClose={closeGate} />

      <SpinUpDrawer open={wizardOpen} onClose={() => setWizardOpen(false)} onCreated={() => utils.actions.listEnvs.invalidate()} />
    </div>
  );
}
