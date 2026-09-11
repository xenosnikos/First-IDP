// Build-on-provision named envs (docs/NEBULA.md §N3.7): any twizz-app repo at
// any commit → the central builder → a pending manifest the watcher promotes.
// Same ports as named-envs.ts plus a BuildDispatcher and, for the GitHub side
// (branches, config PRs), an Octokit on the platform token.
import type { Octokit } from "@octokit/rest";
import { substituteBuildArgs, type TwizzYamlV2 } from "@twizz-idp/shared";
import {
  DEFAULT_MAX_NAMED_ENVS,
  GITOPS,
  TTL_HOURS,
  countEnvs,
  deriveEnvSecret,
  envDbName,
  envHost,
  envSecretName,
  envValuesPath,
  expiresAtFrom,
  findEnv,
  freshTokenSecret,
  isValidName,
  manifestPath,
  manifestToYaml,
  nebulaTag,
  normalizeOrigins,
  resolveService,
  rewriteMongoDb,
  serviceValuesPath,
  toLabelValue,
  type BuildDispatcher,
  type DbMode,
  type EnvKind,
  type FileChange,
  type NamedEnvDeps,
  type NamedEnvManifest,
} from "./named-envs";
import { envValuesYaml, serviceValuesYaml } from "./values";

export const SHA_RE = /^[0-9a-f]{40}$/;
export const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const BRANCH_RE = /^(?!\/)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._\/-]{1,120}(?<!\/)(?<!\.lock)$/;
export const ORG = "twizz-app";
/** Platform-level defaults for generic services (MONGO_URI host of nonprod Atlas). */
export const DEFAULTS_SECRET = "preview/_defaults";

export type EnvFromRepoDeps = NamedEnvDeps & { builds: BuildDispatcher };

export type CreateEnvFromRepoInput = {
  name: string;
  /** owner/name, must be in the org */
  repo: string;
  ref: string;
  sha: string;
  kind: EnvKind;
  db: DbMode;
  ttlHours: number;
  config: TwizzYamlV2;
  /** Values the human typed for `config.secrets` + extra env; SM only, never git. */
  envVars: Record<string, string>;
  attachTo?: string;
  /** Frontend envs need the backend's URL; backends need nothing. */
  attachUrl?: string;
  prNumber?: number;
  prUrl?: string;
  actor: string;
};

export function isValidRepo(repo: string): boolean {
  return REPO_RE.test(repo) && repo.toLowerCase().startsWith(`${ORG}/`);
}

export function isValidBranch(name: string): boolean {
  return BRANCH_RE.test(name);
}

/** The per-env config blob for a generic service. Every key becomes a pod env
 * var through the chart's ExternalSecret (envFrom). */
export function genericEnvSecret(o: {
  name: string;
  port: number;
  needsMongo: boolean;
  defaults: Record<string, string>;
  envVars: Record<string, string>;
}): Record<string, string> {
  const url = `https://${envHost(o.name)}`;
  const out: Record<string, string> = {
    NODE_ENV: "production",
    PORT: String(o.port),
    HTTP_PORT: String(o.port),
    APP_URL: url,
    BASE_URL: url,
    REDIS_HOST: "redis",
    REDIS_PORT: "6379",
    REDIS_URL: "redis://redis:6379",
    TOKEN_SECRET: freshTokenSecret(),
  };
  if (o.needsMongo) {
    if (!o.defaults.MONGO_URI) throw new Error(`${DEFAULTS_SECRET} has no MONGO_URI; the service declares needs.mongo`);
    out.MONGO_URI = rewriteMongoDb(o.defaults.MONGO_URI, envDbName(o.name));
  }
  for (const [k, v] of Object.entries(o.envVars)) if (v !== "") out[k] = v;
  return out;
}

