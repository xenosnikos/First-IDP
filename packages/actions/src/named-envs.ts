import { randomBytes } from "node:crypto";
import { Document as YamlDocument, parse as parseYaml, type Scalar } from "yaml";
import { PROVISIONABLE, REGISTRY, type ServiceEntry } from "./registry";

// ── Constants ─────────────────────────────────────────────────────────
// Everything a caller can influence is validated against these; secret names
// and ECR repos are DERIVED from `service`, never taken from input.

export const GITOPS = { owner: "TwizzyNicky", repo: "twizz-gitops", branch: "main", dir: "named-envs" } as const;
export const PREVIEW_DOMAIN = "prv.twizz.com";

/** Any service name (a registry entry or a repo slug). Release-image
 * provisioning (`create_named_env`) is still limited to `SERVICE_NAMES`. */
export type ServiceName = string;
/** Provisionable backends for the RELEASE-IMAGE path, derived from the
 * registry (registry.ts): resolve `ecrRepo` / `sourceSecret` by service. */
export const SERVICES: Record<string, { ecrRepo: string; sourceSecret: string }> = Object.fromEntries(
  PROVISIONABLE.map((s) => [s.name, { ecrRepo: s.ecrRepo, sourceSecret: s.sourceSecret! }]),
);
export const SERVICE_NAMES = Object.keys(SERVICES);

export const NAME_RE = /^[a-z][a-z0-9-]{2,23}$/;
/** Service = ECR repo name = Helm release name; a repo slug or registry name. */
export const SERVICE_RE = /^[a-z][a-z0-9-]{1,39}$/;
/** Services that are platform plumbing and can never be a preview service. */
export const RESERVED_SERVICES = /^(nebula|argocd|shared|kube-.*|default|redis|postgres)$/;
/** `build-<uuid>` = CodeBuild release images (moly-backend); `nb-<env>-<sha12>`
 * = images the central builder produced for one env from one commit. */
export const IMAGE_TAG_RE = /^(build-[0-9a-f-]{36}|nb-[a-z][a-z0-9-]{2,23}-[0-9a-f]{12})$/;
export const PENDING_DIR = "named-envs/pending";
/** Floating tags CodeBuild re-points on every build — never a "release version". */
export const ALIAS_TAGS = new Set(["latest", "prod", "dev", "staging"]);
export const DEFAULT_MAX_NAMED_ENVS = 6;
export const TTL_HOURS = { min: 1, max: 336, default: 168 } as const;

export type DbMode = "isolated" | "clone" | "none";
export type EnvKind = "backend" | "frontend" | "worker";
export type BuildStatus = "PENDING" | "RUNNING" | "PASS" | "FAIL";

/** Manifest schema v3 (docs/NEBULA.md §N3.7). v1 `frontendOrigin` and v2 files
 * are still accepted on read. A file under `named-envs/` must carry
 * `imageTag` (the ApplicationSet renders it); a file under
 * `named-envs/pending/` is being built (or failed) and may not. */
export type NamedEnvManifest = {
  name: string;
  kind: EnvKind;
  service: ServiceName;
  owner: string;
  /** Present ⇔ deployable. Absent while the central builder runs. */
  imageTag?: string;
  expiresAt: string;
  db: { mode: DbMode; generation: number };
  /** Every browser origin the backend's ingress must accept (CORS). */
  frontendOrigins: string[];
  /** Where the image came from (build-on-provision envs only). */
  source?: { repo: string; ref: string; sha: string; prNumber?: number; prUrl?: string };
  build?: {
    status: BuildStatus;
    /** Deterministic: nb-<name>-<sha12>; the watcher verifies it in ECR. */
    expectedTag: string;
    startedAt: string;
    finishedAt?: string;
    runId?: number;
    runUrl?: string;
    reason?: string;
  };
  /** Snapshot of twizz.yaml + dashboard config that shaped the env (public
   * values only: build args are baked into the image anyway). */
  config?: { port: number; healthPath: string; rev: number; envVarNames: string[]; dockerfile?: string; context?: string; buildArgs?: Record<string, string> };
  /** Frontend envs: the NAMED backend env whose API they were built against. */
  attachTo?: string;
};

export const ORIGIN_RE = /^https:\/\/[a-z0-9.-]+(:\d+)?$/i;

/** Normalise a caller-supplied origin list: trim, drop empties, dedupe,
 * validate. Throws on the first bad origin. */
