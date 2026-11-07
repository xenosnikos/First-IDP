"use client";

import { useEffect, useState, type CSSProperties } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { TierSize } from "@twizz-idp/shared";
import type { AppRouter } from "@/server/routers/_app";
import { trpc } from "@/lib/trpc-client";
import { Pill } from "@/components/nebula/pill";
import type { StatusWord } from "@/lib/nebula/status";

type Verify = inferRouterOutputs<AppRouter>["capacity"]["verify"];
type Check = Verify["check"];

const POLL_MS = 5_000;
/** EC2 launch + bootstrap, or a drain, normally finishes well inside this */
const SLOW_AFTER_MS = 10 * 60_000;
const small: CSSProperties = { fontSize: 11, color: "var(--n-ink-muted)" };

const fmtElapsed = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Pure: the headline for a check at `elapsedMs`. Exported for tests. */
export function progressHeadline(check: Check | undefined, elapsedMs: number, readFailing: boolean): { word: StatusWord; text: string } {
  if (!check) return { word: readFailing ? "UNKNOWN" : "PENDING", text: readFailing ? "can't read the cluster yet — retrying" : "reading the cluster…" };
  if (check.verdict === "READY") return { word: "PASS", text: "applied — every pod is up and every node group is at its target" };
  if (check.verdict === "MISMATCH") return { word: "FAIL", text: "the cluster no longer matches what you applied (another resize, a deploy, or an HPA changed it)" };
  const blocking = check.issues.some((i) => i.kind === "nodegroup" || i.reason !== "StuckTerminating");
  if (blocking) return { word: "WATCH", text: "still converging, and something is in the way — see issues below" };
  if (elapsedMs > SLOW_AFTER_MS) return { word: "WATCH", text: `still converging after ${Math.round(elapsedMs / 60_000)} min — slower than usual` };
  return { word: "RUNNING", text: "converging — pods starting / stopping and nodes joining / draining" };
}

/** Live rollout progress after apply_live_capacity: polls capacity.verify (no CloudWatch) every
 * 5 s until READY, draws pods and nodes converging, and surfaces anything stuck. Read-only. */
