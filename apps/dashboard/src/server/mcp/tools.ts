// The Nebula MCP toolset (docs/NEBULA.md §N7). Every tool is ONE of:
//   - a tRPC procedure called through appRouter.createCaller with the caller's
//     own session — so protected/operator/owner checks, the @twizz-idp/actions
//     gate (policy → nonce → AuditLog) and every server-side validation run
//     exactly as they do for the browser;
//   - an Observer log tool (@twizz-idp/observer) with an explicit scope on
//     EKS-Twizz-NonProd, EKS-Moly-staging or EKS-Moly-Prod (READS only);
//   - a GET on the twizz-sentinel read API (staging, or prod once reachable).
// Production: reads (logs, pods, nodes, overview, monitor, sentinel, capacity
// plans) for every bound person; the ONLY prod writes are capacity, and only for
// a Nebula operator whose binding also carries the scope (capacity:production):
// live resize to a NAMED template from gitops (never a custom size; #6 step
// limits, caps and the baseline floor apply; the nonce binds the plan hash) and
// the prod Atlas tier (allowlisted clusters, +2/−1, M10–M200). Releases only
// target staging. Tools a person may not use are not even registered for them
// (toolsFor), and every handler re-checks. The test pins all of this.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { NAME_RE, PROMOTABLE_NAMES, PROMOTABLE_TAG_RE, SERVICE_NAMES, IMAGE_TAG_RE, TTL_HOURS, isValidBranch, parseTwizzYaml, type GateResult } from "@twizz-idp/actions";
import { ENV_KEY_RE, SECRET_SHAPE_RE } from "@twizz-idp/shared";
import { fetchLogs, getGroupSamples, listPods, logHistogram, nodeMetrics, type ObserverCtx, type ObserverDeps, type ObserverScope, type ObserverTool } from "@twizz-idp/observer";
import type { appRouter } from "../routers/_app";
import { SENTINEL_TIERS, isObjectId, type SentinelGet } from "./sentinel";
import type { McpScope } from "./identity";
import { ATLAS_TIERS } from "@twizz-idp/shared";
import { PROD_ATLAS } from "@twizz-idp/actions";

export type AppCaller = ReturnType<typeof appRouter.createCaller>;

export type NebulaMcpDeps = {
  caller: AppCaller;
  login: string;
  observer: ObserverDeps;
  sentinel: SentinelGet;
  /** Per-login scratch for the Observer drill-down (last fetch_logs groups + scope). */
  notes: Record<string, unknown>;
  /** Nebula's own RBAC (NEBULA_OPERATORS), resolved server-side — never from the client. */
  operator: boolean;
  /** Per-person MCP grants from the identity binding. */
  scopes: McpScope[];
  /** One AuditLog row per tool call (reads included): full traceability. */
  audit?: (tool: string, args: Record<string, unknown>, ok: boolean, ms: number, error?: string, intentId?: string) => Promise<void>;
  /** Durable intent row written BEFORE a confirmed write runs; must throw if it can't be stored. */
  intent?: (tool: string, args: Record<string, unknown>, intentId: string) => Promise<void>;
};

/** What a tool-call audit row may carry: names and shapes, never values that could be secrets or file bodies. */
export function auditArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    if (k === "confirm") out[k] = v ? "(nonce)" : undefined;
    else if (k === "vars" || k === "envOverrides") out[k] = v && typeof v === "object" ? Object.keys(v as object) : v;
    else if (k === "files") out[k] = Array.isArray(v) ? v.map((x) => (x as { path?: string })?.path) : v;
    else if (k === "twizzYaml") out[k] = typeof v === "string" ? `(${v.length} chars)` : v;
    else out[k] = typeof v === "string" && v.length > 300 ? `${v.slice(0, 300)}…` : v;
  }
  return out;
}

/** Clusters the READ tools may look at. Writes never take a cluster. */
export const MCP_CLUSTERS = ["EKS-Twizz-NonProd", "EKS-Moly-staging", "EKS-Moly-Prod"] as const;

export const MCP_READ_TOOLS = [
  "nebula_whoami",
  "list_envs",
  "list_projects",
  "list_repos",
  "list_branches",
  "branch_head",
  "repo_config",
  "release_train",
  "release_images",
  "cluster_overview",
  "list_pods",
  "log_histogram",
  "fetch_logs",
  "get_group_samples",
  "node_metrics",
  "monitor",
  "list_ci_runs",
  "ci_run",
  "ci_job_logs",
  "sentinel_status",
  "sentinel_alerts",
  "sentinel_alert",
  "sentinel_alert_stats",
  "sentinel_events",
  "capacity_presets",
  "capacity_tier",
  "capacity_plan",
  "prod_atlas_plan",
  "capacity_estimate",
  "traffic_peaks",
  "traffic_window",
  "capacity_cases",
  "capacity_verify",
  "event_watch",
] as const;

/** Any bound person (Nebula then applies owner-or-operator per env). */
export const MCP_SELF_SERVICE_WRITES = ["create_env_from_repo", "rebuild_env", "set_env_vars", "extend_env", "teardown_env"] as const;
/** Nebula operators only. */
export const MCP_OPERATOR_WRITES = ["create_named_env", "clone_staging_db", "promote_release", "merge_promotion"] as const;
/** Operator-only READS (other people's audited activity). */
export const MCP_OPERATOR_READS = ["recent_changes"] as const;
/** Operators whose binding carries the matching capacity scope. */
export const MCP_CAPACITY_WRITES = ["apply_live_capacity", "set_prod_atlas_tier"] as const;

export const MCP_WRITE_TOOLS = [...MCP_SELF_SERVICE_WRITES, ...MCP_OPERATOR_WRITES, ...MCP_CAPACITY_WRITES] as const;
export const MCP_TOOL_NAMES = [...MCP_READ_TOOLS, ...MCP_OPERATOR_READS, ...MCP_WRITE_TOOLS] as const;
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

/** Live tiers a person may resize through MCP: operator AND capacity:<tier>. */
export function liveTiersFor(who: { operator: boolean; scopes: readonly string[] }): Array<"production" | "staging"> {
  if (!who.operator) return [];
  return (["production", "staging"] as const).filter((t) => who.scopes.includes(`capacity:${t}`));
}