export async function createEnvFromRepo(deps: EnvFromRepoDeps, input: CreateEnvFromRepoInput) {
  const now = deps.now ?? (() => new Date());
  const { name, repo, ref, sha } = input;
  if (!isValidName(name)) throw new Error(`invalid env name "${name}"`);
  if (!isValidRepo(repo)) throw new Error(`repo must be ${ORG}/<name>, got "${repo}"`);
  if (!isValidBranch(ref)) throw new Error(`invalid ref "${ref}"`);
  if (!SHA_RE.test(sha)) throw new Error("sha must be a 40-hex commit id");
  if (!Number.isInteger(input.ttlHours) || input.ttlHours < TTL_HOURS.min || input.ttlHours > TTL_HOURS.max) {
    throw new Error(`ttlHours must be an integer in ${TTL_HOURS.min}..${TTL_HOURS.max}`);
  }
  if (input.attachTo && !isValidName(input.attachTo)) throw new Error(`invalid attachTo "${input.attachTo}"`);
  if (input.kind === "frontend" && !input.attachUrl) throw new Error("frontend envs need attachUrl (the API they are built against)");
  const svc = resolveService(repo);
  if (input.db === "clone" && !svc.legacyBoot) throw new Error("db=clone is only available for moly-backend");
  if (input.db !== "none" && !(input.config.needs.mongo || svc.legacyBoot)) throw new Error("db must be none unless twizz.yaml declares needs.mongo");
  for (const k of Object.keys(input.envVars)) if (!/^[A-Z][A-Z0-9_]*$/.test(k)) throw new Error(`env var "${k}" must be UPPER_SNAKE_CASE`);

  if (await findEnv(deps, name)) throw new Error(`env "${name}" already exists`);
  const live = await countEnvs(deps);
  const max = deps.maxNamedEnvs ?? DEFAULT_MAX_NAMED_ENVS;
  if (live >= max) throw new Error(`named-env cap reached (${live}/${max}); tear one down first`);

  // 1. the per-env secret (SM only)
  const secretName = envSecretName(svc.service, name);
  const frontendOrigins = input.kind === "backend" ? normalizeOrigins(undefined, `https://${name}-frontend.prv.twizz.com`) : [];
  let blob: Record<string, string>;
  if (svc.legacyBoot) {
    const base = await deps.secrets.getJson(`preview/${svc.service}`);
    blob = { ...deriveEnvSecret(base, { name, frontendOrigin: frontendOrigins[0] ?? `https://${envHost(name)}`, tokenSecret: freshTokenSecret() }), ...input.envVars };
  } else {
    const defaults = input.config.needs.mongo ? await deps.secrets.getJson(DEFAULTS_SECRET) : {};
    blob = genericEnvSecret({ name, port: input.config.port, needsMongo: input.config.needs.mongo, defaults, envVars: input.envVars });
  }
  await deps.secrets.createJson(secretName, blob, { "nebula-env": name, "nebula-service": svc.service });

  // 2. one commit: service values (once), env values, pending manifest, attach
  const buildArgs = substituteBuildArgs(input.config.build.args, { apiUrl: input.attachUrl ?? "", socketUrl: input.attachUrl, envUrl: `https://${envHost(name)}` });
  const expectedTag = nebulaTag(name, sha);
  const startedAt = now().toISOString();
  const manifest: NamedEnvManifest = {
    name,
    kind: input.kind,
    service: svc.service,
    owner: toLabelValue(input.actor),
    expiresAt: expiresAtFrom(now(), input.ttlHours),
    db: { mode: svc.legacyBoot ? input.db : input.config.needs.mongo ? "isolated" : "none", generation: input.db === "clone" ? 1 : input.db === "isolated" || input.config.needs.mongo ? 1 : 0 },
    frontendOrigins,
    source: { repo, ref, sha, ...(input.prNumber != null ? { prNumber: input.prNumber } : {}), ...(input.prUrl ? { prUrl: input.prUrl } : {}) },
    build: { status: "PENDING", expectedTag, startedAt },
    config: {
      port: input.config.port,
      healthPath: input.config.healthPath,
      rev: 1,
      envVarNames: Object.keys(input.envVars).sort(),
      dockerfile: input.config.dockerfile,
      context: input.config.context,
      buildArgs,
    },
    ...(input.attachTo ? { attachTo: input.attachTo } : {}),
  };
  const changes: FileChange[] = [];
  if (!(await deps.gitops.getFile(serviceValuesPath(svc.service)))) {
    changes.push({ path: serviceValuesPath(svc.service), content: serviceValuesYaml({ service: svc.service, ecrRepo: svc.ecrRepo, kind: input.kind }) });
  }
  changes.push({ path: envValuesPath(svc.service, name), content: envValuesYaml({ name, port: input.config.port, healthPath: input.config.healthPath, env: input.config.env, kind: input.kind }) });
  changes.push({ path: manifestPath(name, true), content: manifestToYaml(manifest) });
  if (input.attachTo) {
    const backend = await findEnv(deps, input.attachTo);
    if (!backend || backend.pending) throw new Error(`attachTo "${input.attachTo}" is not a deployed env`);
    const origin = `https://${envHost(name)}`;
    if (!backend.manifest.frontendOrigins.includes(origin)) {
      changes.push({ path: backend.path, content: manifestToYaml({ ...backend.manifest, frontendOrigins: [...backend.manifest.frontendOrigins, origin] }) });
    }
  }
  await deps.gitops.commit(changes, `nebula: create env ${name} from ${repo}@${ref} (${input.actor})`);

  // 3. the build
  const buildInputs = { repo: repo.split("/")[1], ref, sha, service: svc.service, envName: name, dockerfile: input.config.dockerfile, context: input.config.context, buildArgs };
  try {
    await deps.builds.dispatch(buildInputs);
  } catch (e) {
    const failed: NamedEnvManifest = { ...manifest, build: { ...manifest.build!, status: "FAIL", finishedAt: now().toISOString(), reason: `dispatch: ${String((e as Error).message ?? e)}` } };
    await deps.gitops.commit([{ path: manifestPath(name, true), content: manifestToYaml(failed) }], `nebula: build dispatch failed for ${name}`);
    throw e;
  }
  return {
    name,
    url: `https://${envHost(name)}`,
    pending: true as const,
    service: svc.service,
    expectedTag,
    secret: secretName,
    displayTitle: deps.builds.displayTitle({ envName: name, service: svc.service, sha }),
    manifest,
  };
}

