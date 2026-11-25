// Lifecycle (docs/NEBULA.md §N9): the snapshot contract between the Platform
// Lifecycle Orchestrator (PLO) and Nebula, schemaVersion 1. PLO's CronJobs
// POST one snapshot per job to /api/lifecycle/ingest; this schema is what the
// dashboard accepts. The same schema lives in PLO `src/nebula/snapshot.ts` —
// change both or neither.
//
// Hard limits, enforced by BOTH sides: body ≤ 4 MB, ≤ 5000 components,
// ≤ 2000 advisories, every string ≤ 2000 chars (PLO truncates, Nebula
// rejects). Unknown keys are STRIPPED on parse, and only the parsed output is
// ever stored — so a snapshot can never smuggle Helm values, env values,
// tokens or run.json's `snapshot.data` into the Nebula database.
import { z } from "zod";

export const LIFECYCLE_SCHEMA_VERSION = 1 as const;

export const LIFECYCLE_LIMITS = {
  /** request body, checked before JSON.parse */
  bodyBytes: 4 * 1024 * 1024,
  components: 5000,
  advisories: 2000,
  stringChars: 2000,
} as const;
/** targets of one smoke request (PLO: MAX_SMOKE_TARGETS) */
export const LIFECYCLE_MAX_SMOKE_TARGETS = 50;

export const LIFECYCLE_TIERS = ["control-plane", "addons", "nodes", "helm", "base-images", "npm-direct", "npm-transitive"] as const;
export type LifecycleTier = (typeof LIFECYCLE_TIERS)[number];

export const LIFECYCLE_JOBS = ["plan", "source", "cve", "smoke"] as const;
export type LifecycleJob = (typeof LIFECYCLE_JOBS)[number];

export const LIFECYCLE_COMPONENT_STATUSES = ["current", "outdated", "pr-open", "awaiting-approval", "escalated", "applied", "failed", "blocked", "unknown"] as const;
export type LifecycleComponentStatus = (typeof LIFECYCLE_COMPONENT_STATUSES)[number];

export const LIFECYCLE_BUMPS = ["none", "patch", "minor", "major", "unknown"] as const;
export type LifecycleBump = (typeof LIFECYCLE_BUMPS)[number];

export const LIFECYCLE_AUTONOMY = ["auto", "pr", "approval", "escalate", "ignore"] as const;
export type LifecycleAutonomy = (typeof LIFECYCLE_AUTONOMY)[number];

export const LIFECYCLE_SEVERITIES = ["critical", "high", "moderate", "low", "unknown"] as const;
export type LifecycleSeverity = (typeof LIFECYCLE_SEVERITIES)[number];

export const LIFECYCLE_SMOKE_SCOPES = ["preview", "stg"] as const;
export type LifecycleSmokeScope = (typeof LIFECYCLE_SMOKE_SCOPES)[number];

export const LIFECYCLE_RUN_ID_RE = /^[A-Za-z0-9._-]{1,120}$/;
/** sha256 hex. Hex cannot spell "prod"/"staging", so a bundle key is always a safe gate field. */
export const LIFECYCLE_BUNDLE_KEY_RE = /^[0-9a-f]{64}$/;

/** every string in a snapshot: bounded, so one field cannot carry a payload */
const str = z.string().max(LIFECYCLE_LIMITS.stringChars);
const isoInstant = str.datetime({ offset: true });
const tier = z.enum(LIFECYCLE_TIERS);
const bundleKey = str.regex(LIFECYCLE_BUNDLE_KEY_RE, "bundleKey must be a sha256 hex digest");

export const LifecyclePrRef = z.object({
  /** owner/name */
  repo: str,
  number: z.number().int().positive(),
  url: str,
  branch: str,
  headSha: str,
  title: str,
});
export type LifecyclePrRef = z.infer<typeof LifecyclePrRef>;