/** The tools this person gets — anything else is not even listed. */
export function toolsFor(who: { operator: boolean; scopes: readonly string[] }): McpToolName[] {
  const out: McpToolName[] = [...MCP_READ_TOOLS, ...MCP_SELF_SERVICE_WRITES];
  if (who.operator) out.push(...MCP_OPERATOR_READS, ...MCP_OPERATOR_WRITES);
  if (liveTiersFor(who).length) out.push("apply_live_capacity");
  if (who.operator && who.scopes.includes("capacity:production")) out.push("set_prod_atlas_tier");
  return out;
}

const RESULT_CHARS = 40_000;

type Content = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const text = (s: string, isError = false): Content => ({ content: [{ type: "text", text: s.length > RESULT_CHARS ? `${s.slice(0, RESULT_CHARS)}\n… (truncated at ${RESULT_CHARS} chars; narrow the query)` : s }], ...(isError ? { isError: true } : {}) });
const json = (v: unknown): Content => text(JSON.stringify(v, null, 2));

export function errorText(e: unknown): string {
  if (e instanceof TRPCError) return `${e.code}: ${e.message}`;
  const issues = (e as { issues?: Array<{ path: unknown[]; message: string }> })?.issues;
  if (Array.isArray(issues)) return `invalid input: ${issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")}`;
  return String((e as Error)?.message ?? e);
}

async function run(fn: () => Promise<Content>): Promise<Content> {
  try {
    return await fn();
  } catch (e) {
    return text(errorText(e), true);
  }
}

/** Gate results, phrased for an agent: the two-step confirm is the human's. */
export function gateText(r: GateResult): Content {
  if ("confirmationRequired" in r) {
    return text(
      [
        "CONFIRMATION REQUIRED — nothing has happened yet.",
        "",
        r.summary,
        "",
        `Show this summary to the user verbatim and ask for an explicit yes. Only if they approve, call this tool again with EXACTLY the same arguments plus confirm="${r.confirm}" (single-use, bound to these arguments, expires).`,
      ].join("\n"),
    );
  }
  if ("denied" in r) return text(`DENIED by policy: ${r.reason}`, true);
  if ("error" in r) return text(`FAILED: ${r.error}`, true);
  return json({ done: true, result: r.result });
}

// ── shared schemas ─────────────────────────────────────────────────────
const confirm = z.string().min(8).max(64).optional().describe("The nonce from the previous call's CONFIRMATION REQUIRED reply. Omit on the first call. Never invent one.");
const envName = z.string().regex(NAME_RE).describe("Named env (DNS label ^[a-z][a-z0-9-]{2,23}$) — its URL is https://<name>.prv.twizz.com");
const ttlHours = z.number().int().min(TTL_HOURS.min).max(TTL_HOURS.max).optional().describe(`Hours until the reaper tears it down (default ${TTL_HOURS.default})`);
const repo = z.string().max(200).describe("twizz-app/<repo>");
const sha = z.string().regex(/^[0-9a-f]{40}$/).describe("40-hex commit sha");
const branch = z.string().max(120).refine(isValidBranch, "invalid git branch name");
const envKey = z.string().regex(ENV_KEY_RE, "UPPER_SNAKE_CASE");
const cluster = z.enum(MCP_CLUSTERS).describe("EKS-Twizz-NonProd (previews, named envs, Nebula), EKS-Moly-staging (staging in ns default, dev in ns dev, twizz-sentinel in ns sentinel) or EKS-Moly-Prod (production, ns default + jobs; read-only).");
const k8sName = z.string().min(1).max(63).regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, "kubernetes namespace");
const scopeShape = {
  cluster,
  namespace: k8sName.describe("Namespace, e.g. env-<name> for a named env, pr-<n>-<service> for a PR preview, default for staging/prod"),
  pod: z.string().max(253).optional().describe("Pod name or prefix to narrow to"),
  minutesBack: z.number().int().min(5).max(1440).optional().describe("Trailing window in minutes (default 60, max 1440)"),
  from: z.string().datetime().optional().describe("Window start (ISO); with `to` it overrides minutesBack"),
  to: z.string().datetime().optional().describe("Window end (ISO)"),
};
const CI_OWNERS: Array<[string, string | null]> = [["twizz-app", null], ["MymTwo", null], ["TwizzyNicky", "twizz-gitops"], ["xenosnikos", "First-IDP"]];
const ciRepo = { owner: z.string().max(40), repo: z.string().max(100) };
function assertCiRepo(owner: string, repoName: string) {
  const ok = CI_OWNERS.some(([o, r]) => o.toLowerCase() === owner.toLowerCase() && (r === null || r.toLowerCase() === repoName.toLowerCase()));
  if (!ok) throw new TRPCError({ code: "FORBIDDEN", message: `CI reads are limited to twizz-app/*, MymTwo/*, TwizzyNicky/twizz-gitops and xenosnikos/First-IDP (the Nebula builder)` });
}

export function scopeOf(a: { cluster: string; namespace: string; pod?: string; minutesBack?: number; from?: string; to?: string }, now = Date.now()): ObserverScope {
  let end = a.to ? Math.min(Date.parse(a.to), now) : now;
  let start = a.from ? Date.parse(a.from) : end - (a.minutesBack ?? 60) * 60_000;
  if (!(end > start)) end = start + 60_000;
  if (end - start > 24 * 3600_000) start = end - 24 * 3600_000;
  return { cluster: a.cluster, namespace: a.namespace, pod: a.pod || undefined, from: new Date(start).toISOString(), to: new Date(end).toISOString() };
}

async function observe(d: NebulaMcpDeps, tool: ObserverTool, scope: ObserverScope, input: unknown): Promise<Content> {
  const parsed = tool.input.safeParse(input);
  if (!parsed.success) return text(`invalid input: ${parsed.error.message}`, true);
  const ctx: ObserverCtx = { scope, deps: d.observer, notes: d.notes, redactions: {} };
  const out = await tool.run(parsed.data, ctx);
  d.notes.lastScope = scope;
  const red = Object.entries(ctx.redactions).filter(([, n]) => n > 0);
  return text(`scope: ${scope.cluster} ns=${scope.namespace}${scope.pod ? ` pod=${scope.pod}` : ""} ${scope.from} → ${scope.to}\n${out}${red.length ? `\n(redacted: ${red.map(([k, n]) => `${k}×${n}`).join(", ")})` : ""}`);
}

