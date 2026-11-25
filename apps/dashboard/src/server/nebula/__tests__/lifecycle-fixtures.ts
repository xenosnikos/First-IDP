// Builders shared by the lifecycle tests (not a test file itself).
import type { LifecycleAdvisory, LifecycleBundle, LifecycleComponent, LifecyclePrRef, LifecycleSnapshotDoc } from "@twizz-idp/shared";
import type { PreviewEnvInput, RequestRow, SnapshotRow } from "../lifecycle-model";

export const NOW = new Date("2026-11-25T12:00:00.000Z");
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const ago = (ms: number) => new Date(NOW.getTime() - ms);

export const KEY = "0a1b2c3d".repeat(8);
export const OTHER_KEY = "f".repeat(64);
export const SHA_SENTINEL = "a1".repeat(20);
export const SHA_BACKEND = "b2".repeat(20);

export const SCHEDULE: LifecycleSnapshotDoc["schedule"] = [
  { job: "plan", cron: "0 6 * * 1", runner: "nebula", description: "plan", mutates: false },
  { job: "cve", cron: "30 5 * * *", runner: "nebula", description: "cve watch", mutates: false },
  { job: "source", cron: "0 7 2 * *", runner: "nebula", description: "source PRs + bundle", mutates: true },
  { job: "dispatch", cron: "*/5 * * * *", runner: "nebula", description: "on-demand requests", mutates: false },
  { job: "promote-prod", cron: "0 7 * * 2", runner: "github-actions", description: "prod promotion", mutates: true },
];

let seq = 0;
/** a snapshot row; `at` is both finishedAt and createdAt unless given */
export function snap(job: LifecycleSnapshotDoc["job"], at: Date, doc: Partial<LifecycleSnapshotDoc> = {}, row: Partial<Pick<SnapshotRow, "id" | "createdAt" | "ok">> = {}): SnapshotRow {
  seq += 1;
  const runId = doc.runId ?? `${job}-${seq}`;
  const ok = row.ok ?? doc.ok ?? true;
  const data: LifecycleSnapshotDoc = {
    schemaVersion: 1,
    job,
    runId,
    startedAt: new Date(at.getTime() - 60_000).toISOString(),
    finishedAt: at.toISOString(),
    schedule: SCHEDULE,
    discoveryErrors: [],
    ...doc,
    ok,
  };
  return { id: row.id ?? `snap${String(seq).padStart(4, "0")}`, job, runId, ok, startedAt: new Date(at.getTime() - 60_000), finishedAt: at, createdAt: row.createdAt ?? at, data };
}

export function pr(repo: string, number: number): LifecyclePrRef {
  return { repo, number, url: `https://github.com/${repo}/pull/${number}`, branch: `plo/2026-11/cs-${number}`, headSha: "c".repeat(40), title: `Upgrade #${number}` };
}

export function component(id: string, over: Partial<LifecycleComponent> = {}): LifecycleComponent {
  return {
    id,
    tier: "npm-direct",
    domain: "npm-dependency",
    name: id.split(":").pop() ?? id,
    target: "twizz-sentinel",
    environments: ["staging"],
    current: "1.0.0",
    desired: "1.1.0",
    latest: "2.0.0",
    bump: "minor",
    status: "outdated",
    autonomy: "pr",
    reasons: [],
    rollback: "supported",
    ...over,
  };
}

export function advisory(id: string, over: Partial<LifecycleAdvisory> = {}): LifecycleAdvisory {
  return { id, aliases: [], source: "osv", severity: "moderate", kev: false, summary: `${id} summary`, url: `https://osv.dev/vulnerability/${id}`, affected: [], ...over };
}

export function affects(componentId: string, over: Partial<LifecycleAdvisory["affected"][number]> = {}): LifecycleAdvisory["affected"][number] {
  return { componentId, name: componentId.split(":").pop() ?? componentId, tier: "npm-direct", target: "twizz-sentinel", version: "1.0.0", fixedIn: "1.0.1", environments: ["staging"], ...over };
}

export function bundle(github: string, headSha: string | null, over: Partial<LifecycleBundle> = {}): LifecycleBundle {
  return { repo: github.split("/")[1], github, baseBranch: "main", branch: "plo/bundle/2026-11", headSha, included: [pr(github, 7)], conflicts: [], environments: ["staging"], ...over };
}

let reqSeq = 0;
export function request(kind: string, over: Partial<RequestRow> = {}): RequestRow {
  reqSeq += 1;
  return { id: `req${String(reqSeq).padStart(5, "0")}`, kind, params: {}, requestedBy: "nick", status: "pending", createdAt: ago(10 * 60_000), claimedAt: null, finishedAt: null, runId: null, error: null, ...over };
}

/** where a preview smoke calls the sentinel env of the 2026-11 bundle: its Service inside the cluster (the
 * public preview host is behind the ingress SSO gate), and the fixed staging host a stg smoke calls */
export const PREVIEW_SVC = "http://twizz-sentinel.env-plo-2611-twizz-sentinel.svc.cluster.local:8090";
export const STG_ORIGIN = "https://sentinel-stg.prv.twizz.com";

export function smokeRequest(scope: "preview" | "stg", key: string, over: Partial<RequestRow> = {}): RequestRow {
  return request("smoke", { params: { scope, bundleKey: key, targets: [{ name: "twizz-sentinel", baseUrl: scope === "stg" ? STG_ORIGIN : PREVIEW_SVC }] }, ...over });
}

/** The result of `req` as plo-dispatch reports it: under the run id the request was answered with
 * (`req.runId`), one check per entry in `results`, each a check OF the request's first target. */
export function smokeSnap(req: RequestRow, scope: "preview" | "stg", key: string, results: Array<{ ok: boolean }>, at: Date = ago(5 * 60_000), doc: Partial<LifecycleSnapshotDoc> = {}): SnapshotRow {
  const target = (req.params as { targets?: Array<{ name: string; baseUrl: string }> }).targets?.[0] ?? { name: "x", baseUrl: "https://x.prv.twizz.com" };
  return snap("smoke", at, {
    ...(req.runId ? { runId: req.runId } : {}),
    requestId: req.id,
    smoke: { scope, bundleKey: key, results: results.map((r, i) => ({ name: `${target.name}/check-${i}`, url: `${target.baseUrl}/c${i}`, ok: r.ok, status: r.ok ? 200 : 503, ms: 40, detail: r.ok ? "ok" : "unexpected status" })) },
    ...doc,
  });
}

export function env(name: string, repo: string, sha: string, over: Partial<PreviewEnvInput> = {}): PreviewEnvInput {
  return {
    name,
    service: name.replace(/^plo-\d{4}-/, ""),
    owner: "nick",
    sourceRepo: repo,
    sourceRef: "plo/bundle/2026-11",
    sourceSha: sha,
    imageTag: `nb-${name}-${sha.slice(0, 12)}`,
    build: "ready",
    buildReason: null,
    argo: "PASS",
    // Argo reports the pods on this image, rolled out three hours ago; created by an operator
    runsImage: true,
    rolledOutAt: ago(3 * HOUR).toISOString(),
    port: 8090,
    trusted: true,
    expiresAt: new Date(NOW.getTime() + 48 * HOUR).toISOString(),
    url: `https://${name}.prv.twizz.com`,
    ...over,
  };
}