export const LifecycleScheduleEntry = z.object({
  job: str,
  cron: str,
  runner: z.enum(["nebula", "github-actions"]),
  description: str,
  mutates: z.boolean(),
});
export type LifecycleScheduleEntry = z.infer<typeof LifecycleScheduleEntry>;

export const LifecycleComponent = z.object({
  id: str,
  tier,
  domain: str,
  name: str,
  /** cluster or repository name */
  target: str,
  /** environment names affected, e.g. ["staging"] or ["staging","prod"] for a repo */
  environments: z.array(str),
  current: str,
  desired: str.nullable(),
  latest: str.nullable(),
  bump: z.enum(LIFECYCLE_BUMPS),
  status: z.enum(LIFECYCLE_COMPONENT_STATUSES),
  autonomy: z.enum(LIFECYCLE_AUTONOMY),
  reasons: z.array(str),
  eol: z.object({ eol: z.boolean(), date: str.optional() }).optional(),
  security: z.object({ advisories: z.number().int().min(0), highestSeverity: str.optional() }).optional(),
  rollback: z.enum(["supported", "limited", "none"]),
  changeSetId: str.optional(),
  pr: LifecyclePrRef.optional(),
});
export type LifecycleComponent = z.infer<typeof LifecycleComponent>;

export const LifecycleChangeSet = z.object({
  id: str,
  stage: str,
  target: str,
  domain: str,
  tier,
  autonomy: str,
  status: str,
  rationale: z.array(str),
  componentIds: z.array(str),
  pr: LifecyclePrRef.optional(),
  escalationUrl: str.optional(),
});
export type LifecycleChangeSet = z.infer<typeof LifecycleChangeSet>;

export const LifecycleBundle = z.object({
  /** inventory name of the repository */
  repo: str,
  /** owner/name on GitHub */
  github: str,
  baseBranch: str,
  /** plo/bundle/<yyyy-mm> */
  branch: str,
  /** null when nothing could be bundled */
  headSha: str.nullable(),
  included: z.array(LifecyclePrRef),
  conflicts: z.array(z.object({ pr: LifecyclePrRef, files: z.array(str) })),
  environments: z.array(str),
});
export type LifecycleBundle = z.infer<typeof LifecycleBundle>;

export const LifecycleAdvisory = z.object({
  id: str,
  aliases: z.array(str),
  source: z.enum(["osv", "nodejs", "npm-audit"]),
  severity: z.enum(LIFECYCLE_SEVERITIES),
  cvss: z.number().min(0).max(10).optional(),
  /** in CISA Known Exploited Vulnerabilities */
  kev: z.boolean(),
  /** 0..1 */
  epss: z.number().min(0).max(1).optional(),
  summary: str,
  url: str,
  published: str.optional(),
  modified: str.optional(),
  affected: z.array(
    z.object({
      componentId: str,
      name: str,
      tier,
      target: str,
      version: str,
      fixedIn: str.nullable(),
      environments: z.array(str),
    }),
  ),
});
export type LifecycleAdvisory = z.infer<typeof LifecycleAdvisory>;

export const LifecycleSmoke = z.object({
  scope: z.enum(LIFECYCLE_SMOKE_SCOPES),
  bundleKey,
  results: z.array(
    z.object({
      name: str,
      url: str,
      ok: z.boolean(),
      status: z.number().int().nullable(),
      ms: z.number().min(0),
      detail: str,
    }),
  ),
});
export type LifecycleSmoke = z.infer<typeof LifecycleSmoke>;

/** One PLO job's result. Named `…Doc` because `LifecycleSnapshot` is the
 * Prisma model that stores it (`data` column). */
