"use client";

import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { Drawer } from "@/components/nebula/drawer";
import { Pill } from "@/components/nebula/pill";
import { Button } from "@/components/nebula/button";
import { Field, inputStyle, Row } from "@/components/nebula/plate";
import { GateDialog } from "@/components/nebula/gate-dialog";
import { useGatedAction, type GateResult } from "@/lib/nebula/use-gated-action";
import { ISOLATION_CAVEAT } from "./preview-card";

// Spin-up wizard (docs/NEBULA.md §4.7): service → release image → DB mode →
// TTL → optional frontend origin → Ember confirm → createNamedEnv.
// Nothing is built: only EXISTING immutable build-* images are offered.

const SERVICES = ["moly-backend"] as const;
type Service = (typeof SERVICES)[number];
const NAME_RE = /^[a-z][a-z0-9-]{2,23}$/;
const ALIAS_TAGS = new Set(["latest", "prod", "dev", "staging"]);
const TTL = { min: 1, max: 336, default: 168 };

type CreateResult = {
  name: string;
  url: string;
  argoApp: string;
  namespace: string;
  secret: string;
  db: string;
  image: { tag: string; aliases: string[]; pushedAt?: string | Date };
};

export function SpinUpDrawer({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [service, setService] = useState<Service>("moly-backend");
  const [imageTag, setImageTag] = useState<string>("");
  const [db, setDb] = useState<"isolated" | "clone">("isolated");
  const [ttlHours, setTtlHours] = useState<number>(TTL.default);
  const [frontendOrigin, setFrontendOrigin] = useState("");

  const images = trpc.actions.listReleaseImages.useQuery({ service, limit: 20 }, { enabled: open, staleTime: 60_000 });
  const create = trpc.actions.createNamedEnv.useMutation();
  const gated = useGatedAction<{ name: string; service: Service; imageTag: string; db: "isolated" | "clone"; ttlHours: number; frontendOrigin?: string }, CreateResult>(
    async (args) => (await create.mutateAsync(args)) as GateResult,
  );

  const selected = useMemo(() => images.data?.images.find((i) => i.tag === imageTag), [images.data, imageTag]);
  const nameOk = NAME_RE.test(name);
  const tagOk = /^build-[0-9a-f-]{36}$/.test(imageTag) && !ALIAS_TAGS.has(imageTag);
  const ttlOk = Number.isInteger(ttlHours) && ttlHours >= TTL.min && ttlHours <= TTL.max;
  const originOk = frontendOrigin === "" || /^https:\/\/[a-z0-9.-]+$/i.test(frontendOrigin);
  const ready = nameOk && tagOk && ttlOk && originOk;

  const problems: string[] = [];
  if (name && !nameOk) problems.push("name must match ^[a-z][a-z0-9-]{2,23}$ (it becomes <name>.prv.twizz.com)");
  if (imageTag && !tagOk) problems.push("only immutable build-* tags may be provisioned — aliases (latest/prod/dev) are refused");
  if (!ttlOk) problems.push(`TTL must be ${TTL.min}..${TTL.max} hours`);
  if (!originOk) problems.push("frontend origin must be an https:// origin with no path");

  const close = () => {
    gated.reset();
    onClose();
  };
  const finish = () => {
    gated.reset();
    onCreated();
    onClose();
  };

  return (
    <Drawer open={open} onClose={close} title="Spin up an environment">
      <p style={{ color: "var(--n-ink-muted)", margin: "0 0 18px", lineHeight: 1.6 }}>
        A named env runs an <b style={{ color: "var(--n-ink)" }}>existing</b> release image with its own Mongo db, Redis and JWT secret, at{" "}
        <span style={{ color: "var(--n-ion-soft)" }}>{nameOk ? name : "<name>"}.prv.twizz.com</span> (VPN + SSO). Nothing is built.
      </p>

      {gated.phase.kind !== "idle" ? (
        <GateDialog<CreateResult>
          inline
          title="Create named env"
          phase={gated.phase}
          onConfirm={gated.confirm}
          onClose={gated.phase.kind === "done" ? finish : () => gated.reset()}
          renderResult={(r) => (
            <div style={{ marginBottom: 14 }}>
              <Row label="url">
                <a href={r.url} target="_blank" rel="noreferrer" style={{ color: "var(--n-ion-soft)" }}>{r.url} ↗</a>
              </Row>
              <Row label="argo app">{r.argoApp}</Row>
              <Row label="db">{r.db}</Row>
              <Row label="secret">{r.secret}</Row>
              <Row label="release" last>{r.image.tag}</Row>
              <p style={{ margin: "12px 0 0", color: "var(--n-ink-muted)", lineHeight: 1.6 }}>
                Argo provisions in ~1–3 min; the card goes <Pill word="PENDING" /> → <Pill word="RUNNING" /> → <Pill word="PASS" />.
                {r.image.aliases.length > 0 && <> This image is also tagged {r.image.aliases.join(", ")}.</>}
              </p>
            </div>
          )}
        />
      ) : (
        <>
          <Field label="name" hint="DNS label; becomes namespace env-<name>, host <name>.prv.twizz.com, db nebula_<name>.">
            <input value={name} onChange={(e) => setName(e.target.value.trim().toLowerCase())} placeholder="e.g. igor-payments" style={inputStyle} autoFocus />
          </Field>

          <Field label="service">
            <select value={service} onChange={(e) => { setService(e.target.value as Service); setImageTag(""); }} style={inputStyle}>
              {SERVICES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>

          <Field label="release image" hint="Immutable ECR build-* tags, newest first, with the floating aliases that point at them today. Aliases themselves cannot be chosen.">
            {images.isLoading && <div style={{ color: "var(--n-ink-muted)" }}><Pill word="PENDING" /> reading ECR…</div>}
            {images.error && <div style={{ color: "var(--n-fail)" }}><Pill word="FAIL" /> {images.error.message}</div>}
            {images.data && (
              <div style={{ border: "1px solid var(--n-hairline-strong)", borderRadius: "var(--n-radius)", maxHeight: 260, overflowY: "auto", background: "var(--n-plate)" }}>
                {images.data.images.length === 0 && <div style={{ padding: 10, color: "var(--n-ink-muted)" }}>no build-* images in ECR for {service}</div>}
                {images.data.images.map((img) => {
                  const active = img.tag === imageTag;
                  return (
                    <button
                      type="button"
                      key={img.tag}
                      onClick={() => setImageTag(img.tag)}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1fr auto",
                        gap: 8,
                        width: "100%",
                        textAlign: "left",
                        padding: "8px 10px",
                        background: active ? "color-mix(in oklab, var(--n-ion) 14%, transparent)" : "transparent",
                        border: "none",
                        borderBottom: "1px solid var(--n-hairline)",
                        borderLeft: active ? "2px solid var(--n-ion)" : "2px solid transparent",
                        color: "var(--n-ink)",
                        fontFamily: "inherit",
                        fontSize: 11,
                        cursor: "pointer",
                      }}
                    >
                      <span style={{ wordBreak: "break-all" }}>{img.tag}</span>
                      <span style={{ color: "var(--n-ink-muted)", whiteSpace: "nowrap" }}>{img.pushedAt ? new Date(img.pushedAt).toLocaleDateString() : "—"}</span>
                      <span style={{ gridColumn: "1 / -1", display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {img.aliases.length === 0 && <span style={{ color: "var(--n-ink-faint)", fontSize: 10 }}>no aliases</span>}
                        {img.aliases.map((a) => (
                          <span key={a} style={{ fontSize: 10, padding: "0 6px", border: "1px solid var(--n-hairline-strong)", borderRadius: 3, color: "var(--n-ink-muted)" }}>{a}</span>
                        ))}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </Field>

          <Field label="database">
            <div style={{ display: "grid", gap: 8 }}>
              <label style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: 10, border: `1px solid ${db === "isolated" ? "var(--n-ion)" : "var(--n-hairline-strong)"}`, borderRadius: "var(--n-radius)", cursor: "pointer" }}>
                <input type="radio" name="db" checked={db === "isolated"} onChange={() => setDb("isolated")} />
                <span>
                  <span>isolated</span>
                  <span style={{ display: "block", color: "var(--n-ink-muted)", fontSize: 11, marginTop: 2 }}>An empty <code>nebula_{nameOk ? name : "<name>"}</code> on the shared NonProd Atlas cluster, created on first write. Cheapest real isolation. No staging data.</span>
                </span>
              </label>
              <label style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: 10, border: `1px solid ${db === "clone" ? "var(--n-ion)" : "var(--n-hairline-strong)"}`, borderRadius: "var(--n-radius)", cursor: "pointer" }}>
                <input type="radio" name="db" checked={db === "clone"} onChange={() => setDb("clone")} />
                <span>
                  <span>clone staging</span>
                  <span style={{ display: "block", color: "var(--n-ink-muted)", fontSize: 11, marginTop: 2 }}>A PreSync hook copies the staging db (~3.1M docs, a few minutes) into <code>nebula_{nameOk ? name : "<name>"}</code> in-cluster. Source is pinned to the staging blob; prod is impossible by construction.</span>
                </span>
              </label>
            </div>
          </Field>

          <Field label="ttl (hours)" hint={`Default ${TTL.default}h (7 days), max ${TTL.max}h. The reaper deletes the manifest after expiry; you can extend from the card.`}>
            <input type="number" min={TTL.min} max={TTL.max} value={ttlHours} onChange={(e) => setTtlHours(Number(e.target.value))} style={inputStyle} />
          </Field>

          <Field label="frontend origin (optional)" hint={`Browser origin allowed by ingress CORS. Default https://${nameOk ? name : "<name>"}-frontend.prv.twizz.com. Must live under .prv.twizz.com for the SSO cookie to ride.`}>
            <input value={frontendOrigin} onChange={(e) => setFrontendOrigin(e.target.value.trim())} placeholder={`https://${nameOk ? name : "<name>"}-frontend.prv.twizz.com`} style={inputStyle} />
          </Field>

          <p style={{ margin: "4px 0 16px", padding: "8px 10px", fontSize: 10, lineHeight: 1.5, color: "var(--n-ink-muted)", background: "var(--n-plate)", border: "1px solid var(--n-hairline)", borderRadius: "var(--n-radius)" }}>
            {ISOLATION_CAVEAT}
          </p>

          {problems.length > 0 && (
            <ul style={{ margin: "0 0 14px", paddingLeft: 16, color: "var(--n-fail)", fontSize: 11 }}>
              {problems.map((p) => <li key={p}>{p}</li>)}
            </ul>
          )}

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <span style={{ color: "var(--n-ink-faint)", fontSize: 10 }}>
              {selected ? `image pushed ${selected.pushedAt ? new Date(selected.pushedAt).toLocaleString() : "unknown"}` : "pick a release image"}
            </span>
            <Button
              variant="ion"
              disabled={!ready}
              onClick={() => gated.request({ name, service, imageTag, db, ttlHours, frontendOrigin: frontendOrigin || undefined })}
            >
              Review with the gate
            </Button>
          </div>
        </>
      )}
    </Drawer>
  );
}
