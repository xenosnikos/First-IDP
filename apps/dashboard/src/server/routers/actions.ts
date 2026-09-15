import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  SERVICES,
  SERVICE_NAMES,
  TTL_HOURS,
  NAME_RE,
  IMAGE_TAG_RE,
  ORG,
  cloneStagingDb,
  createBranch,
  createEnvFromRepo,
  createNamedEnv,
  configPrBody,
  envHost,
  envSecretName,
  extendNamedEnv,
  findEnv,
  hashFiles,
  hashVars,
  isValidBranch,
  isValidRepo,
  listNamedEnvs,
  listReleaseImages,
  nameList,
  openConfigPr,
  parseTwizzYaml,
  rebuildEnv,
  resolveService,
  setEnvVars,
  teardownNamedEnv,
  toLabelValue,
  type GateResult,
  type NamedEnvManifest,
} from "@twizz-idp/actions";
import { ENV_KEY_RE, SECRET_SHAPE_RE } from "@twizz-idp/shared";
import type { PrismaClient } from "@twizz-idp/db";
import { router, protectedProcedure } from "../trpc";
import { isOperator } from "@/lib/nebula/operators";
import { argoWord, ttlWord } from "@/lib/nebula/status";
import { gateFor, namedEnvDeps, octokit } from "../nebula/deps";
import { argoStatusFor, readArgoApplications } from "../nebula/argo";

// The Nebula write path (docs/NEBULA.md §4.2, §4.7, §N3.7). Every mutation here:
//   protectedProcedure (signed-in org member)
//   → who may: operator allowlist (NEBULA_OPERATORS) for the release-image path
//     and clone-staging-db; OWNER-OR-OPERATOR for teardown/extend/env-vars/rebuild;
//     ANY signed-in user for build-on-provision (self-service) — denials audited
//   → @twizz-idp/actions gate: policy.yaml → Prisma nonce (two-step) → action → AuditLog
// The client never fabricates a nonce for different args: the nonce is
// fingerprinted to (tool, fields) server-side and is single-use. Secret VALUES
// never enter fields, summaries, audit rows, results, or git.

function loginOf(session: unknown): string {
  const login = (session as { login?: string } | null)?.login;
  if (!login) throw new TRPCError({ code: "UNAUTHORIZED", message: "no GitHub login on session" });
  return login;
}

async function auditDenial(prisma: PrismaClient, login: string, tool: string, reason: string, resource?: string) {
  await prisma.auditLog.create({ data: { actor: login, action: `nebula.${tool}`, resource, allowed: false, detail: { reason } } }).catch(() => {});
}

const operatorProcedure = protectedProcedure.use(async ({ ctx, next, path }) => {
  const login = loginOf(ctx.session);
  if (!isOperator(login)) {
    await auditDenial(ctx.prisma, login, path.split(".").pop()!, "not a Nebula operator (NEBULA_OPERATORS)");
    throw new TRPCError({ code: "FORBIDDEN", message: "READ-ONLY: your GitHub login is not in NEBULA_OPERATORS" });
  }
  return next({ ctx: { ...ctx, login } });
});

const loginProcedure = protectedProcedure.use(async ({ ctx, next }) => next({ ctx: { ...ctx, login: loginOf(ctx.session) } }));

/** Owner-or-operator: the env's manifest `owner` (a label value of the
 * GitHub login) or an operator. Anyone else is refused BEFORE the gate, and
 * the refusal is audited like every other denial. */
async function ownedEnv(ctx: { prisma: PrismaClient; login: string }, tool: string, name: string): Promise<{ manifest: NamedEnvManifest; pending: boolean }> {
  const found = await findEnv(namedEnvDeps(), name);
  if (!found) throw new TRPCError({ code: "NOT_FOUND", message: `env "${name}" does not exist` });
  const owner = found.manifest.owner.toLowerCase() === toLabelValue(ctx.login).toLowerCase();
  if (!owner && !isOperator(ctx.login)) {
    await auditDenial(ctx.prisma, ctx.login, tool, `not the owner (${found.manifest.owner}) and not a Nebula operator`, name);
    throw new TRPCError({ code: "FORBIDDEN", message: `DENIED: '${name}' belongs to ${found.manifest.owner}; only its owner or a Nebula operator may do this` });
  }
  return { manifest: found.manifest, pending: found.pending };
}

