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

/** How well a run read one tier of one environment (PLO `COVERAGE_STATES`):
 * observed — every target read, no gap; partial — rows were read but a gap was
 * recorded too; not-observed — nothing was read; not-applicable — the
 * environment has nothing in this tier. */
export const LIFECYCLE_COVERAGE_STATES = ["observed", "partial", "not-observed", "not-applicable"] as const;
export type LifecycleCoverageState = (typeof LIFECYCLE_COVERAGE_STATES)[number];
/** environments one snapshot may list (PLO: MAX_COVERAGE_ENVIRONMENTS) */
export const LIFECYCLE_MAX_COVERAGE_ENVIRONMENTS = 50;

/** The environments of PLO's inventory (`config/inventory.yaml`), in promotion
 * order, with the cluster each owns. /lifecycle ALWAYS shows exactly these —
 * a snapshot that says nothing about one makes it "not observed", never
 * absent. Pinned against PLO by the contract fixture `vocabulary.json`. */
export const LIFECYCLE_ENVIRONMENTS = [
  { name: "nonprod", clusters: ["EKS-Twizz-NonProd"] },
  { name: "staging", clusters: ["EKS-Moly-staging"] },
  { name: "prod", clusters: ["EKS-Moly-Prod"] },
] as const;

export const LIFECYCLE_RUN_ID_RE = /^[A-Za-z0-9._-]{1,120}$/;
/** sha256 hex. Hex cannot spell "prod"/"staging", so a bundle key is always a safe gate field. */
export const LIFECYCLE_BUNDLE_KEY_RE = /^[0-9a-f]{64}$/;

/** every string in a snapshot: bounded, so one field cannot carry a payload */
const str = z.string().max(LIFECYCLE_LIMITS.stringChars);
const isoInstant = str.datetime({ offset: true });
const tier = z.enum(LIFECYCLE_TIERS);
const bundleKey = str.regex(LIFECYCLE_BUNDLE_KEY_RE, "bundleKey must be a sha256 hex digest");

// ── links ─────────────────────────────────────────────────────────────────
// A snapshot is written by whoever holds the ingest token, and three of its
// fields end up in an `<a href>` on /lifecycle. So a URL is accepted only when
// it is `https:` on a host the tab is meant to link to — here, at ingest, and
// again where it is rendered (`lifecycleSafeLink`). Anything else is rejected,
// never repaired.

/** where an advisory may link */
export const LIFECYCLE_ADVISORY_HOSTS = ["osv.dev", "nodejs.org", "github.com", "nvd.nist.gov", "www.cve.org", "www.cisa.gov"] as const;
/** where a pull request or an escalation issue may link */
export const LIFECYCLE_GITHUB_HOSTS = ["github.com"] as const;
/** every host a snapshot URL may be rendered as a link to */
export const LIFECYCLE_LINK_HOSTS: readonly string[] = [...new Set<string>([...LIFECYCLE_ADVISORY_HOSTS, ...LIFECYCLE_GITHUB_HOSTS])];

/** `raw` as a link target, or null: `https:` only, an allowlisted host exactly
 * (no sub-domain, no port, no credentials), and nothing a browser would
 * re-interpret (control characters, a backslash, whitespace). Returns the
 * URL as the parser normalised it. */
export function lifecycleSafeLink(raw: unknown, hosts: readonly string[] = LIFECYCLE_LINK_HOSTS): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > LIFECYCLE_LIMITS.stringChars) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f\\]/.test(raw)) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  if (!hosts.includes(u.hostname)) return null;
  if (!raw.toLowerCase().startsWith(`https://${u.hostname}/`) && raw.toLowerCase() !== `https://${u.hostname}`) return null;
  return u.href;
}

const linkTo = (hosts: readonly string[], what: string) => str.refine((v) => lifecycleSafeLink(v, hosts) !== null, { message: `${what} must be an https URL on ${hosts.join(", ")}` });

/** `owner/name` on GitHub */
export const LIFECYCLE_REPO_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
/** the one URL a pull request has */
export const lifecyclePrUrl = (repo: string, number: number) => `https://github.com/${repo}/pull/${number}`;

export const LifecyclePrRef = z
  .object({
    /** owner/name */
    repo: str.regex(LIFECYCLE_REPO_SLUG_RE, "repo must be owner/name"),
    number: z.number().int().positive(),
    /** exactly `https://github.com/<repo>/pull/<number>` (owner/name compared case-insensitively) */
    url: linkTo(LIFECYCLE_GITHUB_HOSTS, "a pull request url"),
    branch: str,
    headSha: str,
    title: str,
  })
  .superRefine((p, ctx) => {
    // one issue per problem: a bad number or a non-link url is already reported by its own field
    if (!Number.isInteger(p.number) || p.number <= 0 || lifecycleSafeLink(p.url, LIFECYCLE_GITHUB_HOSTS) === null) return;
    if (p.url.toLowerCase() !== lifecyclePrUrl(p.repo, p.number).toLowerCase()) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: "url must be https://github.com/<repo>/pull/<number> of this very pull request" });
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
  /** an issue or pull request on GitHub */
  escalationUrl: linkTo(LIFECYCLE_GITHUB_HOSTS, "escalationUrl").optional(),
});
export type LifecycleChangeSet = z.infer<typeof LifecycleChangeSet>;

/** What a plan or source run really read of one environment. A tier that is
 * absent from `tiers` was not surveyed by that run. */