export function normalizeOrigins(origins: readonly string[] | undefined, fallback: string): string[] {
  const list = (origins ?? []).map((o) => o.trim()).filter(Boolean);
  const out = list.length ? [...new Set(list)] : [fallback];
  for (const o of out) if (!ORIGIN_RE.test(o)) throw new Error(`frontendOrigins: "${o}" is not an https origin (scheme + host[:port], no path)`);
  return out;
}

// ── Pure helpers ──────────────────────────────────────────────────────

export function isValidName(name: string): boolean {
  return NAME_RE.test(name);
}

export function isValidImageTag(tag: string): boolean {
  return IMAGE_TAG_RE.test(tag) && !ALIAS_TAGS.has(tag);
}

/** `preview/<service>/<name>` for every service (for moly-backend this equals
 * `<sourceSecret>/<name>`, so the release-image path is unchanged). */
export function envSecretName(service: ServiceName, name: string): string {
  return `preview/${service}/${name}`;
}

export function isValidService(service: string): boolean {
  return SERVICE_RE.test(service) && !RESERVED_SERVICES.test(service);
}

/** Image tag the central builder produces for one env from one commit. */
export function nebulaTag(name: string, sha: string): string {
  return `nb-${name}-${sha.slice(0, 12)}`;
}

/** Which service a GitHub repo maps to: a registry entry by `repo` (moly-backend
 * keeps its ECR repo, source blob and boot-key path), else the repo slug. */
export function resolveService(repoSlug: string): { service: string; ecrRepo: string; kind?: EnvKind; legacyBoot: boolean; registry?: ServiceEntry } {
  const entry = REGISTRY.find((e) => e.repo.toLowerCase() === repoSlug.toLowerCase());
  if (entry) {
    const legacyBoot = entry.name === "moly-backend";
    return { service: entry.name, ecrRepo: entry.ecrRepo, kind: entry.kind, legacyBoot, registry: entry };
  }
  const service = (repoSlug.split("/")[1] ?? repoSlug).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!isValidService(service)) throw new Error(`repo "${repoSlug}" does not map to a valid service name (${SERVICE_RE}, not reserved)`);
  return { service, ecrRepo: service, legacyBoot: false };
}

export function envHost(name: string): string {
  return `${name}.${PREVIEW_DOMAIN}`;
}

export function defaultFrontendOrigin(name: string): string {
  return `https://${name}-frontend.${PREVIEW_DOMAIN}`;
}

export function envDbName(name: string): string {
  return `nebula_${name}`;
}

export function manifestPath(name: string, pending = false): string {
  return `${pending ? PENDING_DIR : GITOPS.dir}/${name}.yaml`;
}

/** Replace (or insert) the database path of a Mongo URI, preserving scheme,
 * credentials, hosts and query string. `mongodb+srv://u:p@h/moly?x=1` →
 * `mongodb+srv://u:p@h/nebula_x?x=1`. */
export function rewriteMongoDb(uri: string, db: string): string {
  const m = uri.match(/^(mongodb(?:\+srv)?:\/\/[^/?]+)(?:\/[^?]*)?(\?.*)?$/);
  if (!m) throw new Error("not a mongodb:// or mongodb+srv:// URI");
  return `${m[1]}/${db}${m[2] ?? ""}`;
}

export function freshTokenSecret(): string {
  return randomBytes(32).toString("hex");
}

/** The per-env config blob: the service's shared preview blob with the env's
 * own database, frontend origin, JWT secret and in-cluster Redis. Nothing else
 * changes — every other key (S3, SQS, third-party) stays shared with staging. */
export function deriveEnvSecret(
  base: Record<string, string>,
  opts: { name: string; frontendOrigin: string; tokenSecret: string },
): Record<string, string> {
  const db = envDbName(opts.name);
  const out: Record<string, string> = { ...base };
  for (const key of ["MONGO_URI", "SHIFT_FOUR_MONGO_URI"]) {
    if (typeof base[key] === "string" && base[key]) out[key] = rewriteMongoDb(base[key], db);
  }
  out.BUSINESS_URL = opts.frontendOrigin;
  out.TOKEN_SECRET = opts.tokenSecret;
  out.REDIS_HOST = "redis"; // per-env in-cluster Redis (chart `redis.enabled`)
  out.REDIS_PASSWORD = "";
  return out;
}