const RO = { readOnlyHint: true, openWorldHint: true } as const;
const W = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;

export function registerNebulaTools(server: McpServer, d: NebulaMcpDeps): void {
  const c = d.caller;
  const allowed = new Set<string>(toolsFor(d));
  const reg = <S extends z.ZodRawShape>(name: McpToolName, description: string, shape: S, annotations: Record<string, boolean>, handler: (a: z.objectOutputType<S, z.ZodTypeAny>) => Promise<Content>) =>
    allowed.has(name) &&
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    server.registerTool(name, { description, inputSchema: shape, annotations } as any, (async (a: z.objectOutputType<S, z.ZodTypeAny>) => {
      const t0 = Date.now();
      const args = auditArgs(a as Record<string, unknown>);
      // a confirmed write (the call that executes) needs a durable intent row FIRST:
      // if the audit store can't take it, nothing runs (Codex review)
      let intentId: string | undefined;
      if ((MCP_WRITE_TOOLS as readonly string[]).includes(name) && (a as { confirm?: unknown }).confirm) {
        intentId = randomUUID();
        try {
          if (!d.intent) throw new Error("no intent recorder");
          await d.intent(name, args, intentId);
        } catch (e) {
          return text(`REFUSED: the audit store is unavailable, so this write was not attempted (${String((e as Error)?.message ?? e).slice(0, 120)}). Try again later.`, true);
        }
      }
      const out = await run(() => handler(a));
      await d.audit?.(name, args, !out.isError, Date.now() - t0, out.isError ? out.content[0]?.text.slice(0, 300) : undefined, intentId).catch(() => {});
      return out;
    }) as any);

  // ── who / what ───────────────────────────────────────────────────────
  reg("nebula_whoami", "Who Nebula thinks you are: GitHub login and whether you are an operator (operators may create release-image envs, clone the staging db, and promote to staging). Call this first.", {}, RO, async () => json(await c.actions.me()));

  reg("list_envs", "All named environments on EKS-Twizz-NonProd (ready + pending builds + broken manifests) with URL, owner, TTL, source repo/branch/sha, and live Argo CD health.", {}, RO, async () => json(await c.actions.listEnvs()));

  reg("list_projects", "twizz-app repos joined with what runs for them in-cluster (gitops apps, previews, ingresses) and the Nebula service registry.", {}, RO, async () => json(await c.nebula.listProjects()));

  reg("list_repos", "twizz-app GitHub repos visible to you (name, default branch, language).", { q: z.string().max(100).optional().describe("substring filter"), limit: z.number().int().min(1).max(500).optional() }, RO, async (a) =>
    json(await c.project.listGithubRepos({ q: a.q, limit: a.limit ?? 100 })),
  );

  reg("list_branches", "Branches of a twizz-app repo.", { repo, q: z.string().max(120).optional(), limit: z.number().int().min(1).max(500).optional() }, RO, async (a) =>
    json(await c.project.listBranches({ repo: a.repo, q: a.q, limit: a.limit ?? 100 })),
  );

  reg("branch_head", "Current head commit of a branch (pin this sha for create_env_from_repo).", { repo, branch: z.string().max(120) }, RO, async (a) => json(await c.project.getBranchHead({ repo: a.repo, branch: a.branch })));

  reg("repo_config", "The repo's twizz.yaml at a commit (raw + parsed/validated) and whether its Dockerfile exists. Needed before create_env_from_repo.", { repo, sha }, RO, async (a) => json(await c.project.repoConfig({ repo: a.repo, sha: a.sha })));

  // ── release train (staging only) ─────────────────────────────────────
  reg("release_train", "Release train to STAGING: per promotable service the immutable ECR candidates, what staging runs now, Argo health of the staging app, and open promotion PRs on twizz-gitops.", {}, RO, async () => json(await c.actions.listReleaseTrain()));

  reg("release_images", "Immutable release images (ECR build-* tags) usable by create_named_env.", { service: z.enum(SERVICE_NAMES as [string, ...string[]]).optional(), limit: z.number().int().min(1).max(50).optional() }, RO, async (a) =>
    json(await c.actions.listReleaseImages({ service: (a.service ?? "moly-backend") as never, limit: a.limit ?? 20 })),
  );

  // ── clusters + logs (NonProd + staging; Observer tools) ──────────────
  reg("cluster_overview", "Pods per namespace with status/restarts on EKS-Twizz-NonProd, EKS-Moly-staging and EKS-Moly-Prod (CloudWatch Container Insights, last 5 min; read-only).", { cluster: cluster.optional() }, RO, async (a) => {
    const all = await c.clusters.overview();
    const allowed = new Set<string>(a.cluster ? [a.cluster] : MCP_CLUSTERS);
    return json({ readAt: all.readAt, clusters: all.clusters.filter((x) => allowed.has(x.name)) });
  });

  reg("list_pods", "Live pods in one namespace (status, restarts, node).", { cluster, namespace: scopeShape.namespace, pod: scopeShape.pod }, RO, async (a) => observe(d, listPods, scopeOf(a), {}));

  reg("log_histogram", "Log line counts per time bin for a namespace (optionally a pod / regex filter). Cheap: use it first to find bursts, then fetch_logs on the burst.", { ...scopeShape, filter: z.string().max(200).optional(), binMinutes: z.union([z.literal(5), z.literal(15), z.literal(60)]).optional() }, RO, async (a) =>
    observe(d, logHistogram, scopeOf(a), { pod: a.pod, filter: a.filter, binMinutes: a.binMinutes }),
  );

  reg(
    "fetch_logs",
    "Newest log lines for a namespace (optionally one pod), grouped by signature [LEVEL ×count first→last pods] with a redacted sample — the Observer's diagnosis view. Narrow with filter (regex), errorsOnly, offsets. A TIMEOUT is not 'no logs'.",
    { ...scopeShape, filter: z.string().max(200).optional(), errorsOnly: z.boolean().optional(), limit: z.number().int().min(50).max(1000).optional() },
    RO,
    async (a) => observe(d, fetchLogs, scopeOf(a), { pod: a.pod, filter: a.filter, errorsOnly: a.errorsOnly, limit: a.limit }),
  );

  reg("get_group_samples", "Raw (redacted) lines around the first/last occurrence of one group from YOUR last fetch_logs (same scope). Use to see one failure mode in context.", { signature: z.string().max(200), n: z.number().int().min(1).max(20).optional(), around: z.enum(["first", "last"]).optional() }, RO, async (a) => {
    const scope = d.notes.lastScope as ObserverScope | undefined;
    if (!scope) return text("call fetch_logs first; get_group_samples drills into its groups", true);
    return observe(d, getGroupSamples, scope, a);
  });

  reg("node_metrics", "Node CPU/memory utilisation and pod counts for a cluster (last 5 min).", { cluster }, RO, async (a) => observe(d, nodeMetrics, scopeOf({ cluster: a.cluster, namespace: "default" }), {}));

  reg("monitor", "Production or staging monitor (traffic, CPU/memory, pods, node headroom, Atlas) with OK/WATCH/HOT verdicts. Read-only.", { tier: z.enum(["production", "staging"]), window: z.enum(["15m", "1h", "6h", "24h"]).optional() }, RO, async (a) =>
    json(await c.monitor.snapshot({ tier: a.tier, window: a.window ?? "1h" })),
  );

  // ── CI (GitHub Actions) ──────────────────────────────────────────────
  reg("list_ci_runs", "Recent GitHub Actions runs across the registered Nebula projects.", { limit: z.number().int().min(1).max(50).optional() }, RO, async (a) => json(await c.pipeline.listGithubRuns({ limit: a.limit ?? 20 })));

  reg("ci_run", "One GitHub Actions run with its jobs/steps. Named-env builds run in xenosnikos/First-IDP (nebula-build.yml).", { ...ciRepo, runId: z.number().int() }, RO, async (a) => {
    assertCiRepo(a.owner, a.repo);
    return json(await c.pipeline.getGithubRun({ owner: a.owner, repo: a.repo, runId: a.runId }));
  });

  reg("ci_job_logs", "Logs of one GitHub Actions job (tail, ~40k chars).", { ...ciRepo, jobId: z.number().int() }, RO, async (a) => {
    assertCiRepo(a.owner, a.repo);
    const { logs } = await c.pipeline.getGithubJobLogs({ owner: a.owner, repo: a.repo, jobId: a.jobId });
    const s = typeof logs === "string" ? logs : JSON.stringify(logs);
    return text(s.length > RESULT_CHARS ? `… (head cut; last ${RESULT_CHARS} chars)\n${s.slice(-RESULT_CHARS)}` : s);
  });

  // ── twizz-sentinel (read key only; staging, or prod once reachable) ──
  const sg = d.sentinel;
  const tier = z.enum(SENTINEL_TIERS).optional().describe("staging (default) or production");
  reg("sentinel_status", "twizz-sentinel health: detectors/triage/actions flags, ingest + pipeline stats, triage budget.", { tier }, RO, async (a) => json(await sg(a.tier ?? "staging", "status", {}, d.login)));

  reg(
    "sentinel_alerts",
    "twizz-sentinel security/fraud alerts, newest first.",
    {
      tier,
      status: z.string().max(80).optional().describe("comma list, e.g. open,triaged"),
      severity: z.string().max(80).optional().describe("comma list, e.g. high,critical"),
      category: z.string().max(60).optional(),
      entityId: z.string().max(100).optional(),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
      page: z.number().int().min(1).max(1000).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    RO,
    async ({ tier: t, ...a }) => json(await sg(t ?? "staging", "alerts", { ...a, limit: a.limit ?? 25 }, d.login)),
  );

  reg("sentinel_alert", "One sentinel alert, optionally with the cases it belongs to or similar past alerts.", { tier, id: z.string().refine(isObjectId, "24-hex alert id"), include: z.enum(["cases", "similar"]).optional() }, RO, async (a) =>
    json(await sg(a.tier ?? "staging", a.include ? (`alerts/${a.id}/${a.include}` as const) : (`alerts/${a.id}` as const), {}, d.login)),
  );

  reg("sentinel_alert_stats", "Sentinel alert counts by severity/category/status over N days.", { tier, days: z.number().int().min(1).max(90).optional() }, RO, async (a) => json(await sg(a.tier ?? "staging", "alerts/stats", { days: a.days ?? 7 }, d.login)));

  reg(
    "sentinel_events",
    "Sentinel raw security events (login, payment, …) filtered by user/ip/device/type/time.",
    {
      tier,
      userId: z.string().refine(isObjectId, "24-hex user id").optional(),
      ip: z.string().max(45).optional(),
      deviceId: z.string().max(120).optional(),
      type: z.string().max(200).optional().describe("comma list of event types"),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
      page: z.number().int().min(1).max(1000).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    RO,
    async ({ tier: t, ...a }) => json(await sg(t ?? "staging", "events", { ...a, limit: a.limit ?? 25 }, d.login)),
  );

  // ── capacity (§N5): reads for everyone bound; writes = operator + scope ──
  const liveTiers = liveTiersFor(d);
  const presetName = z.string().regex(/^[a-z][a-z0-9-]{1,23}$/).describe("A named template from twizz-gitops capacity/presets.yaml (capacity_presets); custom sizes are UI-only");
  const atlasTier = z.enum(ATLAS_TIERS as unknown as [string, ...string[]]);

  reg("capacity_presets", "Capacity templates (twizz-gitops capacity/presets.yaml): name, title, description and which tiers each sizes. Production templates: baseline / campaign / max.", {}, RO, async () => {
    const o = await c.capacity.overview();
    return json({
      presets: o.presets.map((p) => ({ name: p.name, title: p.title, description: p.description, tiers: Object.keys(p.tiers) })),
      presetsError: o.presetsError,
      openCapacityPrs: o.prs,
    });
  });

  reg("capacity_tier", "What a tier runs now: for staging/production the LIVE cluster state (replicas, HPAs, resources, node groups), caps, the paired-service advisory, and the Atlas tier.", { tier: z.enum(["preview", "staging", "production"]) }, RO, async (a) =>
    json(await c.capacity.tier({ tier: a.tier })),
  );

  reg(
    "capacity_plan",
    "Plan moving a tier to a named template, against a FRESH read of the cluster: the ordered live ops, violations, warnings, cost, and the planHash that apply_live_capacity needs. Read-only.",
    { tier: z.enum(["preview", "staging", "production"]), preset: presetName },
    RO,
    async (a) => {
      const { exportYaml: _x, ...plan } = (await c.capacity.plan({ tier: a.tier, preset: a.preset })) as Record<string, unknown>;
      return json(plan);
    },
  );

  reg(
    "prod_atlas_plan",
    `What resizing ONE prod Atlas cluster would do (${PROD_ATLAS.clusters.join(" / ")}): from → to, changes, cost, warnings, violations. Read-only.`,
    { cluster: z.enum(PROD_ATLAS.clusters), instanceSize: atlasTier, autoScaling: z.object({ min: atlasTier, max: atlasTier }).optional() },
    RO,
    async (a) => json(await c.capacity.prodAtlasPlan({ cluster: a.cluster, size: { instanceSize: a.instanceSize, ...(a.autoScaling ? { autoScaling: a.autoScaling } : {}) } as never })),
  );

  // ── traffic-driven sizing (§N5.4): reads for everyone bound ──
  const liveTier = z.enum(["production", "staging"]);
  const estimateShape = {
    rps: z.number().min(1).max(100_000).describe("Expected PEAK edge requests/s (last night's burst: ~2,330)"),
    peakFactor: z.number().min(1).max(20).optional().describe("Multiplier if rps is a typical level, not the peak (default 1)"),
    headroom: z.number().min(1).max(3).optional().describe("Safety margin over the peak (default 1.2)"),
  };

  reg(
    "capacity_estimate",
    "Size a live tier for an expected PEAK traffic: pods per workload and node-group min/desired/max from the profile calibrated on real events, floored by `baseline`, within caps. Returns the per-step arithmetic, warnings, the plan against the live cluster (ops + planHash for apply_live_capacity), and how what runs NOW, the estimate and every named template would fare at that load (OK / WATCH / SATURATED). Read-only.",
    { tier: liveTier, ...estimateShape },
    RO,
    async (a) => json(await c.capacity.estimateLive({ tier: a.tier, rps: a.rps, peakFactor: a.peakFactor ?? 1, headroom: a.headroom ?? 1.2 })),
  );

  reg(
    "traffic_peaks",
    "Sudden traffic ramps in the last 1–14 days (per-minute edge req/s): start, peak, baseline, ratio, ramp minutes, duration, p95 before/max, 5xx. Use it to find events like the 2026-11-05 00:17 burst and how often they happen. Read-only.",
    { tier: liveTier, days: z.number().int().min(1).max(14).optional() },
    RO,
    async (a) => json(await c.capacity.trafficPeaks({ tier: a.tier, days: a.days ?? 7 })),
  );

  reg(
    "traffic_window",
    "One event minute by minute (≤3 h): req/s, p95, 5xx, and — within the last day only — pods and CPU per modelled workload and node CPU. Use after traffic_peaks to see what saturated. Read-only.",
    { tier: liveTier, from: z.string().datetime(), to: z.string().datetime() },
    RO,
    async (a) => json(await c.capacity.trafficWindow({ tier: a.tier, from: a.from, to: a.to })),
  );

  reg(
    "capacity_cases",
    "The library of past capacity events (twizz-gitops capacity/cases.yaml): what traffic came, what ran, what happened, what to do next time — each replayed against today's profile (what ran vs its peak; the recommended template). Start every capacity plan here. Read-only.",
    { tier: liveTier.optional() },
    RO,
    async (a) => json(await c.capacity.cases(a.tier ? { tier: a.tier } : undefined)),
  );

  reg(
    "capacity_verify",
    "Rollout validation after apply_live_capacity: is the live cluster at the target of a template (preset) or estimate (estimateRps) — spec, ready pods, joined nodes — READY / PROGRESSING / MISMATCH, plus how what runs holds at the load of the last 10 minutes. Re-run until READY before the event starts. Read-only.",
    { tier: liveTier, preset: presetName.optional(), estimateRps: estimateShape.rps.optional(), peakFactor: estimateShape.peakFactor, headroom: estimateShape.headroom },
    RO,
    async (a) => {
      if ((a.preset === undefined) === (a.estimateRps === undefined)) throw new TRPCError({ code: "BAD_REQUEST", message: "give exactly one of preset or estimateRps (what you applied)" });
      const by = a.estimateRps !== undefined ? { estimate: { rps: a.estimateRps, peakFactor: a.peakFactor ?? 1, headroom: a.headroom ?? 1.2 } } : { preset: a.preset };
      return json(await c.capacity.verify({ tier: a.tier, ...by }));
    },
  );

  reg(
    "event_watch",
    "Live watch during an event or an incident: the last 5–60 minutes (req/s, p95, 5xx, pods/CPU, nodes), the monitor's signals, and OK / WATCH / ACT with the reasons and — when capacity is short — the smallest template that holds the current peak + 30%. Call it every few minutes during a marketing push. Read-only; acting is apply_live_capacity.",
    { tier: liveTier, minutes: z.number().int().min(5).max(60).optional() },
    RO,
    async (a) => {
      const r = (await c.capacity.watch({ tier: a.tier, minutes: a.minutes ?? 15 })) as Record<string, unknown>;
      return json({ ...r, minutes: undefined, lastMinutes: Array.isArray(r.minutes) ? (r.minutes as unknown[]).slice(-10) : [] });
    },
  );

  reg(
    "recent_changes",
    "OPERATORS: what changed in a window (≤7 days): Nebula's audited writes (capacity applies, promotions, env changes, with who and the summary) and image pushes of the prod services (prod deploys happen outside Nebula: CodeBuild → ECR → rollout). The first question of any outage. Read-only.",
    { from: z.string().datetime(), to: z.string().datetime().optional() },
    RO,
    async (a) => json(await c.capacity.recentChanges({ from: a.from, ...(a.to ? { to: a.to } : {}) })),
  );

  const needScope = (scope: McpScope) => {
    if (!d.operator || !d.scopes.includes(scope)) throw new TRPCError({ code: "FORBIDDEN", message: `needs a Nebula operator with the ${scope} MCP scope` });
  };

  if (liveTiers.length) {
    reg(
      "apply_live_capacity",
      [
        `OPERATORS with capacity:<tier>: resize ${liveTiers.join("/")} ON THE CLUSTER to a NAMED template (prod: baseline / campaign / max) OR to a traffic estimate (estimateRps: computed server-side from the calibrated profile, floored by baseline). Exactly one of preset / estimateRps. No custom sizes here.`,
        "Steps: capacity_plan {tier, preset} or capacity_estimate {tier, rps} → review ops/violations/warnings → call this with the SAME preset or estimate and the plan's planHash (no confirm) → show the CONFIRMATION summary verbatim → only after an explicit yes, call again with confirm.",
        "Refused if the cluster moved since the plan (planHash), if any step exceeds ×3/×0.5, a cap, or the baseline floor. Stops at the first failure. Every attempt is audited.",
      ].join(" "),
      {
        tier: z.enum(liveTiers as [string, ...string[]]),
        preset: presetName.optional(),
        estimateRps: estimateShape.rps.optional(),
        peakFactor: estimateShape.peakFactor,
        headroom: estimateShape.headroom,
        planHash: z.string().regex(/^[0-9a-f]{64}$/),
        confirm,
      },
      { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      async (a) => {
        needScope(`capacity:${a.tier}` as McpScope);
        if ((a.preset === undefined) === (a.estimateRps === undefined)) throw new TRPCError({ code: "BAD_REQUEST", message: "give exactly one of preset or estimateRps" });
        const by = a.estimateRps !== undefined ? { estimate: { rps: a.estimateRps, peakFactor: a.peakFactor ?? 1, headroom: a.headroom ?? 1.2 } } : { preset: a.preset };
        return gateText(await c.actions.applyLiveCapacity({ tier: a.tier as "production" | "staging", ...by, planHash: a.planHash, confirm: a.confirm }));
      },
    );
  }

  reg(
    "set_prod_atlas_tier",
    `OPERATORS with capacity:production: resize ONE prod Atlas cluster (${PROD_ATLAS.clusters.join(" / ")}) within ${PROD_ATLAS.floor}–${PROD_ATLAS.cap}, at most +${PROD_ATLAS.maxStepUp}/−${PROD_ATLAS.maxStepDown} tier per apply. Steps: prod_atlas_plan → this with from = the plan's "from" (no confirm) → show the summary verbatim → explicit yes → again with confirm. Refused if the cluster changed since review.`,
    { cluster: z.enum(PROD_ATLAS.clusters), instanceSize: atlasTier, autoScaling: z.object({ min: atlasTier, max: atlasTier }).optional(), from: z.string().max(40), confirm },
    { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    async (a) => {
      needScope("capacity:production");
      return gateText(await c.actions.setProdAtlasTier({ cluster: a.cluster, size: { instanceSize: a.instanceSize, ...(a.autoScaling ? { autoScaling: a.autoScaling } : {}) } as never, from: a.from, confirm: a.confirm }));
    },
  );

  // ── writes: all through the gate (two-step confirm) ──────────────────
  reg(
    "create_env_from_repo",
    [
      "Spin up a preview env on EKS-Twizz-NonProd from any twizz-app repo/branch (self-service). Backends and frontends both land on https://<name>.prv.twizz.com; a frontend must attach to a backend (a named env or an https://*.twizz.com origin).",
      "Steps: branch_head → repo_config (reuse its twizz.yaml, or write one) → call this WITHOUT confirm → show the summary → call again with confirm.",
      "Secret VALUES are never accepted through MCP: declared secrets are created blank; the owner fills them in Nebula (or set_env_vars for non-credential values).",
    ].join(" "),
    {
      name: envName,
      repo,
      ref: branch.describe("Branch to build (existing, or the new one when newBranchFrom is set)"),
      sha: sha.describe("Head of ref (or of newBranchFrom) as returned by branch_head"),
      newBranchFrom: branch.optional().describe("Create `ref` off this branch first"),
      defaultBranch: branch.optional(),
      db: z.enum(["isolated", "clone", "none"]).optional().describe("isolated = fresh db; clone = copy of staging (moly-backend only)"),
      ttlHours,
      attachEnv: envName.optional().describe("Frontend: the named backend env to call"),
      attachUrl: z.string().url().max(300).optional().describe("Frontend: an https://<host>.twizz.com API origin instead"),
      files: z.array(z.object({ path: z.string().min(1).max(200), content: z.string().max(64 * 1024) })).max(2).optional().describe("twizz.yaml (+ Dockerfile) to commit via a config PR; omit if the branch already has them"),
      twizzYaml: z.string().min(1).max(64 * 1024),
      secretNames: z.array(envKey).max(50).optional(),
      envOverrides: z.record(envKey, z.string().max(8000)).optional().describe("Non-secret env vars"),
      prTarget: z.enum(["chosen", "chosen+default"]).optional(),
      confirm,
    },
    W,
    async (a) => {
      for (const [k, v] of Object.entries(a.envOverrides ?? {})) if (SECRET_SHAPE_RE.test(v)) throw new TRPCError({ code: "BAD_REQUEST", message: `${k} looks like a credential; declare it in secretNames and set it in Nebula` });
      // on confirm, every declared secret goes in blank ("set later") — values never transit MCP
      let secretValues: Record<string, string> | undefined;
      if (a.confirm) {
        const parsed = parseTwizzYaml(a.twizzYaml);
        const names = [...new Set([...(parsed.ok ? parsed.config.secrets : []), ...(a.secretNames ?? [])])];
        secretValues = Object.fromEntries(names.map((n) => [n, ""]));
      }
      const attach = a.attachEnv ? { env: a.attachEnv } : a.attachUrl ? { url: a.attachUrl } : undefined;
      return gateText(
        await c.actions.createEnvFromRepo({
          name: a.name,
          repo: a.repo,
          ref: a.ref,
          sha: a.sha,
          newBranch: a.newBranchFrom ? { from: a.newBranchFrom } : undefined,
          defaultBranch: a.defaultBranch,
          db: a.db ?? "none",
          ttlHours: a.ttlHours ?? TTL_HOURS.default,
          attach,
          files: a.files ?? [],
          twizzYaml: a.twizzYaml,
          secretNames: a.secretNames ?? [],
          secretValues,
          envOverrides: a.envOverrides ?? {},
          prTarget: a.prTarget ?? "chosen",
          confirm: a.confirm,
        }),
      );
    },
  );

  reg(
    "create_named_env",
    "OPERATORS: create a named env from an existing immutable release image (release_images), db isolated or cloned from staging.",
    {
      name: envName,
      service: z.enum(SERVICE_NAMES as [string, ...string[]]),
      imageTag: z.string().regex(IMAGE_TAG_RE),
      db: z.enum(["isolated", "clone"]),
      ttlHours,
      frontendOrigins: z.array(z.string().url()).max(10).optional(),
      confirm,
    },
    W,
    async (a) => gateText(await c.actions.createNamedEnv({ ...a, service: a.service as never, ttlHours: a.ttlHours ?? TTL_HOURS.default })),
  );

  reg("clone_staging_db", "OPERATORS: re-clone the staging database into a named env's db (overwrites that env's data).", { name: envName, confirm }, { ...W, destructiveHint: true }, async (a) => gateText(await c.actions.cloneStagingDb(a)));

  reg("rebuild_env", "Owner or operator: rebuild a Nebula-built env from the CURRENT head of its source branch.", { name: envName, confirm }, W, async (a) => gateText(await c.actions.rebuildFromRef(a)));

  reg(
    "set_env_vars",
    "Owner or operator: set (or delete with \"\") runtime env vars on a named env; pods roll. Credentials are refused here — set secrets in Nebula so they never pass through the agent.",
    { name: envName, vars: z.record(envKey, z.string().max(8000)), confirm },
    W,
    async (a) => {
      const n = Object.keys(a.vars).length;
      if (n < 1 || n > 50) throw new TRPCError({ code: "BAD_REQUEST", message: "1..50 vars" });
      for (const [k, v] of Object.entries(a.vars)) if (SECRET_SHAPE_RE.test(v)) throw new TRPCError({ code: "BAD_REQUEST", message: `${k} looks like a credential; set it in Nebula, not through MCP` });
      return gateText(await c.actions.setEnvVars(a));
    },
  );

  reg("extend_env", "Owner or operator: push a named env's expiry to now + ttlHours.", { name: envName, ttlHours, confirm }, W, async (a) => gateText(await c.actions.extendNamedEnv({ ...a, ttlHours: a.ttlHours ?? TTL_HOURS.default })));

  reg("teardown_env", "Owner or operator: tear down a named env (manifest, values, secret; app pruned, db dropped).", { name: envName, confirm }, { ...W, destructiveHint: true }, async (a) => gateText(await c.actions.teardownNamedEnv(a)));

  // ── guided prompt: plan capacity for a traffic event, learning from past cases ──
  server.registerPrompt(
    "plan_capacity_for_traffic",
    {
      title: "Plan capacity for a traffic event",
      description: "Size staging/production ahead of expected traffic, using past events (like the 2026-11-05 midnight burst) as the reference.",
      argsSchema: {
        tier: z.enum(["production", "staging"]).optional().describe("default production"),
        expectedPeakRps: z.string().max(12).optional().describe("expected PEAK req/s, if known"),
        when: z.string().max(80).optional().describe("when the event starts (e.g. 'tonight 00:00 EET')"),
        event: z.string().max(200).optional().describe("what it is (campaign push, drop, live show…)"),
      },
    },
    (args) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: PLAN_CAPACITY_PROMPT({ tier: args.tier ?? "production", peak: args.expectedPeakRps, when: args.when, event: args.event }),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "prepare_marketing_event",
    {
      title: "Prepare for a marketing event",
      description: "End to end: size from past cases and the expected peak, apply ahead, validate the rollout, watch during, step back after.",
      argsSchema: {
        tier: z.enum(["production", "staging"]).optional(),
        event: z.string().max(200).optional().describe("what it is"),
        when: z.string().max(80).optional().describe("start time, e.g. 'Friday 20:00 EET'"),
        expectedPeakRps: z.string().max(12).optional(),
        durationMinutes: z.string().max(6).optional(),
      },
    },
    (a) => ({ messages: [{ role: "user", content: { type: "text", text: PREPARE_EVENT_PROMPT({ tier: a.tier ?? "production", event: a.event, when: a.when, peak: a.expectedPeakRps, duration: a.durationMinutes }) } }] }),
  );

  server.registerPrompt(
    "diagnose_outage",
    {
      title: "Diagnose an infra outage or slowdown",
      description: "Grounded triage: what the users saw, what changed, where it saturated or failed, and the remediation options Nebula can apply (each behind a confirm).",
      argsSchema: {
        tier: z.enum(["production", "staging"]).optional(),
        symptom: z.string().max(300).optional().describe("what was reported"),
        since: z.string().max(80).optional().describe("when it started (ISO or words)"),
      },
    },
    (a) => ({ messages: [{ role: "user", content: { type: "text", text: DIAGNOSE_PROMPT({ tier: a.tier ?? "production", symptom: a.symptom, since: a.since }) } }] }),
  );

  reg(
    "promote_release",
    "OPERATORS, gate 1 of 2: open a twizz-gitops PR moving a service on STAGING to an immutable image tag (from release_train candidates). Nothing deploys until merge_promotion. There is no production target.",
    { service: z.enum(PROMOTABLE_NAMES as [string, ...string[]]), imageTag: z.string().regex(PROMOTABLE_TAG_RE), confirm },
    W,
    async (a) => gateText(await c.actions.promoteRelease({ service: a.service as never, target: "staging", imageTag: a.imageTag, confirm: a.confirm })),
  );

  reg(
    "merge_promotion",
    "OPERATORS, gate 2 of 2: squash-merge a staging promotion PR (pinned to its head sha); Argo then rolls staging.",
    { prNumber: z.number().int().positive(), service: z.enum(PROMOTABLE_NAMES as [string, ...string[]]), imageTag: z.string().regex(PROMOTABLE_TAG_RE), confirm },
    W,
    async (a) => gateText(await c.actions.mergePromotion({ prNumber: a.prNumber, service: a.service as never, target: "staging", imageTag: a.imageTag, confirm: a.confirm })),
  );
}

export function PLAN_CAPACITY_PROMPT(a: { tier: string; peak?: string; when?: string; event?: string }): string {
  return [
    `Plan ${a.tier} capacity for ${a.event ? `"${a.event}"` : "an expected traffic event"}${a.when ? ` starting ${a.when}` : ""}${a.peak ? `, expected peak ≈ ${a.peak} req/s` : ""}.`,
    "",
    "Work through Nebula, in this order, and show me the evidence at each step:",
    "1. capacity_cases — read the past events. Note how fast traffic ramped (2026-11-05: 132 → 2,327 req/s in ~2 minutes, p95 280 ms → 9.5 s) and what each replay says about what ran vs the recommended sizing.",
    "2. traffic_peaks (days: 14) — how often bursts like this happen, their peak req/s and ramp. If the expected peak is unknown, propose one from the largest comparable burst and say which.",
    `3. capacity_estimate {tier: "${a.tier}", rps: <expected PEAK>, headroom: 1.2} — explain the per-pod req/s, the pods and nodes it asks for, and compare: what runs now, the estimate, and each named template at that load (OK / WATCH / SATURATED).`,
    "4. Recommend ONE: the smallest named template that is OK at the design load, or the estimate if no template fits. Reactive autoscaling can't absorb a 2-minute ramp, so the capacity must be in place BEFORE the event (node groups take several minutes to add nodes).",
    "5. Only if I have the capacity scope and say go: apply_live_capacity with that template or estimateRps and the planHash; show the confirmation summary verbatim and wait for my explicit yes.",
    "6. Plan the step back down to baseline after the event (a second plan + confirm), and note whether this event should become a new case in capacity/cases.yaml.",
    "",
    "Never invent numbers: every figure comes from a tool result. If the profile is uncalibrated for this tier, stop and say so.",
  ].join("\n");
}

export function PREPARE_EVENT_PROMPT(a: { tier: string; event?: string; when?: string; peak?: string; duration?: string }): string {
  return [
    `Prepare ${a.tier} for ${a.event ? `"${a.event}"` : "a marketing event"}${a.when ? ` at ${a.when}` : ""}${a.peak ? `, expected peak ≈ ${a.peak} req/s` : ""}${a.duration ? ` for ~${a.duration} min` : ""}. Ground every step in tool results; show me the numbers.`,
    "",
    "BEFORE (aim to finish ≥ 30 minutes ahead — node groups take minutes to add nodes, and a ramp can be 2 minutes):",
    "1. capacity_cases + traffic_peaks (days 14): the closest past event, its ramp and peak, what saturated.",
    `2. capacity_estimate {tier: "${a.tier}", rps: <expected peak>, headroom: 1.2}: compare what runs now, the estimate and each template at that load.`,
    "3. Recommend the smallest named template that is OK at the design load (else the estimate). Plan it (capacity_plan or the estimate's plan), show ops and warnings.",
    "4. Only with my explicit yes: apply_live_capacity (show the confirmation summary verbatim, wait for my yes).",
    "5. capacity_verify until READY (all pods ready, all nodes joined). If PROGRESSING for > 10 min or MISMATCH, stop and diagnose (recent_changes, cluster_overview, list_pods).",
    "",
    "DURING:",
    "6. event_watch {minutes: 15} every few minutes. If WATCH: tell me why and what the next step would be. If ACT: propose the recommended template (plan first), apply only with my yes, then capacity_verify.",
    "",
    "AFTER:",
    "7. When req/s is back near baseline for 15+ minutes, plan the step back down (estimates step down at most half per apply; the named baseline template may drop in one).",
    "8. traffic_window over the event: summarise peak, ramp, p95, saturation, and draft a new entry for capacity/cases.yaml (I'll PR it).",
  ].join("\n");
}

export function DIAGNOSE_PROMPT(a: { tier: string; symptom?: string; since?: string }): string {
  return [
    `Diagnose ${a.tier}${a.symptom ? `: "${a.symptom}"` : " (reported slowdown or outage)"}${a.since ? `, since ${a.since}` : ""}. Evidence first, hypotheses second, actions last; every claim cites a tool result with timestamps.`,
    "",
    "1. Scope it — event_watch {minutes: 60}: req/s, p95, 5xx, pods, nodes, signals. If the window is older, traffic_peaks + traffic_window around it.",
    "2. What changed — recent_changes from 2 h before the start: Nebula writes (capacity, promotions) and prod image pushes (deploys happen outside Nebula).",
    "3. Saturation or failure? Pods near one core (~900m+) or nodes ≥ 90% with low 5xx = capacity. High 5xx/restarts with normal CPU = a bad deploy, a dependency or data. Check monitor (Atlas/DB), cluster_overview + list_pods (restarts, CrashLoopBackOff).",
    "4. Errors — log_histogram to find the burst, fetch_logs {errorsOnly} on the affected namespace, get_group_samples for the top group. Security/fraud angle: sentinel_alerts.",
    "5. Conclude: the most likely cause with the evidence for and against, and what would confirm it.",
    "6. Remediation through Nebula, each a plan → my explicit yes → confirm → capacity_verify / event_watch:",
    "   - capacity short → apply_live_capacity (template or estimate); DB short → prod_atlas_plan → set_prod_atlas_tier;",
    "   - bad release on staging → promote_release of the previous good tag (release_train shows it);",
    "   - NonProd env broken → rebuild_env / set_env_vars / teardown_env.",
    "   Prod restarts, image rollbacks and anything outside these tools are NOT Nebula actions: say exactly what the on-call engineer should run and why.",
    "7. Afterwards: a short incident note (timeline, cause, fix, follow-ups) and, for capacity events, a capacity/cases.yaml entry.",
  ].join("\n");
}