export function LiveProgress({ tier, preset, custom }: { tier: "staging" | "production"; preset?: string; custom?: TierSize }) {
  // mounted when the apply returns: that is "since you confirmed"
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(startedAt);
  const q = trpc.capacity.verify.useQuery(
    { tier, load: false, ...(preset ? { preset } : { custom: custom! }) },
    {
      retry: false,
      refetchOnWindowFocus: false,
      staleTime: 0,
      refetchInterval: (query) => (query.state.data?.check.verdict === "READY" ? false : POLL_MS),
      refetchIntervalInBackground: true,
    },
  );
  const check = q.data?.check;
  const done = check?.verdict === "READY";
  const [doneAt, setDoneAt] = useState<number | null>(null);
  useEffect(() => {
    if (done && doneAt === null) setDoneAt(Date.now());
  }, [done, doneAt]);
  useEffect(() => {
    if (doneAt !== null) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [doneAt]);

  const elapsed = (doneAt ?? now) - startedAt;
  const head = progressHeadline(check, elapsed, !!q.error);

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <Pill word={head.word} />
        <span style={{ flex: 1, fontSize: 12 }}>{head.text}</span>
        <span style={{ ...small, fontVariantNumeric: "tabular-nums" }} title="since you confirmed">{fmtElapsed(elapsed)}</span>
      </div>

      {q.error && <div style={{ ...small, color: "var(--n-fail)", marginBottom: 8 }}>read failed: {q.error.message} — retrying every {POLL_MS / 1000} s</div>}

      {check && (
        <>
          {check.workloads.map((w) => (
            <PodBar key={w.name} name={w.name} want={w.want} ready={w.ready ?? 0} ok={w.ok} note={w.note} />
          ))}
          {check.nodegroups.map((g) => (
            <NodeDots key={g.name} g={g} />
          ))}
          {check.issues.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--n-ink-faint)", marginBottom: 4 }}>issues</div>
              {check.issues.map((i) => (
                <div key={`${i.kind}/${i.subject}/${i.reason}`} style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 11, padding: "2px 0" }}>
                  <Pill word={i.reason === "StuckTerminating" ? "WATCH" : "FAIL"} />
                  <span style={{ minWidth: 0, wordBreak: "break-word" }}>
                    <strong>{i.subject.replace(/-deployment$/, "")}</strong> · {i.reason}
                    {i.count && i.count > 1 ? ` ×${i.count}` : ""} — <span style={{ color: "var(--n-ink-muted)" }}>{i.message}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
          {q.data?.problemsError && <div style={{ ...small, marginTop: 6 }}>pod list unavailable ({q.data.problemsError}) — stuck pods can&apos;t be shown</div>}
          <div style={{ ...small, marginTop: 10 }}>
            {done ? `done in ${fmtElapsed(elapsed)}. ` : `checking every ${POLL_MS / 1000} s · read ${q.data ? new Date(q.data.readAt).toLocaleTimeString() : "—"}. `}
            You can close this; the resize continues on the cluster either way.
          </div>
        </>
      )}
    </div>
  );
}

function PodBar({ name, want, ready, ok, note }: { name: string; want: number; ready: number; ok: boolean; note?: string }) {
  const scale = Math.max(want, ready, 1);
  const inTarget = Math.min(ready, want);
  const extra = Math.max(0, ready - want); // scale-down: old pods still up
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", gap: 8, fontSize: 12, marginBottom: 3 }}>
        <span style={{ flex: 1, minWidth: 0 }}>{name.replace(/-deployment$/, "")}</span>
        <span style={{ fontVariantNumeric: "tabular-nums" }}>
          {ready}/{want} pods {ok ? "✓" : ""}
        </span>
      </div>
      <div style={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden", background: "var(--n-hairline)" }} aria-label={`${name}: ${ready} of ${want} pods ready`}>
        <div style={{ width: `${(inTarget / scale) * 100}%`, background: ok ? "var(--n-pass)" : "var(--n-ion)", transition: "width 600ms ease" }} />
        {extra > 0 && <div title={`${extra} pod(s) above target, stopping`} style={{ width: `${(extra / scale) * 100}%`, background: "var(--n-pending)", opacity: 0.6, transition: "width 600ms ease" }} />}
      </div>
      {note && !ok && <div style={{ ...small, marginTop: 2 }}>{note}</div>}
    </div>
  );
}

function NodeDots({ g }: { g: Check["nodegroups"][number] }) {
  // one dot per node the group has or should have: Ready (pass), joining (pending),
  // draining/terminating (faded), missing up to desired (outline)
  const other = Math.max(0, g.total - g.nodes - g.joining - g.draining); // e.g. NotReady and cordoned
  const missing = Math.max(0, g.want.desired - g.total);
  const dots: Array<{ kind: "ready" | "joining" | "draining" | "missing"; title: string }> = [
    ...Array.from({ length: g.nodes }, () => ({ kind: "ready" as const, title: "Ready" })),
    ...Array.from({ length: g.joining }, () => ({ kind: "joining" as const, title: "joining (not Ready yet)" })),
    ...Array.from({ length: g.draining + other }, () => ({ kind: "draining" as const, title: "draining / terminating" })),
    ...Array.from({ length: missing }, () => ({ kind: "missing" as const, title: "not launched yet" })),
  ];
  const style = (k: (typeof dots)[number]["kind"]): CSSProperties =>
    k === "ready"
      ? { background: "var(--n-pass)" }
      : k === "joining"
        ? { background: "var(--n-ion)", opacity: 0.7 }
        : k === "draining"
          ? { background: "var(--n-pending)", opacity: 0.45 }
          : { border: "1px dashed var(--n-hairline-strong)" };
  return (
    <div style={{ margin: "10px 0 8px" }}>
      <div style={{ display: "flex", gap: 8, fontSize: 12, marginBottom: 4 }}>
        <span style={{ flex: 1, minWidth: 0 }}>nodes · {g.name.replace(/^eks-/, "")}</span>
        <span style={{ fontVariantNumeric: "tabular-nums" }}>
          {g.nodes}/{g.want.desired} ready{g.draining ? ` · ${g.draining} draining` : ""}
          {g.joining ? ` · ${g.joining} joining` : ""} {g.ok ? "✓" : ""}
        </span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {dots.map((d, i) => (
          <span key={i} title={d.title} style={{ width: 14, height: 14, borderRadius: 3, boxSizing: "border-box", transition: "all 600ms ease", ...style(d.kind) }} />
        ))}
      </div>
      {g.note && !g.ok && <div style={{ ...small, marginTop: 3 }}>{g.note}</div>}
    </div>
  );
}