export function expiresAtFrom(now: Date, ttlHours: number): string {
  return new Date(now.getTime() + ttlHours * 3_600_000).toISOString();
}

/** Kubernetes label value: [A-Za-z0-9._-], alphanumeric at both ends, ≤63. */
export function toLabelValue(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "").slice(0, 63);
  return cleaned.replace(/[^A-Za-z0-9]+$/, "") || "unknown";
}

export function manifestToYaml(m: NamedEnvManifest): string {
  // Key order is the documented schema order (named-envs/README.md). Optional
  // v3 blocks are emitted only when present — never as null, because the
  // ApplicationSet renders with missingkey=error and `hasKey` guards.
  const ordered: Record<string, unknown> = {
    name: m.name,
    kind: m.kind,
    service: m.service,
    owner: m.owner,
    ...(m.imageTag ? { imageTag: m.imageTag } : {}),
    expiresAt: m.expiresAt,
    db: { mode: m.db.mode, generation: m.db.generation },
    frontendOrigins: [...m.frontendOrigins],
  };
  if (m.source) ordered.source = { repo: m.source.repo, ref: m.source.ref, sha: m.source.sha, ...(m.source.prNumber != null ? { prNumber: m.source.prNumber } : {}), ...(m.source.prUrl ? { prUrl: m.source.prUrl } : {}) };
  if (m.build) {
    const b = m.build;
    ordered.build = {
      status: b.status,
      expectedTag: b.expectedTag,
      startedAt: b.startedAt,
      ...(b.finishedAt ? { finishedAt: b.finishedAt } : {}),
      ...(b.runId != null ? { runId: b.runId } : {}),
      ...(b.runUrl ? { runUrl: b.runUrl } : {}),
      ...(b.reason ? { reason: b.reason } : {}),
    };
  }
  if (m.config) {
    ordered.config = {
      port: m.config.port,
      healthPath: m.config.healthPath,
      rev: m.config.rev,
      envVarNames: [...m.config.envVarNames],
      ...(m.config.dockerfile ? { dockerfile: m.config.dockerfile } : {}),
      ...(m.config.context ? { context: m.config.context } : {}),
      ...(m.config.buildArgs && Object.keys(m.config.buildArgs).length ? { buildArgs: { ...m.config.buildArgs } } : {}),
    };
  }
  if (m.attachTo) ordered.attachTo = m.attachTo;
  const doc = new YamlDocument(ordered);
  // Quote timestamps so no YAML 1.1 parser (Go's, on the Argo side) turns them
  // into time values; matches the documented schema.
  (doc.get("expiresAt", true) as Scalar).type = "QUOTE_DOUBLE";
  if (m.build) {
    (doc.getIn(["build", "startedAt"], true) as Scalar).type = "QUOTE_DOUBLE";
    if (m.build.finishedAt) (doc.getIn(["build", "finishedAt"], true) as Scalar).type = "QUOTE_DOUBLE";
  }
  return doc.toString({ lineWidth: 0 });
}

const iso = (k: string, v: unknown): string => {
  if (v instanceof Date) return v.toISOString();
  if (typeof v !== "string") throw new Error(`manifest: "${k}" must be a string`);
  return v;
};

/** Tolerant on shape (unknown keys ignored, v1/v2/v3 accepted), strict on
 * meaning. `imageTag` is required for a deployable file (`where:
 * "deployable"`, the default) and for any file whose build passed. */
