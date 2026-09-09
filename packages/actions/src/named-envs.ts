import { randomBytes } from "node:crypto";
import { Document as YamlDocument, parse as parseYaml, type Scalar } from "yaml";
import { PROVISIONABLE } from "./registry";

// ── Constants ─────────────────────────────────────────────────────────
// Everything a caller can influence is validated against these; secret names
// and ECR repos are DERIVED from `service`, never taken from input.

export const GITOPS = { owner: "TwizzyNicky", repo: "twizz-gitops", branch: "main", dir: "named-envs" } as const;
export const PREVIEW_DOMAIN = "prv.twizz.com";

export type ServiceName = "moly-backend";
/** Provisionable backends, derived from the registry (registry.ts). Kept as a
 * map for the callers that resolve `ecrRepo` / `sourceSecret` by service. */
export const SERVICES: Record<ServiceName, { ecrRepo: string; sourceSecret: string }> = Object.fromEntries(
  PROVISIONABLE.map((s) => [s.name, { ecrRepo: s.ecrRepo, sourceSecret: s.sourceSecret! }]),
) as Record<ServiceName, { ecrRepo: string; sourceSecret: string }>;
export const SERVICE_NAMES = Object.keys(SERVICES) as ServiceName[];

export const NAME_RE = /^[a-z][a-z0-9-]{2,23}$/;
export const IMAGE_TAG_RE = /^build-[0-9a-f-]{36}$/;
/** Floating tags CodeBuild re-points on every build — never a "release version". */
export const ALIAS_TAGS = new Set(["latest", "prod", "dev", "staging"]);
export const DEFAULT_MAX_NAMED_ENVS = 6;
export const TTL_HOURS = { min: 1, max: 336, default: 168 } as const;

export type DbMode = "isolated" | "clone";
export type EnvKind = "backend" | "frontend";

/** Manifest schema v2 (docs/NEBULA.md §N3.1). `frontendOrigin` (v1, single
 * string) is still accepted on read and mapped to a one-element list. */
