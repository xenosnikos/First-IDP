"use client";

import { useCallback, useState, type CSSProperties, type ReactNode } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import { CAPACITY_TIER_LABEL, type AtlasSize, type CapacityTier, type ServiceSize, type TierSize } from "@twizz-idp/shared";
import type { AppRouter } from "@/server/routers/_app";
import { trpc } from "@/lib/trpc-client";
import { Pill } from "@/components/nebula/pill";
import { Button } from "@/components/nebula/button";
import { Field, PageHeader, Row, inputStyle } from "@/components/nebula/plate";
import { GateDialog } from "@/components/nebula/gate-dialog";
import { useGatedAction, type GateResult } from "@/lib/nebula/use-gated-action";

type Out = inferRouterOutputs<AppRouter>["capacity"];
type TierView = Out["tier"];
type PlanView = Out["plan"];
type EstimateView = Out["estimate"];
type WritableTier = "preview" | "staging";

type Choice = { mode: "preset"; name: string } | { mode: "custom"; size: TierSize };

type CapAction =
  | { kind: "apply"; tier: WritableTier; label: string; preset?: string; custom?: TierSize }
  | { kind: "merge"; tier: WritableTier; label: string; prNumber: number; headSha: string }
  | { kind: "atlas"; size: AtlasSize }
  | { kind: "live"; tier: LiveTier; label: string; preset?: string; custom?: TierSize; planHash: string };
type LiveTier = "staging" | "production";

type ApplyResult = { prNumber: number; prUrl: string; existing: boolean; files: string[]; branch: string };
type MergeResult = { prNumber: number; mergedSha: string; tier: string; label: string };
type AtlasResult = { cluster: string; from: string; to: string; state: string };
type LiveResult = { cluster: string; applied: string[]; failed?: string };

const TIERS: CapacityTier[] = ["preview", "staging", "production"];
const isWritable = (t: CapacityTier): t is WritableTier => t !== "production";

const fmtSize = (s: ServiceSize | null | undefined) =>
  s ? `${s.autoscaling?.enabled ? `HPA ${s.autoscaling.minReplicas}–${s.autoscaling.maxReplicas}` : `${s.replicas}×`} · ${s.requests.cpu}/${s.requests.memory}` : "—";
const usd = (n: number | null) => (n === null ? "?" : `$${n.toLocaleString("en-US")}`);
const label: CSSProperties = { fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--n-ink-faint)" };

function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="n-plate" style={{ padding: 16, minWidth: 0, display: "flex", flexDirection: "column" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, paddingBottom: 10, marginBottom: 6, borderBottom: "1px solid var(--n-hairline)" }}>
        <div className="n-display" style={{ fontSize: 18 }}>{title}</div>
        {right}
      </header>
      {children}
    </section>
  );
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/yaml" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