export function parseManifest(text: string, opts: { where?: "deployable" | "pending" } = {}): NamedEnvManifest {
  const raw = parseYaml(text);
  if (!raw || typeof raw !== "object") throw new Error("manifest is not a YAML mapping");
  const r = raw as Record<string, unknown>;
  const db = (r.db ?? {}) as Record<string, unknown>;
  const str = (k: string, v: unknown): string => {
    if (typeof v !== "string") throw new Error(`manifest: "${k}" must be a string`);
    return v;
  };
  const name = str("name", r.name);
  if (!isValidName(name)) throw new Error(`manifest: invalid name "${name}"`);
  const service = str("service", r.service);
  if (!SERVICE_RE.test(service)) throw new Error(`manifest: invalid service "${service}"`);
  const mode = str("db.mode", db.mode);
  if (mode !== "isolated" && mode !== "clone" && mode !== "none") throw new Error(`manifest: db.mode must be isolated|clone|none`);
  const generation = Number(db.generation);
  if (!Number.isInteger(generation) || generation < 0) throw new Error("manifest: db.generation must be a non-negative integer");
  const expiresAt = iso("expiresAt", r.expiresAt);
  const kind = r.kind === undefined ? "backend" : str("kind", r.kind);
  if (kind !== "backend" && kind !== "frontend" && kind !== "worker") throw new Error(`manifest: kind must be backend|frontend|worker`);
  // v2 list, else v1 single string, else none
  let frontendOrigins: string[];
  if (Array.isArray(r.frontendOrigins)) {
    frontendOrigins = r.frontendOrigins.map((o, i) => str(`frontendOrigins[${i}]`, o)).filter(Boolean);
  } else if (typeof r.frontendOrigin === "string" && r.frontendOrigin) {
    frontendOrigins = [r.frontendOrigin];
  } else {
    frontendOrigins = [];
  }

  let source: NamedEnvManifest["source"];
  if (r.source && typeof r.source === "object") {
    const so = r.source as Record<string, unknown>;
    source = { repo: str("source.repo", so.repo), ref: str("source.ref", so.ref), sha: str("source.sha", so.sha) };
    if (so.prNumber != null) source.prNumber = Number(so.prNumber);
    if (typeof so.prUrl === "string") source.prUrl = so.prUrl;
  }
  let build: NamedEnvManifest["build"];
  if (r.build && typeof r.build === "object") {
    const b = r.build as Record<string, unknown>;
    const status = str("build.status", b.status);
    if (!["PENDING", "RUNNING", "PASS", "FAIL"].includes(status)) throw new Error(`manifest: build.status must be PENDING|RUNNING|PASS|FAIL`);
    build = { status: status as BuildStatus, expectedTag: str("build.expectedTag", b.expectedTag), startedAt: iso("build.startedAt", b.startedAt) };
    if (b.finishedAt != null) build.finishedAt = iso("build.finishedAt", b.finishedAt);
    if (b.runId != null) build.runId = Number(b.runId);
    if (typeof b.runUrl === "string") build.runUrl = b.runUrl;
    if (typeof b.reason === "string") build.reason = b.reason;
  }
  let config: NamedEnvManifest["config"];
  if (r.config && typeof r.config === "object") {
    const c = r.config as Record<string, unknown>;
    config = {
      port: Number(c.port),
      healthPath: str("config.healthPath", c.healthPath),
      rev: Number.isInteger(Number(c.rev)) ? Number(c.rev) : 0,
      envVarNames: Array.isArray(c.envVarNames) ? c.envVarNames.map((k, i) => str(`config.envVarNames[${i}]`, k)) : [],
    };
    if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error("manifest: config.port must be a port number");
    if (typeof c.dockerfile === "string") config.dockerfile = c.dockerfile;
    if (typeof c.context === "string") config.context = c.context;
    if (c.buildArgs && typeof c.buildArgs === "object") {
      config.buildArgs = Object.fromEntries(Object.entries(c.buildArgs as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
    }
  }
  const attachTo = typeof r.attachTo === "string" && r.attachTo ? r.attachTo : undefined;
  if (attachTo && !isValidName(attachTo)) throw new Error(`manifest: invalid attachTo "${attachTo}"`);

  const where = opts.where ?? "deployable";
  const imageTag = typeof r.imageTag === "string" && r.imageTag ? r.imageTag : undefined;
  if (!imageTag && (where === "deployable" || build?.status === "PASS")) throw new Error(`manifest: "imageTag" is required for a deployable env`);

  return {
    name,
    kind,
    service,
    owner: str("owner", r.owner),
    ...(imageTag ? { imageTag } : {}),
    expiresAt,
    db: { mode, generation },
    frontendOrigins,
    ...(source ? { source } : {}),
    ...(build ? { build } : {}),
    ...(config ? { config } : {}),
    ...(attachTo ? { attachTo } : {}),
  };
}

// ── Ports (implemented in adapters.ts; faked in tests) ────────────────

/** One file in an atomic multi-file commit; `content: null` deletes. */
export type FileChange = { path: string; content: string | null };

export interface GitopsRepo {
  /** null when the path does not exist */
  getFile(path: string): Promise<{ content: string; sha: string } | null>;
  putFile(path: string, content: string, message: string, sha?: string): Promise<void>;
  deleteFile(path: string, message: string, sha: string): Promise<void>;
  listDir(path: string): Promise<string[]>;
  /** Several files in ONE commit (Git Data API). Returns the commit sha. */
  commit(changes: FileChange[], message: string): Promise<string>;
}

export interface SecretStore {
  getJson(name: string): Promise<Record<string, string>>;
  createJson(name: string, value: Record<string, string>, tags: Record<string, string>): Promise<void>;
  /** Replace the value of an existing secret. */
  putJson(name: string, value: Record<string, string>): Promise<void>;
  /** Immediate, unrecoverable delete (ForceDeleteWithoutRecovery). */
  deleteNow(name: string): Promise<void>;
}

export type BuildInputs = {
  repo: string;
  ref: string;
  sha: string;
  service: string;
  envName: string;
  dockerfile: string;
  context: string;
  buildArgs: Record<string, string>;
  target?: string;
};
export type BuildRun = { id: number; url: string; status: "queued" | "in_progress" | "completed"; conclusion?: string; createdAt: string };

/** The central builder (.github/workflows/nebula-build.yml in twizz-idp). */
export interface BuildDispatcher {
  /** workflow_dispatch: 204, no run id — correlate with findRun. */
  dispatch(inputs: BuildInputs): Promise<void>;
  findRun(q: { displayTitle: string; createdAfter: Date }): Promise<BuildRun | null>;
  getRun(runId: number): Promise<BuildRun>;
  /** The display title the workflow's run-name renders for these inputs. */
  displayTitle(inputs: Pick<BuildInputs, "envName" | "service" | "sha">): string;
}

export type ImageInfo = { tags: string[]; pushedAt: Date | undefined; digest: string | undefined };

export interface ImageRegistry {
  /** null when the tag does not exist in the repo */
  describeTag(repo: string, tag: string): Promise<ImageInfo | null>;
  listImages(repo: string): Promise<ImageInfo[]>;
}

export type NamedEnvDeps = {
  gitops: GitopsRepo;
  secrets: SecretStore;
  images: ImageRegistry;
  now?: () => Date;
  maxNamedEnvs?: number;
};

// ── Actions ───────────────────────────────────────────────────────────

export type CreateNamedEnvInput = {
  name: string;
  service: ServiceName;
  imageTag: string;
  db: DbMode;
  ttlHours: number;
  /** Browser origins allowed by the backend's ingress CORS; default [https://<name>-frontend.prv.twizz.com] */
  frontendOrigins?: string[];
  /** who is asking — becomes the manifest `owner` (label-safe) */
  actor: string;
};

export type ListResult = {
  /** Deployable envs (named-envs/*.yaml) */
  envs: NamedEnvManifest[];
  /** Building or failed envs (named-envs/pending/*.yaml) */
  pending: NamedEnvManifest[];
  /** Files that did not parse — shown, never hidden; never fatal. */
  broken: Array<{ path: string; error: string }>;
};

/** Both directories, one bad file never breaks the rest. */
export async function listNamedEnvs(deps: Pick<NamedEnvDeps, "gitops">): Promise<ListResult> {
  const out: ListResult = { envs: [], pending: [], broken: [] };
  for (const [dir, where] of [[GITOPS.dir, "deployable"], [PENDING_DIR, "pending"]] as const) {
    const files = (await deps.gitops.listDir(dir)).filter((f) => f.endsWith(".yaml"));
    for (const f of files) {
      const path = `${dir}/${f}`;
      try {
        const file = await deps.gitops.getFile(path);
        if (!file) continue;
        const m = parseManifest(file.content, { where });
        (where === "pending" ? out.pending : out.envs).push(m);
      } catch (e) {
        out.broken.push({ path, error: String((e as Error).message ?? e) });
      }
    }
  }
  out.envs.sort((a, b) => a.name.localeCompare(b.name));
  out.pending.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Find an env in either directory. */
export async function findEnv(
  deps: Pick<NamedEnvDeps, "gitops">,
  name: string,
): Promise<{ manifest: NamedEnvManifest; path: string; sha: string; pending: boolean } | null> {
  for (const pending of [false, true]) {
    const path = manifestPath(name, pending);
    const file = await deps.gitops.getFile(path);
    if (file) return { manifest: parseManifest(file.content, { where: pending ? "pending" : "deployable" }), path, sha: file.sha, pending };
  }
  return null;
}

/** Live count for the cap: deployable + pending. */
export async function countEnvs(deps: Pick<NamedEnvDeps, "gitops">): Promise<number> {
  const [a, b] = await Promise.all([deps.gitops.listDir(GITOPS.dir), deps.gitops.listDir(PENDING_DIR)]);
  return a.filter((f) => f.endsWith(".yaml")).length + b.filter((f) => f.endsWith(".yaml")).length;
}

export async function createNamedEnv(deps: NamedEnvDeps, input: CreateNamedEnvInput) {
  const now = deps.now ?? (() => new Date());
  const { name, service, imageTag } = input;
  if (!isValidName(name)) throw new Error(`invalid env name "${name}" (want ${NAME_RE})`);
  if (!(service in SERVICES)) throw new Error(`unknown service "${service}"`);
  if (!isValidImageTag(imageTag)) throw new Error(`imageTag must be an immutable build-* tag, got "${imageTag}"`);
  if (!Number.isInteger(input.ttlHours) || input.ttlHours < TTL_HOURS.min || input.ttlHours > TTL_HOURS.max) {
    throw new Error(`ttlHours must be an integer in ${TTL_HOURS.min}..${TTL_HOURS.max}`);
  }
  const frontendOrigins = normalizeOrigins(input.frontendOrigins, defaultFrontendOrigin(name));
  const frontendOrigin = frontendOrigins[0]; // BUSINESS_URL / USER_URL in the env blob

  const path = manifestPath(name);
  if (await findEnv(deps, name)) throw new Error(`env "${name}" already exists`);

  const live = await countEnvs(deps);
  const max = deps.maxNamedEnvs ?? DEFAULT_MAX_NAMED_ENVS;
  if (live >= max) throw new Error(`named-env cap reached (${live}/${max}); tear one down first`);

  const { ecrRepo, sourceSecret } = SERVICES[service];
  const image = await deps.images.describeTag(ecrRepo, imageTag);
  if (!image) throw new Error(`image ${ecrRepo}:${imageTag} not found in ECR`);

  // 1. per-env config blob, derived server-side from the service's shared blob
  const secretName = envSecretName(service, name);
  const base = await deps.secrets.getJson(sourceSecret);
  const derived = deriveEnvSecret(base, { name, frontendOrigin, tokenSecret: freshTokenSecret() });
  await deps.secrets.createJson(secretName, derived, { "nebula-env": name, "nebula-service": service });

  // 2. the manifest — the env itself
  const manifest: NamedEnvManifest = {
    name,
    kind: "backend",
    service,
    owner: toLabelValue(input.actor),
    imageTag,
    expiresAt: expiresAtFrom(now(), input.ttlHours),
    db: { mode: input.db, generation: 1 },
    frontendOrigins,
  };
  await deps.gitops.putFile(path, manifestToYaml(manifest), `nebula: create env ${name} (${input.actor})`);

  return {
    name,
    url: `https://${envHost(name)}`,
    argoApp: `env-${name}`,
    namespace: `env-${name}`,
    secret: secretName,
    db: envDbName(name),
    manifest,
    image: { tag: imageTag, aliases: image.tags.filter((t) => t !== imageTag), pushedAt: image.pushedAt },
  };
}

/** Delete the manifest (Argo prunes the app; the chart's PostDelete hook drops
 * the db), the env's values file if any, and the per-env secret — one commit.
 * Works for deployable and pending envs. The `env-<name>` NAMESPACE is not
 * deleted by Argo and is not touched here (no kube API in this package) — the
 * reaper removes it. */
export async function teardownNamedEnv(deps: Pick<NamedEnvDeps, "gitops" | "secrets">, input: { name: string; actor: string }) {
  const { name } = input;
  if (!isValidName(name)) throw new Error(`invalid env name "${name}"`);
  const found = await findEnv(deps, name);
  if (!found) throw new Error(`env "${name}" does not exist`);
  const { manifest, path } = found;
  const secretName = envSecretName(manifest.service, name);

  const changes: FileChange[] = [{ path, content: null }];
  const envValues = envValuesPath(manifest.service, name);
  if (await deps.gitops.getFile(envValues)) changes.push({ path: envValues, content: null });
  await deps.gitops.commit(changes, `nebula: teardown env ${name} (${input.actor})`);
  let secretDeleted = true;
  let secretError: string | undefined;
  try {
    await deps.secrets.deleteNow(secretName);
  } catch (e) {
    secretDeleted = false;
    secretError = String(e);
  }
  return {
    name,
    manifestDeleted: true,
    pending: found.pending,
    secret: secretName,
    secretDeleted,
    ...(secretError ? { secretError } : {}),
    note: `Argo CD prunes env-${name}; the PostDelete hook drops ${envDbName(name)}. Namespace env-${name} is reaped separately.`,
  };
}

/** Per-env non-secret Helm values (port, probes, env block) in twizz-gitops. */
export function envValuesPath(service: string, name: string): string {
  return `apps/${service}/envs/${name}.yaml`;
}

export function serviceValuesPath(service: string): string {
  return `apps/${service}/values.yaml`;
}

export async function cloneStagingDb(deps: Pick<NamedEnvDeps, "gitops">, input: { name: string; actor: string }) {
  const { name } = input;
  if (!isValidName(name)) throw new Error(`invalid env name "${name}"`);
  const found = await findEnv(deps, name);
  if (!found) throw new Error(`env "${name}" does not exist`);
  if (found.pending) throw new Error(`env "${name}" is still building; clone once it is deployed`);
  const { manifest, path, sha } = found;
  if (manifest.service !== "moly-backend") throw new Error(`clone-staging-db is only available for moly-backend envs`);
  const next: NamedEnvManifest = { ...manifest, db: { mode: "clone", generation: manifest.db.generation + 1 } };
  await deps.gitops.putFile(path, manifestToYaml(next), `nebula: re-clone db for env ${name} -> generation ${next.db.generation} (${input.actor})`, sha);
  return {
    name,
    source: SERVICES[manifest.service]?.sourceSecret ?? `preview/${manifest.service}`,
    targetDb: envDbName(name),
    generation: next.db.generation,
    previousMode: manifest.db.mode,
    note: `PreSync hook db-clone-${next.db.generation} re-copies the staging db on the next sync.`,
  };
}

export async function extendNamedEnv(
  deps: Pick<NamedEnvDeps, "gitops" | "now">,
  input: { name: string; ttlHours: number; actor: string },
) {
  const now = deps.now ?? (() => new Date());
  const { name } = input;
  if (!isValidName(name)) throw new Error(`invalid env name "${name}"`);
  if (!Number.isInteger(input.ttlHours) || input.ttlHours < TTL_HOURS.min || input.ttlHours > TTL_HOURS.max) {
    throw new Error(`ttlHours must be an integer in ${TTL_HOURS.min}..${TTL_HOURS.max}`);
  }
  const found = await findEnv(deps, name);
  if (!found) throw new Error(`env "${name}" does not exist`);
  const { manifest, path, sha } = found;
  const expiresAt = expiresAtFrom(now(), input.ttlHours);
  await deps.gitops.putFile(path, manifestToYaml({ ...manifest, expiresAt }), `nebula: extend env ${name} to ${expiresAt} (${input.actor})`, sha);
  return { name, previousExpiresAt: manifest.expiresAt, expiresAt };
}

export type ReleaseImage = { tag: string; aliases: string[]; pushedAt: string | undefined; digest: string | undefined };

/** Immutable build-* images for a service, newest first, with the floating
 * aliases (prod/latest/dev) that currently point at them. */
export async function listReleaseImages(
  deps: Pick<NamedEnvDeps, "images">,
  service: ServiceName,
  limit = 20,
): Promise<ReleaseImage[]> {
  const entry = SERVICES[service];
  if (!entry) throw new Error(`"${service}" has no release images (not a registry backend)`);
  const images = await deps.images.listImages(entry.ecrRepo);
  return images
    .map((i) => ({ i, tag: i.tags.find((t) => t.startsWith("build-") && IMAGE_TAG_RE.test(t)) }))
    .filter((x): x is { i: ImageInfo; tag: string } => !!x.tag)
    .sort((a, b) => (b.i.pushedAt?.getTime() ?? 0) - (a.i.pushedAt?.getTime() ?? 0))
    .slice(0, limit)
    .map(({ i, tag }) => ({
      tag,
      aliases: i.tags.filter((t) => t !== tag),
      pushedAt: i.pushedAt?.toISOString(),
      digest: i.digest,
    }));
}
