import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  GithubGitops,
  SERVICES,
  SERVICE_NAMES,
  TTL_HOURS,
  NAME_RE,
  IMAGE_TAG_RE,
  cloneStagingDb,
  createNamedEnv,
  extendNamedEnv,
  listNamedEnvs,
  listReleaseImages,
  teardownNamedEnv,
  type GateResult,
  type ServiceName,
} from "@twizz-idp/actions";
import { router, protectedProcedure } from "../trpc";
import { isOperator } from "@/lib/nebula/operators";
import { argoWord, ttlWord } from "@/lib/nebula/status";
import { gateFor, namedEnvDeps, octokit } from "../nebula/deps";
import { argoStatusFor, readArgoApplications } from "../nebula/argo";

// The Nebula write path (docs/NEBULA.md §4.2, §4.7). Every mutation here:
//   protectedProcedure (signed-in org member)
//   → operator allowlist (NEBULA_OPERATORS; denial is itself audited)
//   → @twizz-idp/actions gate: policy.yaml → Prisma nonce (two-step) → action → AuditLog
// The client never fabricates a nonce for different args: the nonce is
// fingerprinted to (tool, fields) server-side and is single-use.

function loginOf(session: unknown): string {
  const login = (session as { login?: string } | null)?.login;
  if (!login) throw new TRPCError({ code: "UNAUTHORIZED", message: "no GitHub login on session" });
  return login;
}

const operatorProcedure = protectedProcedure.use(async ({ ctx, next, path }) => {
  const login = loginOf(ctx.session);
  if (!isOperator(login)) {
    await ctx.prisma.auditLog
      .create({ data: { actor: login, action: `nebula.${path.split(".").pop()}`, allowed: false, detail: { reason: "not a Nebula operator (NEBULA_OPERATORS)" } } })
      .catch(() => {});
    throw new TRPCError({ code: "FORBIDDEN", message: "READ-ONLY: your GitHub login is not in NEBULA_OPERATORS" });
  }
  return next({ ctx: { ...ctx, login } });
});

const confirmSchema = z.string().min(8).max(64).optional();
const envName = z.string().regex(NAME_RE, "DNS label: ^[a-z][a-z0-9-]{2,23}$");
const serviceSchema = z.enum(SERVICE_NAMES as [ServiceName, ...ServiceName[]]);
const ttlSchema = z.number().int().min(TTL_HOURS.min).max(TTL_HOURS.max);

/** The gate result goes to the client as-is (nonce travels as `confirm`). */
function shape(r: GateResult): GateResult {
  return r;
}

export const actionsRouter = router({
  /** Who am I to Nebula: read-only or operator. */
  me: protectedProcedure.query(({ ctx }) => {
    const login = loginOf(ctx.session);
    return { login, operator: isOperator(login) };
  }),

  /** The Environments grid: every named-env manifest in twizz-gitops,
   * enriched with live Argo Application health read in-cluster. */
  listEnvs: protectedProcedure.query(async () => {
    const now = new Date();
    const [envs, argo] = await Promise.all([listNamedEnvs({ gitops: new GithubGitops(octokit()) }), readArgoApplications()]);
    return {
      argo: { reachable: argo.reachable, reason: argo.reason },
      envs: envs.map((m) => {
        const appName = `env-${m.name}`;
        const status = argoStatusFor(argo, appName);
        return {
          ...m,
          url: `https://${m.name}.prv.twizz.com`,
          argoApp: appName,
          namespace: appName,
          dbName: `nebula_${m.name}`,
          secret: `${SERVICES[m.service].sourceSecret}/${m.name}`,
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
      const summary = `Create named env '${name}' (${service}:${imageTag}, db=${db}, ttl=${ttlHours}h) -> https://${name}.prv.twizz.com; writes secret ${SERVICES[service].sourceSecret}/${name} + named-envs/${name}.yaml`;
      const gate = gateFor(ctx.prisma, ctx.login);
      return shape(
        await gate("create_named_env", fields, confirm, summary, () =>
          createNamedEnv(namedEnvDeps(), { name, service, imageTag, db, ttlHours, frontendOrigins, actor: ctx.login }),
        ),
      );
    }),

  teardownNamedEnv: operatorProcedure
    .input(z.object({ name: envName, confirm: confirmSchema }))
    .mutation(async ({ ctx, input }) => {
      const { name, confirm } = input;
      const gate = gateFor(ctx.prisma, ctx.login);
      return shape(
        await gate("teardown_named_env", { name }, confirm, `Tear down named env '${name}' (manifest + secret; app pruned, db dropped)`, () =>
          teardownNamedEnv(namedEnvDeps(), { name, actor: ctx.login }),
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

  extendNamedEnv: operatorProcedure
    .input(z.object({ name: envName, ttlHours: ttlSchema.default(TTL_HOURS.default), confirm: confirmSchema }))
    .mutation(async ({ ctx, input }) => {
      const { name, ttlHours, confirm } = input;
      const gate = gateFor(ctx.prisma, ctx.login);
      return shape(
        await gate("extend_named_env", { name, ttlHours: String(ttlHours) }, confirm, `Extend named env '${name}' by ${ttlHours}h from now`, () =>
          extendNamedEnv(namedEnvDeps(), { name, ttlHours, actor: ctx.login }),
        ),
      );
    }),
});