const confirmSchema = z.string().min(8).max(64).optional();
const envName = z.string().regex(NAME_RE, "DNS label: ^[a-z][a-z0-9-]{2,23}$");
const serviceSchema = z.enum(SERVICE_NAMES as [string, ...string[]]);
const ttlSchema = z.number().int().min(TTL_HOURS.min).max(TTL_HOURS.max);
const branchSchema = z.string().max(120).refine(isValidBranch, "invalid git branch name");
const shaSchema = z.string().regex(/^[0-9a-f]{40}$/, "40-hex commit sha");
const envKey = z.string().regex(ENV_KEY_RE, "UPPER_SNAKE_CASE");
const varsSchema = z.record(envKey, z.string().max(8000));
const attachSchema = z.union([z.object({ env: envName }), z.object({ url: z.string().url().max(300) })]).optional();

/** The gate result goes to the client as-is (nonce travels as `confirm`). */
function shape(r: GateResult): GateResult {
  return r;
}

const CONFIG_FILE = "twizz.yaml";
const FILE_CAP = 64 * 1024;

export const actionsRouter = router({
  /** Who am I to Nebula: read-only or operator. */
  me: protectedProcedure.query(({ ctx }) => {
    const login = loginOf(ctx.session);
    return { login, operator: isOperator(login), ownerLabel: toLabelValue(login), stagingApiUrl: process.env.NEBULA_STAGING_API_URL || null };
  }),

  /** The Environments grid: every named-env manifest in twizz-gitops,
   * enriched with live Argo Application health read in-cluster. */
  listEnvs: protectedProcedure.query(async () => {
    const now = new Date();
    const [list, argo] = await Promise.all([listNamedEnvs(namedEnvDeps()), readArgoApplications()]);
    return {
      argo: { reachable: argo.reachable, reason: argo.reason },
      pending: list.pending,
      broken: list.broken,
      envs: list.envs.map((m) => {
        const appName = `env-${m.name}`;
        const status = argoStatusFor(argo, appName);
        return {
          ...m,
          url: `https://${m.name}.prv.twizz.com`,
          argoApp: appName,
          namespace: appName,
          dbName: `nebula_${m.name}`,
          secret: envSecretName(m.service, m.name),
          argo: { ...status, ...argoWord(status) },
          ttl: ttlWord(m.expiresAt, now),
        };
      }),
    };
  }),

  /** Existing release images (immutable ECR build-* tags) with their aliases. */
  listReleaseImages: protectedProcedure
    .input(z.object({ service: serviceSchema.default("moly-backend"), limit: z.number().int().min(1).max(50).default(20) }))
    .query(async ({ input }) => {
      const images = await listReleaseImages({ images: namedEnvDeps().images }, input.service, input.limit);
      return { service: input.service, images };
    }),

  // ── Release-image path (moly-backend; operators) ───────────────────────

  createNamedEnv: operatorProcedure
    .input(
      z.object({
        name: envName,
        service: serviceSchema,
        imageTag: z.string().regex(IMAGE_TAG_RE, "immutable ECR build-* tag (never latest/prod/dev)"),
        db: z.enum(["isolated", "clone"]),
        ttlHours: ttlSchema.default(TTL_HOURS.default),
        frontendOrigins: z.array(z.string().url()).max(10).optional(),
        confirm: confirmSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { name, service, imageTag, db, ttlHours, frontendOrigins, confirm } = input;
      const fields = { name, service, imageTag, db, ttlHours: String(ttlHours), frontendOrigins: (frontendOrigins ?? []).join(" ") };
      const summary = `Create named env '${name}' (${service}:${imageTag}, db=${db}, ttl=${ttlHours}h) -> https://${name}.prv.twizz.com; writes secret ${envSecretName(service, name)} + named-envs/${name}.yaml`;
      const gate = gateFor(ctx.prisma, ctx.login);
      return shape(
        await gate("create_named_env", fields, confirm, summary, () =>
          createNamedEnv(namedEnvDeps(), { name, service, imageTag, db, ttlHours, frontendOrigins, actor: ctx.login }),
        ),
      );
    }),

  cloneStagingDb: operatorProcedure
    .input(z.object({ name: envName, confirm: confirmSchema }))
    .mutation(async ({ ctx, input }) => {
      const { name, confirm } = input;
      // `source` is derived server-side and policy-pinned; never an input.
      const fields = { name, source: SERVICES["moly-backend"].sourceSecret };
      const gate = gateFor(ctx.prisma, ctx.login);
      return shape(
        await gate("clone_staging_db", fields, confirm, `Re-clone staging db (${fields.source}) into nebula_${name} (bumps db.generation)`, () =>
          cloneStagingDb(namedEnvDeps(), { name, actor: ctx.login }),
        ),
      );
    }),

  // ── Owner-or-operator ─────────────────────────────────────────────────

  teardownNamedEnv: loginProcedure
    .input(z.object({ name: envName, confirm: confirmSchema }))
    .mutation(async ({ ctx, input }) => {
      const { name, confirm } = input;
      const { manifest, pending } = await ownedEnv(ctx, "teardown_named_env", name);
      const gate = gateFor(ctx.prisma, ctx.login);
      const what = pending ? "pending manifest + values + secret; the build result is discarded" : "manifest + values + secret; app pruned, db dropped";
      return shape(
        await gate("teardown_named_env", { name }, confirm, `Tear down named env '${name}' (${manifest.service}, owner ${manifest.owner}): ${what}`, () =>
          teardownNamedEnv(namedEnvDeps(), { name, actor: ctx.login }),
        ),
      );
    }),

  extendNamedEnv: loginProcedure
    .input(z.object({ name: envName, ttlHours: ttlSchema.default(TTL_HOURS.default), confirm: confirmSchema }))
    .mutation(async ({ ctx, input }) => {
      const { name, ttlHours, confirm } = input;
      await ownedEnv(ctx, "extend_named_env", name);
      const gate = gateFor(ctx.prisma, ctx.login);
      return shape(
        await gate("extend_named_env", { name, ttlHours: String(ttlHours) }, confirm, `Extend named env '${name}' by ${ttlHours}h from now`, () =>
          extendNamedEnv(namedEnvDeps(), { name, ttlHours, actor: ctx.login }),
        ),
      );
    }),

  /** Edit the env's runtime env vars (SM blob) — values ride only in the
   * request body; the gate sees names + a hash, the audit row the same. */
  setEnvVars: loginProcedure
    .input(z.object({ name: envName, vars: varsSchema.refine((v) => Object.keys(v).length > 0 && Object.keys(v).length <= 50, "1..50 vars"), confirm: confirmSchema }))
    .mutation(async ({ ctx, input }) => {
      const { name, vars, confirm } = input;
      const { manifest } = await ownedEnv(ctx, "set_env_vars", name);
      const names = Object.keys(vars);
      const deleted = names.filter((k) => vars[k] === "");
      const fields = { name, varNames: nameList(names), varsHash: hashVars(vars) };
      const summary = [
        `Set ${names.length} env var${names.length === 1 ? "" : "s"} on '${name}' (${manifest.service}): ${nameList(names.filter((k) => vars[k] !== ""))}${deleted.length ? `; delete ${nameList(deleted)}` : ""}`,
        `- write secret ${envSecretName(manifest.service, name)} (values are not shown or logged)`,
        `- bump config.rev in the manifest so the pods roll (ExternalSecret refresh 1 min + Argo sync)`,
      ].join("\n");
      const gate = gateFor(ctx.prisma, ctx.login);
      return shape(await gate("set_env_vars", fields, confirm, summary, () => setEnvVars(namedEnvDeps(), { name, vars, actor: ctx.login })));
    }),

  /** Re-dispatch the builder at the CURRENT head of the env's source branch.
   * The head sha is resolved on both calls and bound by the nonce, so a push
   * between review and confirm is refused rather than built silently. */
  rebuildFromRef: loginProcedure
    .input(z.object({ name: envName, confirm: confirmSchema }))
    .mutation(async ({ ctx, input }) => {
      const { name, confirm } = input;
      const { manifest } = await ownedEnv(ctx, "rebuild_env", name);
      if (!manifest.source) throw new TRPCError({ code: "BAD_REQUEST", message: `'${name}' was not built by Nebula (no source); use the release-image path` });
      const [owner, repo] = manifest.source.repo.split("/");
      const head = await octokit().git.getRef({ owner, repo, ref: `heads/${manifest.source.ref}` }).then((r) => r.data.object.sha);
      const fields = { name, sha: head };
      const same = head === manifest.source.sha;
      const summary = [
        `Rebuild '${name}' from ${manifest.source.repo}@${manifest.source.ref} at ${head.slice(0, 7)}${same ? " (same commit as now: the builder will skip if the image exists)" : ` (currently ${manifest.source.sha.slice(0, 7)})`}`,
        `- write named-envs/pending/${name}.yaml with build PENDING (the running env keeps its image until the new build is promoted)`,
        `- dispatch nebula-build.yml (tag nb-${name}-${head.slice(0, 12)})`,
      ].join("\n");
      const gate = gateFor(ctx.prisma, ctx.login);
      return shape(await gate("rebuild_env", fields, confirm, summary, () => rebuildEnv(namedEnvDeps(), { name, sha: head, actor: ctx.login })));
    }),

  // ── Build-on-provision: any twizz-app repo/branch, self-service ───────

  createEnvFromRepo: loginProcedure
    .input(
      z.object({
        name: envName,
        repo: z.string().max(200).refine(isValidRepo, `repo must be ${ORG}/<name>`),
        /** The chosen branch (existing, or the one to create). */
        ref: branchSchema,
        /** Head of `ref` (or of `newBranch.from`) pinned when the human picked it. */
        sha: shaSchema,
        newBranch: z.object({ from: branchSchema }).optional(),
        /** The repo's default branch; used for prTarget "chosen+default". */
        defaultBranch: branchSchema.optional(),
        db: z.enum(["isolated", "clone", "none"]).default("none"),
        ttlHours: ttlSchema.default(TTL_HOURS.default),
        attach: attachSchema,
        /** twizz.yaml (+ optional Dockerfile) to commit; empty = the branch already has them. */
        files: z.array(z.object({ path: z.string().min(1).max(200).regex(/^[A-Za-z0-9_./-]+$/).refine((p) => !p.includes("..") && !p.startsWith("/"), "relative path"), content: z.string().max(FILE_CAP) })).max(2),
        /** The exact twizz.yaml text the env is created from (validated server-side). */
        twizzYaml: z.string().min(1).max(FILE_CAP),
        secretNames: z.array(envKey).max(50).default([]),
        /** Confirm call only. */
        secretValues: z.record(envKey, z.string().max(8000)).optional(),
        envOverrides: varsSchema.default({}),
        prTarget: z.enum(["chosen", "chosen+default"]).default("chosen"),
        confirm: confirmSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { name, repo, ref, sha, newBranch, defaultBranch, ttlHours, attach, files, twizzYaml, envOverrides, prTarget, confirm } = input;
      const bad = (message: string) => new TRPCError({ code: "BAD_REQUEST", message });

      // 1. the config is parsed from the exact bytes on BOTH calls; invalid → refused before the gate
      const parsed = parseTwizzYaml(twizzYaml);
      if (!parsed.ok) throw bad(`twizz.yaml: ${parsed.issues.slice(0, 5).join("; ")}`);
      const config = parsed.config;
      const svc = resolveService(repo);
      const secretNames = [...new Set([...config.secrets, ...input.secretNames])].sort();
      const configFile = files.find((f) => f.path === CONFIG_FILE);
      if (configFile && configFile.content !== twizzYaml) throw bad("files[twizz.yaml] must be the same bytes as twizzYaml");
      if (files.length > 0 && !configFile) throw bad("when files are committed, twizz.yaml must be one of them");
      const dockerfilePath = `${config.context === "." ? "" : config.context.replace(/\/$/, "") + "/"}${config.dockerfile}`;
      for (const f of files) if (f.path !== CONFIG_FILE && f.path !== dockerfilePath) throw bad(`unexpected file ${f.path}; only twizz.yaml and ${dockerfilePath} may be committed`);
      for (const [k, v] of Object.entries(envOverrides)) {
        if (SECRET_SHAPE_RE.test(v)) throw bad(`env override ${k} looks like a credential; declare it under secrets instead`);
        if (secretNames.includes(k)) throw bad(`${k} is both a secret name and an env override`);
      }
      if (newBranch && (ref === newBranch.from || ref === "main" || ref === "master")) throw bad("a new branch needs a new name (not main/master, not its base)");
      if (prTarget === "chosen+default" && !defaultBranch) throw bad("prTarget chosen+default needs defaultBranch");
      if (config.kind === "frontend" && !attach) throw bad("frontend envs must attach to a backend (a NAMED env or an API URL)");
      if (input.db === "clone" && !svc.legacyBoot) throw bad("db=clone is only available for moly-backend");
      const db = input.db === "none" && (config.needs.mongo || svc.legacyBoot) ? "isolated" : input.db;
      let attachTo: string | undefined;
      let attachUrl: string | undefined;
      if (attach && "env" in attach) {
        attachTo = attach.env;
        attachUrl = `https://${envHost(attach.env)}`;
      } else if (attach) {
        const u = new URL(attach.url);
        if (u.protocol !== "https:" || !u.hostname.endsWith(".twizz.com") || (u.pathname !== "/" && u.pathname !== "") || u.search) throw bad("attach.url must be an https://<host>.twizz.com origin");
        attachUrl = `https://${u.host}`;
      }

      // 2. secret values: refused on the request call, required (names must match) on the confirm call
      if (!confirm && input.secretValues !== undefined) throw bad("do not send secret values on the request call; they are accepted only with the confirm nonce");
      let secretValues: Record<string, string> = {};
      if (confirm) {
        secretValues = input.secretValues ?? {};
        const given = Object.keys(secretValues).sort();
        if (given.join(" ") !== secretNames.join(" ")) throw bad(`secretValues keys must be exactly the declared secret names (${secretNames.join(", ") || "none"}); blank = set later`);
      }

      // 3. fields: everything that shapes the effect, secrets as NAMES, files/env as hashes
      const prBranch = `nebula/${name}`;
      const fields = {
        name,
        repo,
        ref,
        sha,
        newBranch: newBranch ? ref : "",
        newBranchFrom: newBranch?.from ?? "",
        kind: config.kind,
        service: svc.service,
        db,
        ttlHours: String(ttlHours),
        attach: attachTo ?? attachUrl ?? "",
        files: files.map((f) => f.path).sort().join(" "),
        filesHash: hashFiles(files),
        secretNames: secretNames.join(" "),
        envHash: hashVars(envOverrides),
        prTarget: files.length ? prTarget : "none",
      };
      const url = `https://${envHost(name)}`;
      const lines = [
        `Create preview env '${name}' (${config.kind} ${svc.service}) from ${repo}@${ref}${newBranch ? ` (NEW branch off ${newBranch.from}@${sha.slice(0, 7)})` : `@${sha.slice(0, 7)}`} -> ${url}`,
        ...(newBranch ? [`- create branch ${ref} in ${repo} from ${newBranch.from}@${sha.slice(0, 7)}`] : []),
        ...(files.length
          ? [
              `- commit ${files.map((f) => f.path).join(" + ")} on ${prBranch} (off ${ref}) and open a PR -> ${ref}${prTarget === "chosen+default" && defaultBranch && defaultBranch !== ref ? ` and a second PR -> ${defaultBranch}` : ""}`,
              `- build from ${prBranch}'s head (the preview does not wait for the merge)`,
            ]
          : [`- no config PR: ${ref} already carries twizz.yaml + Dockerfile; build ${sha.slice(0, 7)} as is`]),
        `- write secret ${envSecretName(svc.service, name)} with ${secretNames.length} declared secret${secretNames.length === 1 ? "" : "s"}${secretNames.length ? ` (${secretNames.join(", ")})` : ""}${Object.keys(envOverrides).length ? ` + ${Object.keys(envOverrides).length} env override${Object.keys(envOverrides).length === 1 ? "" : "s"}` : ""} — values are never shown or logged`,
        `- commit named-envs/pending/${name}.yaml (build PENDING) + apps/${svc.service}/envs/${name}.yaml${attachTo ? ` + add ${url} to ${attachTo}'s CORS origins` : ""}`,
        `- dispatch nebula-build.yml in xenosnikos/First-IDP; the build-watcher promotes the env when the image lands (db=${db}, ttl=${ttlHours}h)`,
      ];
      const gate = gateFor(ctx.prisma, ctx.login);

      return shape(
        await gate("create_env_from_repo", fields, confirm, lines.join("\n"), async () => {
          const gh = octokit();
          const [owner, repoName] = repo.split("/");
          const headOf = async (branch: string) => (await gh.git.getRef({ owner, repo: repoName, ref: `heads/${branch}` })).data.object.sha;

          // the pinned sha must still be the head, otherwise the human reviewed a different tree
          const pinnedBranch = newBranch?.from ?? ref;
          const liveHead = await headOf(pinnedBranch);
          if (liveHead !== sha) throw new Error(`${pinnedBranch} moved since you pinned it (${sha.slice(0, 7)} -> ${liveHead.slice(0, 7)}); reload and review again`);
          let branchCreated = false;
          if (newBranch) {
            await createBranch(gh, { repo, from: newBranch.from, name: ref });
            branchCreated = true;
          }

          let source = { ref, sha };
          let pr: { number: number; url: string } | undefined;
          let prDefault: { number: number; url: string } | undefined;
          if (files.length > 0) {
            const title = `nebula: configure preview ${name} (${config.kind})`;
            const body = configPrBody({ env: name, url, repo, ref, files: files.map((f) => f.path), actor: ctx.login });
            const opened = await openConfigPr(gh, { repo, base: ref, branch: prBranch, files: Object.fromEntries(files.map((f) => [f.path, f.content])), title, body });
            pr = { number: opened.prNumber, url: opened.prUrl };
            source = { ref: prBranch, sha: opened.headSha };
            if (prTarget === "chosen+default" && defaultBranch && defaultBranch !== ref) {
              const { data } = await gh.pulls.create({ owner, repo: repoName, title, head: prBranch, base: defaultBranch, body });
              prDefault = { number: data.number, url: data.html_url };
            }
          }

          const envVars: Record<string, string> = { ...envOverrides };
          for (const [k, v] of Object.entries(secretValues)) if (v !== "") envVars[k] = v;
          const created = await createEnvFromRepo(namedEnvDeps(), {
            name,
            repo,
            ref: source.ref,
            sha: source.sha,
            kind: config.kind,
            db,
            ttlHours,
            config,
            envVars,
            attachTo,
            attachUrl,
            prNumber: pr?.number,
            prUrl: pr?.url,
            actor: ctx.login,
          });
          const unset = secretNames.filter((k) => !secretValues[k]);
          return { name, url, service: svc.service, kind: config.kind, expectedTag: created.expectedTag, secret: created.secret, displayTitle: created.displayTitle, source, pr, prDefault, branchCreated, unsetSecrets: unset };
        }),
      );
    }),
});