export const LifecycleEnvironmentCoverage = z.object({
  /** inventory environment name, e.g. "staging" */
  environment: str,
  clusters: z.array(str),
  tiers: z.array(
    z.object({
      tier,
      state: z.enum(LIFECYCLE_COVERAGE_STATES),
      /** components of this tier read for this environment */
      components: z.number().int().min(0),
      /** why the state is not "observed" */
      gaps: z.array(str),
    }),
  ),
});
export type LifecycleEnvironmentCoverage = z.infer<typeof LifecycleEnvironmentCoverage>;

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
  /** https, on one of LIFECYCLE_ADVISORY_HOSTS */
  url: linkTo(LIFECYCLE_ADVISORY_HOSTS, "an advisory url"),
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
  /** what the run really read, per environment and tier. Additive and optional:
   * without it the tab claims an environment observed only where rows exist. */
  coverage: z.array(LifecycleEnvironmentCoverage).max(LIFECYCLE_MAX_COVERAGE_ENVIRONMENTS).optional(),
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

// What a smoke target may be — ONE form per scope, the same two forms PLO's
// own allowlist admits (`smoke.allowedHosts` in its config/inventory.yaml):
//
//   preview  the Service of the bundle's own named env, INSIDE the cluster:
//            `http://<service>.env-plo-<…>.svc.cluster.local[:<port>]`.
//            Not the public host `https://plo-<…>.prv.twizz.com`: every
//            preview Ingress sits behind the ingress-nginx Google sign-in gate,
//            so an unauthenticated GET there is answered 302 whatever the app
//            does, and a smoke through it could never pass. plo-dispatch runs
//            in the same cluster and reaches the Service directly.
//   stg      the fixed staging host of the release train:
//            `https://<short>-stg.prv.twizz.com` (never a `plo-*` host).
//
// No path, no credentials, no IP literal, no other scheme — `file:`,
// `http://169.254.169.254` and friends never validate; a preview target is
// never accepted as staging evidence nor the other way round.

/** scope `stg`: the bare https origin of a release-train staging host. */
export const LIFECYCLE_SMOKE_STG_ORIGIN_RE = /^https:\/\/(?!plo-)[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?-stg\.prv\.twizz\.com$/;
/** scope `preview`: `http://<service>.env-<plo-env>.svc.cluster.local[:port]`. Port 80 is never
 * written (PLO requires the string to be exactly the URL's origin, and an origin drops `:80`). */
export const LIFECYCLE_SMOKE_PREVIEW_ORIGIN_RE = /^http:\/\/([a-z][a-z0-9-]{1,39})\.env-(plo-[a-z0-9-]{1,20})\.svc\.cluster\.local(?::(?!80$)([1-9][0-9]{1,4}))?$/;
/** either form (display, logs); a request is checked against the form of ITS scope */
export const LIFECYCLE_SMOKE_ORIGIN_RE = new RegExp(`${LIFECYCLE_SMOKE_STG_ORIGIN_RE.source}|${LIFECYCLE_SMOKE_PREVIEW_ORIGIN_RE.source}`);

/** Where plo-dispatch reaches the Service of a bundle preview env: the chart names the Service
 * after the registry service (`fullnameOverride`), in namespace `env-<envName>`, on the port of
 * that branch's twizz.yaml. Null when any part is not what such an env can have. */
export function lifecyclePreviewSmokeOrigin(service: string, envName: string, port: number): string | null {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const origin = `http://${service}.env-${envName}.svc.cluster.local${port === 80 ? "" : `:${port}`}`;
  return LIFECYCLE_SMOKE_PREVIEW_ORIGIN_RE.test(origin) ? origin : null;
}

/** The (service, env) a preview smoke origin names, or null when it is not one. */
export function lifecycleParsePreviewSmokeOrigin(origin: string): { service: string; envName: string; port: number } | null {
  const m = LIFECYCLE_SMOKE_PREVIEW_ORIGIN_RE.exec(origin);
  if (!m) return null;
  const port = m[3] ? Number(m[3]) : 80;
  return port >= 1 && port <= 65535 ? { service: m[1], envName: m[2], port } : null;
}

/** Is `baseUrl` a target a smoke request of `scope` may name for service `name`? */
export function lifecycleSmokeTargetOk(scope: LifecycleSmokeScope, name: string, baseUrl: string): boolean {
  if (scope === "stg") return LIFECYCLE_SMOKE_STG_ORIGIN_RE.test(baseUrl);
  // preview: the Service is the target's own service — a request can never point `moly-backend` at another Service
  return lifecycleParsePreviewSmokeOrigin(baseUrl)?.service === name;
}

/** A smoke request's targets. `baseUrl` is built by the dashboard, never by
 * the caller; PLO additionally enforces its own host allowlist. */
export const LifecycleSmokeParams = z
  .object({
    scope: z.enum(LIFECYCLE_SMOKE_SCOPES),
    bundleKey,
    targets: z
      .array(z.object({ name: str.min(1).regex(/^[a-z][a-z0-9-]{1,39}$/, "a registry service name"), baseUrl: str.regex(LIFECYCLE_SMOKE_ORIGIN_RE, "baseUrl must be a smoke origin (the env's in-cluster Service for preview, https://<short>-stg.prv.twizz.com for stg)") }).strict())
      .min(1)
      .max(LIFECYCLE_MAX_SMOKE_TARGETS),
  })
  .strict()
  .superRefine((p, ctx) => {
    p.targets.forEach((t, i) => {
      if (!lifecycleSmokeTargetOk(p.scope, t.name, t.baseUrl)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["targets", i, "baseUrl"], message: `not a ${p.scope} smoke origin of this service` });
    });
  });
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