/** Re-dispatch the builder for a deployed or failed env at a (new) commit. */
export async function rebuildEnv(deps: EnvFromRepoDeps, input: { name: string; sha?: string; actor: string }) {
  const now = deps.now ?? (() => new Date());
  const found = await findEnv(deps, input.name);
  if (!found) throw new Error(`env "${input.name}" does not exist`);
  const m = found.manifest;
  if (!m.source || !m.config) throw new Error(`env "${input.name}" was not built by Nebula (no source); use the release-image path`);
  const sha = input.sha ?? m.source.sha;
  if (!SHA_RE.test(sha)) throw new Error("sha must be a 40-hex commit id");
  const expectedTag = nebulaTag(m.name, sha);
  const next: NamedEnvManifest = {
    ...m,
    source: { ...m.source, sha },
    build: { status: "PENDING", expectedTag, startedAt: now().toISOString() },
  };
  delete next.imageTag;
  // The deployable manifest (if any) stays: the running env keeps its image
  // until the watcher promotes the new build over it.
  await deps.gitops.commit([{ path: manifestPath(m.name, true), content: manifestToYaml(next) }], `nebula: rebuild ${m.name} at ${sha.slice(0, 7)} (${input.actor})`);
  const service = m.service;
  await deps.builds.dispatch({
    repo: m.source.repo.split("/")[1],
    ref: m.source.ref,
    sha,
    service,
    envName: m.name,
    dockerfile: m.config.dockerfile ?? "Dockerfile",
    context: m.config.context ?? ".",
    buildArgs: m.config.buildArgs ?? {},
  });
  return { name: m.name, expectedTag, displayTitle: deps.builds.displayTitle({ envName: m.name, service, sha }) };
}

/** Edit the env's SM blob and bump config.rev so the pods roll. */
export async function setEnvVars(deps: Pick<NamedEnvDeps, "gitops" | "secrets">, input: { name: string; vars: Record<string, string>; actor: string }) {
  const found = await findEnv(deps, input.name);
  if (!found) throw new Error(`env "${input.name}" does not exist`);
  const m = found.manifest;
  for (const k of Object.keys(input.vars)) if (!/^[A-Z][A-Z0-9_]*$/.test(k)) throw new Error(`env var "${k}" must be UPPER_SNAKE_CASE`);
  const secretName = envSecretName(m.service, m.name);
  const current = await deps.secrets.getJson(secretName);
  const merged = { ...current };
  for (const [k, v] of Object.entries(input.vars)) {
    if (v === "") delete merged[k];
    else merged[k] = v;
  }
  await deps.secrets.putJson(secretName, merged);
  const names = [...new Set([...(m.config?.envVarNames ?? []), ...Object.keys(input.vars).filter((k) => input.vars[k] !== "")])].filter((k) => merged[k] !== undefined).sort();
  const next: NamedEnvManifest = { ...m, config: { port: m.config?.port ?? 8080, healthPath: m.config?.healthPath ?? "/health", rev: (m.config?.rev ?? 0) + 1, envVarNames: names } };
  await deps.gitops.putFile(found.path, manifestToYaml(next), `nebula: env vars rev ${next.config!.rev} for ${m.name} (${input.actor})`, found.sha);
  return { name: m.name, rev: next.config!.rev, envVarNames: names };
}