export const LifecycleSnapshotDoc = z.object({
  schemaVersion: z.literal(LIFECYCLE_SCHEMA_VERSION),
  job: z.enum(LIFECYCLE_JOBS),
  runId: z.string().regex(LIFECYCLE_RUN_ID_RE, "runId must match ^[A-Za-z0-9._-]{1,120}$"),
  /** set when the job ran for a Nebula request */
  requestId: str.optional(),
  startedAt: isoInstant,
  finishedAt: isoInstant,
  /** false when the job itself failed; partial data may still be present */
  ok: z.boolean(),
  /** short, no secrets */
  error: str.optional(),
  schedule: z.array(LifecycleScheduleEntry),
  discoveryErrors: z.array(z.object({ domain: str, error: str })),
  // job plan | source
  components: z.array(LifecycleComponent).max(LIFECYCLE_LIMITS.components).optional(),
  changeSets: z.array(LifecycleChangeSet).optional(),
  // job source
  bundles: z.array(LifecycleBundle).optional(),
  /** sha256 hex over sorted `${github}@${headSha}` of all bundles with a headSha */
  bundleKey: bundleKey.optional(),
  // job cve
  advisories: z.array(LifecycleAdvisory).max(LIFECYCLE_LIMITS.advisories).optional(),
  // job smoke
  smoke: LifecycleSmoke.optional(),
});
export type LifecycleSnapshotDoc = z.infer<typeof LifecycleSnapshotDoc>;

/** Zod issue PATHS and codes only — never the offending value (a rejected
 * snapshot may be rejected precisely because it carries something it must not). */
export function lifecycleIssuePaths(error: z.ZodError, max = 50): Array<{ path: string; code: string }> {
  return error.issues.slice(0, max).map((i) => ({ path: i.path.join(".") || "(root)", code: i.code }));
}

// ── on-demand requests (§4): a row an operator creates through the gate; the
//    plo-dispatch CronJob claims and runs it. Params are validated on both
//    sides; PLO treats them as untrusted input. ──────────────────────────────

export const LIFECYCLE_REQUEST_KINDS = ["plan", "cve", "smoke"] as const;
export type LifecycleRequestKind = (typeof LIFECYCLE_REQUEST_KINDS)[number];

export const LIFECYCLE_REQUEST_STATUSES = ["pending", "claimed", "done", "failed", "expired"] as const;
export type LifecycleRequestStatus = (typeof LIFECYCLE_REQUEST_STATUSES)[number];

/** A smoke request's targets. `baseUrl` is built by the dashboard, never by
 * the caller; PLO additionally enforces its own host allowlist. */
export const LifecycleSmokeParams = z
  .object({
    scope: z.enum(LIFECYCLE_SMOKE_SCOPES),
    bundleKey,
    targets: z.array(z.object({ name: str.min(1), baseUrl: str.url() }).strict()).min(1).max(LIFECYCLE_MAX_SMOKE_TARGETS),
  })
  .strict();
export type LifecycleSmokeParams = z.infer<typeof LifecycleSmokeParams>;

const NoParams = z.object({}).strict();

export const LIFECYCLE_REQUEST_PARAMS = { plan: NoParams, cve: NoParams, smoke: LifecycleSmokeParams } as const;
export type LifecycleRequestParams = { plan: Record<string, never>; cve: Record<string, never>; smoke: LifecycleSmokeParams };

/** Validate `params` for a request kind (strict: unknown keys are an error). */
export function parseLifecycleRequestParams<K extends LifecycleRequestKind>(kind: K, params: unknown): LifecycleRequestParams[K] {
  return LIFECYCLE_REQUEST_PARAMS[kind].parse(params) as LifecycleRequestParams[K];
}

export function isLifecycleRequestKind(kind: string): kind is LifecycleRequestKind {
  return (LIFECYCLE_REQUEST_KINDS as readonly string[]).includes(kind);
}

/** Body of POST /api/lifecycle/requests/:id/complete. */
export const LifecycleCompleteBody = z
  .object({
    ok: z.boolean(),
    error: str.optional(),
    runId: z.string().regex(LIFECYCLE_RUN_ID_RE).optional(),
  })
  .strict();
export type LifecycleCompleteBody = z.infer<typeof LifecycleCompleteBody>;