export type NamedEnvManifest = {
  name: string;
  kind: EnvKind;
  service: ServiceName;
  owner: string;
  imageTag: string;
  expiresAt: string;
  db: { mode: DbMode; generation: number };
  /** Every browser origin the backend's ingress must accept (CORS). */
  frontendOrigins: string[];
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

export function envSecretName(service: ServiceName, name: string): string {
  return `${SERVICES[service].sourceSecret}/${name}`;
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

export function manifestPath(name: string): string {
  return `${GITOPS.dir}/${name}.yaml`;
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
  // Key order is the documented schema order (named-envs/README.md).
  const ordered = {
    name: m.name,
    kind: m.kind,
    service: m.service,
    owner: m.owner,
    imageTag: m.imageTag,
    expiresAt: m.expiresAt,
    db: { mode: m.db.mode, generation: m.db.generation },
    frontendOrigins: [...m.frontendOrigins],
  };
  const doc = new YamlDocument(ordered);
  // Quote the timestamp so no YAML 1.1 parser (Go's, on the Argo side) turns it
  // into a time value; matches the documented schema.
  (doc.get("expiresAt", true) as Scalar).type = "QUOTE_DOUBLE";
  return doc.toString({ lineWidth: 0 });
}

export function parseManifest(text: string): NamedEnvManifest {
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
  if (!(service in SERVICES)) throw new Error(`manifest: unknown service "${service}"`);
  const mode = str("db.mode", db.mode);
  if (mode !== "isolated" && mode !== "clone") throw new Error(`manifest: db.mode must be isolated|clone`);
  const generation = Number(db.generation);
  if (!Number.isInteger(generation) || generation < 1) throw new Error("manifest: db.generation must be a positive integer");
  const expiresAt = r.expiresAt instanceof Date ? r.expiresAt.toISOString() : str("expiresAt", r.expiresAt);
  const kind = r.kind === undefined ? "backend" : str("kind", r.kind);
  if (kind !== "backend" && kind !== "frontend") throw new Error(`manifest: kind must be backend|frontend`);
  // v2 list, else v1 single string, else none
  let frontendOrigins: string[];
  if (Array.isArray(r.frontendOrigins)) {
    frontendOrigins = r.frontendOrigins.map((o, i) => str(`frontendOrigins[${i}]`, o)).filter(Boolean);
  } else if (typeof r.frontendOrigin === "string" && r.frontendOrigin) {
    frontendOrigins = [r.frontendOrigin];
  } else {
    frontendOrigins = [];
  }
  return {
    name,
    kind,
    service: service as ServiceName,
    owner: str("owner", r.owner),
    imageTag: str("imageTag", r.imageTag),
    expiresAt,
    db: { mode, generation },
    frontendOrigins,
  };
}

// ── Ports (implemented in adapters.ts; faked in tests) ────────────────

export interface GitopsRepo {
  /** null when the path does not exist */
  getFile(path: string): Promise<{ content: string; sha: string } | null>;
  putFile(path: string, content: string, message: string, sha?: string): Promise<void>;
  deleteFile(path: string, message: string, sha: string): Promise<void>;
  listDir(path: string): Promise<string[]>;
}

export interface SecretStore {
  getJson(name: string): Promise<Record<string, string>>;
  createJson(name: string, value: Record<string, string>, tags: Record<string, string>): Promise<void>;
  /** Immediate, unrecoverable delete (ForceDeleteWithoutRecovery). */
  deleteNow(name: string): Promise<void>;
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

export async function listNamedEnvs(deps: Pick<NamedEnvDeps, "gitops">): Promise<NamedEnvManifest[]> {
  const files = (await deps.gitops.listDir(GITOPS.dir)).filter((f) => f.endsWith(".yaml"));
  const out: NamedEnvManifest[] = [];
  for (const f of files) {
    const file = await deps.gitops.getFile(`${GITOPS.dir}/${f}`);
    if (file) out.push(parseManifest(file.content));
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
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
  if (await deps.gitops.getFile(path)) throw new Error(`env "${name}" already exists (${path})`);

  const live = (await deps.gitops.listDir(GITOPS.dir)).filter((f) => f.endsWith(".yaml")).length;
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
 * the db) and the per-env secret. The `env-<name>` NAMESPACE is not deleted
 * by Argo and is not touched here (no kube API in this package) — the reaper
 * removes it. */
export async function teardownNamedEnv(deps: Pick<NamedEnvDeps, "gitops" | "secrets">, input: { name: string; actor: string }) {
  const { name } = input;
  if (!isValidName(name)) throw new Error(`invalid env name "${name}"`);
  const path = manifestPath(name);
  const file = await deps.gitops.getFile(path);
  if (!file) throw new Error(`env "${name}" does not exist (${path})`);
  const manifest = parseManifest(file.content);
  const secretName = envSecretName(manifest.service, name);

  await deps.gitops.deleteFile(path, `nebula: teardown env ${name} (${input.actor})`, file.sha);
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
    secret: secretName,
    secretDeleted,
    ...(secretError ? { secretError } : {}),
    note: `Argo CD prunes env-${name}; the PostDelete hook drops ${envDbName(name)}. Namespace env-${name} is reaped separately.`,
  };
}

export async function cloneStagingDb(deps: Pick<NamedEnvDeps, "gitops">, input: { name: string; actor: string }) {
  const { name } = input;
  if (!isValidName(name)) throw new Error(`invalid env name "${name}"`);
  const path = manifestPath(name);
  const file = await deps.gitops.getFile(path);
  if (!file) throw new Error(`env "${name}" does not exist (${path})`);
  const manifest = parseManifest(file.content);
  const next: NamedEnvManifest = { ...manifest, db: { mode: "clone", generation: manifest.db.generation + 1 } };
  await deps.gitops.putFile(path, manifestToYaml(next), `nebula: re-clone db for env ${name} -> generation ${next.db.generation} (${input.actor})`, file.sha);
  return {
    name,
    source: SERVICES[manifest.service].sourceSecret,
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
  const path = manifestPath(name);
  const file = await deps.gitops.getFile(path);
  if (!file) throw new Error(`env "${name}" does not exist (${path})`);
  const manifest = parseManifest(file.content);
  const expiresAt = expiresAtFrom(now(), input.ttlHours);
  await deps.gitops.putFile(path, manifestToYaml({ ...manifest, expiresAt }), `nebula: extend env ${name} to ${expiresAt} (${input.actor})`, file.sha);
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
  const repo = SERVICES[service].ecrRepo;
  const images = await deps.images.listImages(repo);
  return images
    .map((i) => ({ i, tag: i.tags.find((t) => IMAGE_TAG_RE.test(t)) }))
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