// ── GitHub side: branches and the config PR (platform token) ─────────

export type ConfigPrInput = {
  repo: string;
  /** The human's chosen branch: the PR targets it. */
  base: string;
  /** Branch Nebula commits to (nebula/<env>); created off `base` if absent. */
  branch: string;
  files: Record<string, string>;
  title: string;
  body: string;
};

export async function createBranch(gh: Octokit, input: { repo: string; from: string; name: string }): Promise<{ sha: string; created: boolean }> {
  if (!isValidRepo(input.repo)) throw new Error(`repo must be ${ORG}/<name>`);
  if (!isValidBranch(input.name) || !isValidBranch(input.from)) throw new Error("invalid branch name");
  const [owner, repo] = input.repo.split("/");
  const { data: fromRef } = await gh.git.getRef({ owner, repo, ref: `heads/${input.from}` });
  try {
    await gh.git.getRef({ owner, repo, ref: `heads/${input.name}` });
    throw new Error(`branch "${input.name}" already exists in ${input.repo}`);
  } catch (e) {
    if ((e as { status?: number }).status !== 404) throw e;
  }
  await gh.git.createRef({ owner, repo, ref: `refs/heads/${input.name}`, sha: fromRef.object.sha });
  return { sha: fromRef.object.sha, created: true };
}

/** Commit files on `branch` (off `base`'s head if the branch is new) and open a
 * PR targeting `base`. Ported from packages/onboard openPr(), parameterised. */
export async function openConfigPr(gh: Octokit, input: ConfigPrInput): Promise<{ prNumber: number; prUrl: string; headSha: string; branch: string }> {
  if (!isValidRepo(input.repo)) throw new Error(`repo must be ${ORG}/<name>`);
  if (!isValidBranch(input.base) || !isValidBranch(input.branch)) throw new Error("invalid branch name");
  if (Object.keys(input.files).length === 0) throw new Error("no files to commit");
  const [owner, repo] = input.repo.split("/");
  const { data: baseRef } = await gh.git.getRef({ owner, repo, ref: `heads/${input.base}` });
  let parentSha = baseRef.object.sha;
  let branchExists = false;
  try {
    const { data: r } = await gh.git.getRef({ owner, repo, ref: `heads/${input.branch}` });
    parentSha = r.object.sha;
    branchExists = true;
  } catch (e) {
    if ((e as { status?: number }).status !== 404) throw e;
  }
  const tree = await Promise.all(
    Object.entries(input.files).map(async ([path, content]) => ({
      path,
      mode: "100644" as const,
      type: "blob" as const,
      sha: (await gh.git.createBlob({ owner, repo, content, encoding: "utf-8" })).data.sha,
    })),
  );
  const { data: newTree } = await gh.git.createTree({ owner, repo, base_tree: parentSha, tree });
  const { data: commit } = await gh.git.createCommit({ owner, repo, message: input.title, tree: newTree.sha, parents: [parentSha] });
  if (branchExists) await gh.git.updateRef({ owner, repo, ref: `heads/${input.branch}`, sha: commit.sha });
  else await gh.git.createRef({ owner, repo, ref: `refs/heads/${input.branch}`, sha: commit.sha });
  const { data: pr } = await gh.pulls.create({ owner, repo, title: input.title, head: input.branch, base: input.base, body: input.body });
  return { prNumber: pr.number, prUrl: pr.html_url, headSha: commit.sha, branch: input.branch };
}

export function configPrBody(o: { env: string; url: string; repo: string; ref: string; files: string[]; actor: string; notes?: string[] }): string {
  return [
    `Nebula wrote the per-repo config for the preview environment **${o.env}** (${o.url}).`,
    "",
    `- Source: \`${o.repo}\` @ \`${o.ref}\``,
    `- Files: ${o.files.map((f) => `\`${f}\``).join(", ")}`,
    `- Requested by: ${o.actor}`,
    "",
    "The preview builds from this branch's head right away; merging keeps the config for everyone but is not required for the preview to run.",
    ...(o.notes?.length ? ["", "Notes from the Configurator:", ...o.notes.map((n) => `- ${n}`)] : []),
    "",
    "Nebula · docs/NEBULA.md §N3.7",
  ].join("\n");
}

export { GITOPS as GITOPS_REPO };