// Capacity (docs/NEBULA.md §N5): pick a tier, pick a preset or estimate from
// expected traffic, read the diff + cost, then — NonProd and staging only —
// open ONE gitops PR (gate 1) and merge it (gate 2). The NonProd Atlas tier is
// its own gated call. Prod is a config pane: the same plan, exported as YAML.
export function CapacityView({ operator, login }: { operator: boolean; login: string }) {
  const utils = trpc.useUtils();
  const [tier, setTier] = useState<CapacityTier>("preview");
  const [choice, setChoice] = useState<Choice | null>(null);
  const [traffic, setTraffic] = useState({ rps: "200", peakFactor: "2", headroom: "1.3" });
  const [estimateArgs, setEstimateArgs] = useState<{ rps: number; peakFactor: number; headroom: number } | null>(null);
  const [action, setAction] = useState<CapAction | null>(null);

  const overview = trpc.capacity.overview.useQuery(undefined, { retry: false, refetchInterval: 60_000 });
  const tierQ = trpc.capacity.tier.useQuery({ tier }, { retry: false, refetchInterval: 60_000 });
  const planQ = trpc.capacity.plan.useQuery(
    choice?.mode === "preset" ? { tier, preset: choice.name } : { tier, custom: choice?.mode === "custom" ? choice.size : undefined },
    { enabled: !!choice, retry: false },
  );
  const estimateQ = trpc.capacity.estimate.useQuery({ tier, ...(estimateArgs ?? { rps: 0, peakFactor: 1, headroom: 1 }) }, { enabled: !!estimateArgs, retry: false });

  const apply = trpc.actions.applyCapacityPreset.useMutation();
  const merge = trpc.actions.mergeCapacityPr.useMutation();
  const atlas = trpc.actions.setAtlasTier.useMutation();
  const liveApply = trpc.actions.applyLiveCapacity.useMutation();
  const run = useCallback(
    async (args: { action: CapAction; confirm?: string }): Promise<GateResult> => {
      const { action: a, confirm } = args;
      if (a.kind === "apply") return (await apply.mutateAsync({ tier: a.tier, preset: a.preset, custom: a.custom, confirm })) as GateResult;
      if (a.kind === "merge") return (await merge.mutateAsync({ tier: a.tier, label: a.label, prNumber: a.prNumber, headSha: a.headSha, confirm })) as GateResult;
      if (a.kind === "live") return (await liveApply.mutateAsync({ tier: a.tier, preset: a.preset, custom: a.custom, planHash: a.planHash, confirm })) as GateResult;
      return (await atlas.mutateAsync({ tier: "preview", size: a.size, confirm })) as GateResult;
    },
    [apply, merge, atlas, liveApply],
  );
  const gated = useGatedAction<{ action: CapAction }, ApplyResult | MergeResult | AtlasResult | LiveResult>(run);
  const start = (a: CapAction) => {
    setAction(a);
    void gated.request({ action: a });
  };
  const closeGate = () => {
    const wasDone = gated.phase.kind === "done";
    gated.reset();
    setAction(null);
    if (wasDone) {
      void utils.capacity.invalidate();
    }
  };
  const switchTier = (t: CapacityTier) => {
    setTier(t);
    setChoice(null);
    setEstimateArgs(null);
  };

  const presets = (overview.data?.presets ?? []).filter((p) => !!p.tiers[tier]);
  const prs = (overview.data?.prs ?? []).filter((p) => p.tier === tier);
  const plan = planQ.data;
  const writable = isWritable(tier) && !!tierQ.data?.writable;
  const title =
    action?.kind === "apply"
      ? `Apply "${action.label}" to ${CAPACITY_TIER_LABEL[action.tier]}`
      : action?.kind === "merge"
        ? `Merge capacity PR #${action.prNumber}`
        : action?.kind === "live"
          ? `Resize ${CAPACITY_TIER_LABEL[action.tier]} live → "${action.label}"`
          : action
            ? `Resize NonProd Atlas → ${action.size.instanceSize}`
            : "";
  const liveTier = tier === "staging" || tier === "production" ? (tier as LiveTier) : null;

  return (
    <div style={{ padding: 28, maxWidth: 1500 }}>
      <PageHeader title="Capacity" kicker="size pods, nodes and the Atlas tier ahead of traffic · every change is a gitops PR or a gated call">
        {!operator && <Pill word="READ-ONLY" title={`${login} is not in NEBULA_OPERATORS; applying capacity is operator-only`} />}
      </PageHeader>

      <nav style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {TIERS.map((t) => (
          <Button key={t} variant={t === tier ? "ion" : "quiet"} onClick={() => switchTier(t)}>
            {CAPACITY_TIER_LABEL[t]}
          </Button>
        ))}
        <span style={{ flex: 1 }} />
        {tierQ.data && <Pill word="DEPLOYABLE" title={liveTier ? `${tierQ.data.cluster}: workloads (ns default/jobs) + node groups resized live, gated` : `${tierQ.data.cluster}: Nebula opens capacity PRs`} />}
        {tier === "staging" && <Pill word="STAGING" title="ns default/jobs + node group live; ns sentinel by gitops PR" />}
      </nav>

      {[overview.error, tierQ.error, overview.data?.presetsError, overview.data?.prsError].filter(Boolean).map((e, i) => (
        <div key={i} className="n-plate" style={{ padding: 12, marginBottom: 12, borderColor: "color-mix(in oklab, var(--n-fail) 50%, transparent)" }}>
          <Pill word="FAIL" /> <span style={{ marginLeft: 8, color: "var(--n-fail)" }}>{typeof e === "string" ? e : (e as { message: string }).message}</span>
        </div>
      ))}

      {prs.length > 0 && (
        <div className="n-plate" style={{ padding: 12, marginBottom: 16 }}>
          {prs.map((p) => (
            <div key={p.number} style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 0", fontSize: 11 }}>
              <Pill word="AWAITING HUMAN" title="a capacity PR is open; merging is the second gate" />
              <a href={p.url} target="_blank" rel="noreferrer" style={{ color: "var(--n-ion-soft)", textDecoration: "none" }}>#{p.number} ↗</a>
              <span style={{ flex: 1, color: "var(--n-ink-muted)" }}>{p.title} · by {p.author}</span>
              <Button disabled={!operator || !isWritable(p.tier)} title={operator ? `squash-merge #${p.number} at ${p.headSha.slice(0, 7)}` : "operators only"} onClick={() => isWritable(p.tier) && start({ kind: "merge", tier: p.tier, label: p.label, prNumber: p.number, headSha: p.headSha })}>
                Merge
              </Button>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))", gap: 16, alignItems: "start" }}>
        <CurrentPane data={tierQ.data} loading={tierQ.isLoading} />

        <Section title="Template">
          <div style={{ ...label, margin: "6px 0 8px" }}>presets · capacity/presets.yaml</div>
          {overview.isLoading && <span style={{ color: "var(--n-ink-muted)" }}>reading twizz-gitops…</span>}
          {presets.map((p) => {
            const active = choice?.mode === "preset" && choice.name === p.name;
            return (
              <button
                key={p.name}
                type="button"
                onClick={() => setChoice({ mode: "preset", name: p.name })}
                style={{ display: "block", width: "100%", textAlign: "left", padding: "9px 10px", marginBottom: 6, fontFamily: "inherit", cursor: "pointer", border: `1px solid ${active ? "var(--n-ion)" : "var(--n-hairline-strong)"}`, borderRadius: "var(--n-radius)", background: active ? "color-mix(in oklab, var(--n-ion) 12%, transparent)" : "transparent", color: "var(--n-ink)" }}
              >
                <div style={{ fontSize: 13 }}>{active ? "● " : "○ "}{p.title}</div>
                {p.description && <div style={{ fontSize: 11, color: "var(--n-ink-muted)", marginTop: 3 }}>{p.description}</div>}
              </button>
            );
          })}

          <div style={{ ...label, margin: "18px 0 8px" }}>traffic calculator · capacity/profiles.yaml</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
            <Field label="steady rps"><input style={inputStyle} inputMode="numeric" value={traffic.rps} onChange={(e) => setTraffic({ ...traffic, rps: e.target.value })} /></Field>
            <Field label="peak ×"><input style={inputStyle} inputMode="decimal" value={traffic.peakFactor} onChange={(e) => setTraffic({ ...traffic, peakFactor: e.target.value })} /></Field>
            <Field label="headroom ×"><input style={inputStyle} inputMode="decimal" value={traffic.headroom} onChange={(e) => setTraffic({ ...traffic, headroom: e.target.value })} /></Field>
          </div>
          <Button
            disabled={!(Number(traffic.rps) >= 0 && Number(traffic.peakFactor) >= 1 && Number(traffic.headroom) >= 1)}
            onClick={() => setEstimateArgs({ rps: Number(traffic.rps), peakFactor: Number(traffic.peakFactor), headroom: Number(traffic.headroom) })}
          >
            Estimate
          </Button>
          {estimateQ.error && <div style={{ marginTop: 10, color: "var(--n-fail)", fontSize: 11 }}><Pill word="FAIL" /> {estimateQ.error.message}</div>}
          {estimateQ.data && <EstimateBox e={estimateQ.data} onUse={(size) => setChoice({ mode: "custom", size })} onPreset={(name) => setChoice({ mode: "preset", name })} />}

          {liveTier && tierQ.data?.live && "baseline" in tierQ.data.live && (
            <LiveEditor
              key={`${tier}-${choice?.mode === "preset" ? choice.name : "live"}`}
              live={tierQ.data.live}
              seed={(choice?.mode === "preset" ? presets.find((p) => p.name === choice.name)?.tiers[tier]?.live : undefined) ?? tierQ.data.live.baseline}
              onPlan={(live) => setChoice({ mode: "custom", size: { services: {}, live } })}
            />
          )}
        </Section>

        <Section
          title="Plan"
          right={plan && <span style={{ fontSize: 12 }}>{usd(plan.cost.before)} → <b>{usd(plan.cost.after)}</b><span style={{ color: "var(--n-ink-faint)" }}> /mo ≈</span></span>}
        >
          {!choice && <span style={{ color: "var(--n-ink-muted)", fontSize: 12 }}>Pick a preset or run the calculator.</span>}
          {planQ.isLoading && choice && <span style={{ color: "var(--n-ink-muted)" }}>planning…</span>}
          {planQ.error && <div style={{ color: "var(--n-fail)", fontSize: 11 }}><Pill word="FAIL" /> {planQ.error.message}</div>}
          {plan && <PlanBody plan={plan} />}
          {plan?.live && <LivePlanBody live={plan.live} />}
          {plan && (
            <footer style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
              {writable && isWritable(tier) && (
                <Button
                  variant="ion"
                  disabled={!operator || plan.files.length === 0 || plan.violations.length > 0}
                  title={!operator ? "operators only" : plan.violations.length ? "over the tier caps" : plan.files.length === 0 ? "nothing to change in gitops" : `one PR on twizz-gitops: ${plan.files.join(", ")}`}
                  onClick={() => start({ kind: "apply", tier, label: plan.label, ...(choice?.mode === "preset" ? { preset: choice.name } : { custom: plan.size }) })}
                >
                  Open PR
                </Button>
              )}
              {plan.atlas?.writable && plan.atlas.changes.length > 0 && (
                <Button disabled={!operator || plan.violations.length > 0} title={operator ? `resize ${plan.atlas.cluster} now (Atlas API, gated)` : "operators only"} onClick={() => plan.atlas && start({ kind: "atlas", size: plan.atlas.after })}>
                  Apply Atlas tier
                </Button>
              )}
              {liveTier && plan.live && "ops" in plan.live && (
                <Button
                  variant="ion"
                  disabled={!operator || plan.live.ops.length === 0 || plan.live.violations.length > 0}
                  title={!operator ? "operators only" : plan.live.violations.length ? "refused — see the plan" : plan.live.ops.length === 0 ? "the cluster already matches" : `${plan.live.ops.length} change(s) on ${plan.live.cluster}, two-step confirm`}
                  onClick={() => plan.live && "planHash" in plan.live && start({ kind: "live", tier: liveTier, label: plan.label, ...(choice?.mode === "preset" ? { preset: choice.name } : { custom: plan.size }), planHash: plan.live.planHash })}
                >
                  Apply to {tierQ.data?.cluster ?? "cluster"}
                </Button>
              )}
              <Button onClick={() => download(`capacity-${tier}-${plan.label}.yaml`, plan.exportYaml)} title="the whole plan as YAML — the hand-off for tiers Nebula does not write">
                Export YAML
              </Button>
            </footer>
          )}
        </Section>
      </div>

      <GateDialog<ApplyResult | MergeResult | AtlasResult | LiveResult>
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
              <Row label="files" last>{r.files.join(", ")}</Row>
              <p style={{ margin: "12px 0 0", color: "var(--n-ink-muted)", lineHeight: 1.6 }}>Nothing has changed yet. Merge the PR (here or on GitHub) and Argo CD resizes the tier.</p>
            </div>
          ) : "applied" in r ? (
            <div style={{ marginBottom: 14, fontSize: 12, lineHeight: 1.6 }}>
              {r.applied.map((x) => (
                <div key={x}>✓ {x}</div>
              ))}
              {r.failed && <div style={{ color: "var(--n-fail)" }}>✗ {r.failed} — stopped here; nothing after it ran</div>}
              <p style={{ margin: "10px 0 0", color: "var(--n-ink-muted)" }}>{r.cluster}: applied live. Node groups take a few minutes to add or drain nodes.</p>
            </div>
          ) : "mergedSha" in r ? (
            <p style={{ marginBottom: 14, color: "var(--n-ink-muted)", lineHeight: 1.6 }}>Merged #{r.prNumber} ({r.mergedSha.slice(0, 7)}). Argo CD applies {r.label} to {r.tier} within ~3 minutes.</p>
          ) : (
            <p style={{ marginBottom: 14, color: "var(--n-ink-muted)", lineHeight: 1.6 }}>{r.cluster}: {r.from} → {r.to}. Atlas reports {r.state}; the roll takes a few minutes.</p>
          )
        }
      />
    </div>
  );
}

type LiveView = NonNullable<TierView["live"]>;
type LiveOk = Extract<LiveView, { baseline: unknown }>;
type LiveSize = NonNullable<TierSize["live"]>;

function LiveCurrent({ live }: { live: LiveView }) {
  if (!("baseline" in live)) return <div style={{ fontSize: 11, color: "var(--n-fail)", margin: "6px 0" }}><Pill word="UNKNOWN" /> live cluster not readable: {live.error}</div>;
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ ...label, margin: "6px 0 4px" }}>live · {live.cluster} · read {new Date(live.readAt).toLocaleTimeString()}</div>
      {live.workloads.map((w) => (
        <div key={`${w.namespace}/${w.name}`} style={{ display: "flex", gap: 8, fontSize: 12, padding: "2px 0" }}>
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }} title={`${w.namespace}/${w.name}`}>
            {(live.pair as readonly string[]).includes(w.name) ? "⇆ " : ""}{w.name.replace(/-deployment$/, "")}
          </span>
          <span style={{ whiteSpace: "nowrap" }}>{w.ready}/{w.replicas}{w.hpa ? ` · HPA ${w.hpa.min}–${w.hpa.max}` : ""}</span>
          <span style={{ color: "var(--n-ink-faint)", whiteSpace: "nowrap", fontSize: 11 }}>{w.resources.requests?.cpu || w.resources.limits?.cpu ? `${w.resources.requests?.cpu ?? "–"}/${w.resources.limits?.memory ?? "–"}` : "no requests"}</span>
        </div>
      ))}
      <div style={{ ...label, margin: "10px 0 4px" }}>node groups · {live.nodes.length} nodes · {live.nodes.reduce((a, n) => a + n.cpuCores, 0)} vCPU · metrics-server {live.metricsServer ? "yes" : "no"}</div>
      {live.nodegroups.map((n) => (
        <div key={n.name} style={{ fontSize: 12 }}>
          {n.name}: {n.min}/{n.desired}/{n.max} <span style={{ color: "var(--n-ink-faint)" }}>(min/desired/max · {n.instanceTypes.join(",")} · {n.status})</span>
        </div>
      ))}
    </div>
  );
}

/** Edit the live sizing directly: the pair moves together; everything else defaults to what runs. */
function LiveEditor({ live, seed, onPlan }: { live: LiveOk; seed: LiveSize; onPlan: (s: LiveSize) => void }) {
  const pair = live.pair as readonly string[];
  const init = () => {
    const w: Record<string, { replicas: string; hpa: boolean; min: string; max: string }> = {};
    for (const x of live.workloads) {
      const s = seed.workloads[x.name] ?? live.baseline.workloads[x.name];
      w[x.name] = { replicas: String(s?.replicas ?? x.replicas), hpa: !!s?.autoscaling?.enabled, min: String(s?.autoscaling?.minReplicas ?? x.replicas), max: String(s?.autoscaling?.maxReplicas ?? x.replicas * 2) };
    }
    const n: Record<string, { min: string; desired: string; max: string }> = {};
    for (const g of live.nodegroups) {
      const s = seed.nodegroups[g.name] ?? { min: g.min, desired: g.desired, max: g.max };
      n[g.name] = { min: String(s.min), desired: String(s.desired), max: String(s.max) };
    }
    // a preset seeds (and so "touches") exactly what it names; the live baseline touches nothing
    const fromPreset = seed !== live.baseline;
    const touched = new Set<string>(fromPreset ? [...Object.keys(seed.workloads), ...Object.keys(seed.nodegroups).map((k) => `ng:${k}`)] : []);
    return { w, n, touched };
  };
  const [st, setSt] = useState(init);
  const setW = (name: string, patch: Partial<(typeof st.w)[string]>) =>
    setSt((p) => {
      const w = { ...p.w, [name]: { ...p.w[name], ...patch } };
      const touched = new Set(p.touched).add(name);
      // the pair always moves together
      if (pair.includes(name)) for (const other of pair) if (other !== name && w[other]) { w[other] = { ...w[name] }; touched.add(other); }
      return { ...p, w, touched };
    });
  const setN = (name: string, v: (typeof st.n)[string]) => setSt((p) => ({ ...p, n: { ...p.n, [name]: v }, touched: new Set(p.touched).add(`ng:${name}`) }));
  // only what was touched is sent: everything else stays at whatever runs at apply time
  const build = (): LiveSize => {
    const workloads: LiveSize["workloads"] = {};
    for (const [name, v] of Object.entries(st.w)) {
      if (!st.touched.has(name)) continue;
      workloads[name] = v.hpa
        ? { replicas: Number(v.min), autoscaling: { enabled: true, minReplicas: Number(v.min), maxReplicas: Number(v.max), targetCPUUtilizationPercentage: 70 } }
        : { replicas: Number(v.replicas) };
    }
    const nodegroups: LiveSize["nodegroups"] = {};
    for (const [name, v] of Object.entries(st.n)) if (st.touched.has(`ng:${name}`)) nodegroups[name] = { min: Number(v.min), desired: Number(v.desired), max: Number(v.max) };
    return { workloads, nodegroups };
  };
  const num: CSSProperties = { ...inputStyle, width: 64, padding: "4px 6px" };
  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ ...label, margin: "0 0 8px" }}>live sizing · {live.cluster} · ⇆ = scales as a pair</div>
      {Object.entries(st.w).map(([name, v]) => (
        <div key={name} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, marginBottom: 4, flexWrap: "wrap" }}>
          <span style={{ flex: 1, minWidth: 140 }}>{pair.includes(name) ? "⇆ " : ""}{name.replace(/-deployment$/, "")}</span>
          {v.hpa ? (
            <>
              <input style={num} aria-label={`${name} HPA min`} value={v.min} onChange={(e) => setW(name, { min: e.target.value })} />–
              <input style={num} aria-label={`${name} HPA max`} value={v.max} onChange={(e) => setW(name, { max: e.target.value })} />
            </>
          ) : (
            <input style={num} aria-label={`${name} replicas`} value={v.replicas} onChange={(e) => setW(name, { replicas: e.target.value })} />
          )}
          <label style={{ fontSize: 11, color: "var(--n-ink-muted)" }} title={live.metricsServer ? "CPU HPA at 70%" : "no metrics-server on this cluster"}>
            <input type="checkbox" disabled={!live.metricsServer} checked={v.hpa} onChange={(e) => setW(name, { hpa: e.target.checked })} /> HPA
          </label>
        </div>
      ))}
      {Object.entries(st.n).map(([name, v]) => (
        <div key={name} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, marginBottom: 4, flexWrap: "wrap" }}>
          <span style={{ flex: 1, minWidth: 140 }} title={name}>nodes {name.replace(/^eks-/, "")}</span>
          <input style={num} aria-label={`${name} min`} value={v.min} onChange={(e) => setN(name, { ...v, min: e.target.value })} />/
          <input style={num} aria-label={`${name} desired`} value={v.desired} onChange={(e) => setN(name, { ...v, desired: e.target.value })} />/
          <input style={num} aria-label={`${name} max`} value={v.max} onChange={(e) => setN(name, { ...v, max: e.target.value })} />
        </div>
      ))}
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <Button variant="ion" disabled={st.touched.size === 0} title={st.touched.size ? `plans only what you changed (${st.touched.size})` : "change a value first"} onClick={() => onPlan(build())}>Plan these values</Button>
        <Button onClick={() => setSt(init())}>Reset</Button>
      </div>
    </div>
  );
}

type LivePlanView = NonNullable<PlanView["live"]>;

function LivePlanBody({ live }: { live: LivePlanView }) {
  if (!("ops" in live)) return <div style={{ fontSize: 11, color: "var(--n-fail)", marginTop: 8 }}><Pill word="FAIL" /> live cluster not readable: {live.error}</div>;
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ ...label, margin: "0 0 6px" }}>live · {live.cluster} · {live.ops.length} change(s)</div>
      {live.violations.map((v) => (
        <div key={v} style={{ fontSize: 11, color: "var(--n-fail)", marginBottom: 4 }}><Pill word="DENIED" /> {v}</div>
      ))}
      {live.rows.map((r) => (
        <div key={r.workload} style={{ display: "flex", gap: 8, fontSize: 12, padding: "2px 0", color: r.changes.length ? "var(--n-ink)" : "var(--n-ink-faint)" }}>
          <span style={{ flex: 1, minWidth: 0 }}>{r.pair ? "⇆ " : ""}{r.workload.replace(/-deployment$/, "")}</span>
          <span style={{ textAlign: "right" }}>{r.changes.length ? r.changes.join("; ") : r.after}</span>
        </div>
      ))}
      {live.nodegroupRows.map((r) => (
        <div key={r.name} style={{ display: "flex", gap: 8, fontSize: 12, padding: "2px 0", color: r.changes.length ? "var(--n-ink)" : "var(--n-ink-faint)" }}>
          <span style={{ flex: 1, minWidth: 0 }}>nodes {r.name.replace(/^eks-/, "")}</span>
          <span>{r.changes.length ? r.changes.join("; ") : r.after}</span>
        </div>
      ))}
      {live.warnings.map((w) => (
        <div key={w} style={{ fontSize: 11, color: "var(--n-pending)", marginTop: 4 }}>⚠ {w}</div>
      ))}
      {live.opsText.length > 0 && (
        <div style={{ fontSize: 11, color: "var(--n-ink-muted)", marginTop: 8 }}>
          order: {live.opsText.map((t, i) => <div key={i}>{i + 1}. {t}</div>)}
        </div>
      )}
    </div>
  );
}

function CurrentPane({ data, loading }: { data?: TierView; loading: boolean }) {
  if (!data) return <Section title="Current">{loading ? <span style={{ color: "var(--n-ink-muted)" }}>reading gitops, CloudWatch{" "}and Atlas…</span> : null}</Section>;
  const o = data.observed;
  return (
    <Section title="Current" right={<span style={{ fontSize: 11, color: "var(--n-ink-muted)" }}>{data.cluster}</span>}>
      {data.live && <LiveCurrent live={data.live} />}
      {o.podsError && <div style={{ fontSize: 11, color: "var(--n-ink-muted)", marginBottom: 6 }}><Pill word="UNKNOWN" /> pods: {o.podsError}</div>}
      {data.targets.map((t, i) => {
        const declared = data.declared.services[t.name];
        const seen = o.services.find((s) => s.service === t.name);
        return (
          <Row key={t.name} label={t.name} last={i === data.targets.length - 1}>
            <div style={{ width: "100%" }}>
              <div style={{ fontSize: 12 }}>
                {declared ? fmtSize(declared) : <span style={{ color: "var(--n-ink-faint)" }}>{t.valuesFile ? "no sizing in gitops" : "not in gitops (own pipeline)"}</span>}
                {!t.writable && <span style={{ marginLeft: 8 }}><Pill word="OBSERVE ONLY" title="planned and exported here; applied by its own pipeline" /></span>}
              </div>
              <div style={{ fontSize: 11, color: "var(--n-ink-muted)", marginTop: 2 }}>
                {seen ? `${seen.running}/${seen.pods} pods running${seen.cpuUtil !== undefined ? ` · cpu ${seen.cpuUtil}%` : ""}${seen.memUtil !== undefined ? ` · mem ${seen.memUtil}%` : ""}${seen.hpa ? ` · HPA ${seen.hpa.current}→${seen.hpa.desired} (${seen.hpa.min}–${seen.hpa.max})` : ""}` : "—"}
              </div>
            </div>
          </Row>
        );
      })}
      <div style={{ ...label, margin: "14px 0 4px" }}>nodes</div>
      <div style={{ fontSize: 12 }}>
        {o.nodes.error ? <span style={{ color: "var(--n-ink-muted)" }}><Pill word="UNKNOWN" /> {o.nodes.error}</span> : `${o.nodes.count} node(s)${o.nodes.vcpu !== undefined ? ` · ${o.nodes.vcpu} vCPU` : ""}${o.nodes.cpuUtil !== undefined ? ` · cpu ${o.nodes.cpuUtil}%` : ""}${o.nodes.memUtil !== undefined ? ` · mem ${o.nodes.memUtil}%` : ""}`}
      </div>
      {data.declared.nodes && <div style={{ fontSize: 11, color: "var(--n-ink-muted)", marginTop: 2 }}>Nebula-managed overflow pool `spot`: ceiling {data.declared.nodes.maxCpu} vCPU/{data.declared.nodes.maxMemoryGi}Gi · warm {data.declared.nodes.warmCpu} vCPU</div>}
      {o.nodes.pools.map((p) => (
        <div key={p.name} style={{ fontSize: 11, color: "var(--n-ink-muted)" }}>
          pool {p.name}: using {p.usedCpu ?? "0"} vCPU of {p.limitCpu ?? "no limit"}{p.name === "spot" ? " (managed here)" : " (not managed by Nebula)"}
        </div>
      ))}
      {!data.nodesManaged && data.tier !== "preview" && <div style={{ fontSize: 11, color: "var(--n-ink-faint)", marginTop: 2 }}>node pools here are not Nebula-managed: recommendations only</div>}
      {o.nodes.kubeError && <div style={{ fontSize: 11, color: "var(--n-ink-faint)", marginTop: 2 }}>kube: {o.nodes.kubeError}</div>}
      <div style={{ ...label, margin: "14px 0 4px" }}>atlas</div>
      {data.prodAtlas &&
        ("clusters" in data.prodAtlas ? (
          data.prodAtlas.clusters.map((c) => (
            <div key={c.name} style={{ fontSize: 12 }}>
              {c.name}: {c.instanceSize}{c.autoScaling ? ` (auto ${c.autoScaling.min}–${c.autoScaling.max})` : ""} <span style={{ color: "var(--n-ink-faint)" }}>{c.state}</span>
            </div>
          ))
        ) : (
          <div style={{ fontSize: 12, color: "var(--n-ink-muted)" }}><Pill word="UNKNOWN" /> {data.prodAtlas.error}</div>
        ))}
      <div style={{ fontSize: 12 }}>
        {data.atlas.current ? `${data.atlas.cluster}: ${data.atlas.current.instanceSize}${data.atlas.current.autoScaling ? ` (auto ${data.atlas.current.autoScaling.min}–${data.atlas.current.autoScaling.max})` : ""}` : <span style={{ color: "var(--n-ink-muted)" }}><Pill word="UNKNOWN" /> {data.atlas.error ?? "not read"}</span>}
      </div>
    </Section>
  );
}

function PlanBody({ plan }: { plan: PlanView }) {
  return (
    <div>
      {plan.violations.map((v) => (
        <div key={v} style={{ fontSize: 11, color: "var(--n-fail)", marginBottom: 4 }}><Pill word="DENIED" /> {v}</div>
      ))}
      {plan.services.map((s, i) => (
        <Row key={s.service} label={s.service} last={i === plan.services.length - 1 && !plan.nodes && !plan.atlas}>
          <div style={{ width: "100%", fontSize: 12 }}>
            {s.changes.length === 0 ? <span style={{ color: "var(--n-ink-faint)" }}>unchanged · {fmtSize(s.after)}</span> : s.changes.map((c) => <div key={c}>{c}</div>)}
            {!s.writable && s.changes.length > 0 && <div style={{ fontSize: 10, color: "var(--n-ink-faint)", marginTop: 2 }}>export only</div>}
          </div>
        </Row>
      ))}
      {plan.nodes && (
        <Row label="nodes" last={!plan.atlas}>
          <div style={{ fontSize: 12 }}>
            {plan.nodes.changes.length ? plan.nodes.changes.map((c) => <div key={c}>{c}</div>) : <span style={{ color: "var(--n-ink-faint)" }}>unchanged</span>}
            {!plan.nodes.writable && <div style={{ fontSize: 10, color: "var(--n-ink-faint)", marginTop: 2 }}>recommendation only</div>}
          </div>
        </Row>
      )}
      {plan.atlas && (
        <Row label="atlas" last>
          <div style={{ fontSize: 12 }}>
            {plan.atlas.changes.length ? plan.atlas.changes.map((c) => <div key={c}>{c}</div>) : <span style={{ color: "var(--n-ink-faint)" }}>unchanged</span>}
            <div style={{ fontSize: 10, color: "var(--n-ink-faint)", marginTop: 2 }}>{plan.atlas.writable ? "applied separately (not part of the PR)" : plan.atlas.cluster ? "recommendation only" : "no Atlas cluster linked to this tier — recommendation only"}</div>
          </div>
        </Row>
      )}
      {plan.warnings.map((w) => (
        <div key={w} style={{ fontSize: 11, color: "var(--n-pending)", marginTop: 6 }}>⚠ {w}</div>
      ))}
      {plan.files.length > 0 && <div style={{ fontSize: 11, color: "var(--n-ink-muted)", marginTop: 10 }}>PR would change: {plan.files.join(", ")}</div>}
    </div>
  );
}

function EstimateBox({ e, onUse, onPreset }: { e: EstimateView; onUse: (s: TierSize) => void; onPreset: (name: string) => void }) {
  return (
    <div style={{ marginTop: 12, padding: 10, border: "1px solid var(--n-hairline-strong)", borderRadius: "var(--n-radius)" }}>
      {e.rationale.map((r) => (
        <div key={r} style={{ fontSize: 11, color: "var(--n-ink-muted)", lineHeight: 1.6 }}>{r}</div>
      ))}
      <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        <Button variant="ion" onClick={() => onUse(e.size)}>Plan this estimate</Button>
        {e.nearest && <Button onClick={() => onPreset(e.nearest!)}>Closest preset: {e.nearest}</Button>}
      </div>
    </div>
  );
}
