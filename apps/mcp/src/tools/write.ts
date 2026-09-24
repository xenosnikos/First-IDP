import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { ECRClient } from "@aws-sdk/client-ecr";
import { Octokit } from "@octokit/rest";
import {
  EcrRegistry,
  GithubGitops,
  GithubPromotions,
  PROMOTABLE_NAMES,
  PROMOTABLE_TAG_RE,
  RELEASE_TARGETS,
  SecretsManagerStore,
  SERVICES,
  SERVICE_NAMES,
  TTL_HOURS,
  cloneStagingDb,
  createNamedEnv,
  extendNamedEnv,
  mergePromotion,
  parsePromotionBranch,
  promoteRelease,
  readTargetState,
  releaseTarget,
  teardownNamedEnv,
  type GateResult,
} from "@twizz-idp/actions";
import { gate, actor } from "../gate.js";
import { operatorCreds, region } from "../auth.js";

function text(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

/** The four gates, in order: policy → confirm nonce → session-tagged operator
 * creds (inside `action`) → audit row (success, failure, and denial alike).
 * Implemented in @twizz-idp/actions; this just shapes the MCP response. */
async function gated(
  tool: string,
  fields: Record<string, string>,
  confirm: string | undefined,
  summary: string,
  action: () => Promise<unknown>,
) {
  const result: GateResult = await gate(tool, fields, confirm, summary, action);
  return text(result);
}

function octokit(): Octokit {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN not set for the MCP server");
  return new Octokit({ auth: token });
}

/** Named-env ports on session-tagged operator credentials (CloudTrail records
 * tool/resource/actor). GitHub commits use the platform token. */
async function namedEnvDeps(tool: string, resource: string) {
  const creds = await operatorCreds(tool, resource, actor);
  return {
    gitops: new GithubGitops(octokit()),
    secrets: new SecretsManagerStore(new SecretsManagerClient({ region, credentials: creds })),
    images: new EcrRegistry(new ECRClient({ region, credentials: creds })),
    maxNamedEnvs: Number(process.env.NEBULA_MAX_NAMED_ENVS) || undefined,
  };
}

const confirmSchema = z
  .string()
  .optional()
  .describe("Confirmation token from the previous call (two-step confirm)");

const envName = z
  .string()
  .regex(/^[a-z][a-z0-9-]{2,23}$/, "DNS label: ^[a-z][a-z0-9-]{2,23}$")
  .describe("Named-env name; becomes namespace env-<name> and host <name>.prv.twizz.com");

const serviceSchema = z.enum(SERVICE_NAMES as [string, ...string[]]);

const ttlSchema = z.number().int().min(TTL_HOURS.min).max(TTL_HOURS.max).default(TTL_HOURS.default);

// ── Release train (docs/NEBULA.md §N4) ────────────────────────────────
const promotableSchema = z.enum(PROMOTABLE_NAMES as [string, ...string[]]).describe("service on the release train (twizz-sentinel, twizz-admin)");
const targetSchema = z.enum(RELEASE_TARGETS).describe("promotion target; only staging exists, prod is globally denied");
const promotableTag = z.string().regex(PROMOTABLE_TAG_RE, "immutable ECR tag (build-*/nb-*/main-<sha>/pr-<n>-<sha>)").describe("immutable image tag from release_train candidates; aliases (main/dev/latest) are refused");

/** Release-train ports: ECR reads on session-tagged operator creds, gitops PRs on the platform token. */
async function releaseDeps(tool: string, resource: string) {
  const creds = await operatorCreds(tool, resource, actor);
  const gh = octokit();
  return { images: new EcrRegistry(new ECRClient({ region, credentials: creds })), promotions: new GithubPromotions(gh) };
}

export function registerWriteTools(server: McpServer) {
  server.tool(
    "promote_release",
    "Release train gate 1: open a twizz-gitops PR bumping apps/<service>/values-<target>.yaml image.tag to an immutable ECR tag. Nothing deploys until merge_promotion. Operators; two-step confirm.",
    { service: promotableSchema, target: targetSchema, imageTag: promotableTag, confirm: confirmSchema },
    async ({ service, target, imageTag, confirm }) => {
      const t = releaseTarget(service, target);
      if (!t) throw new Error(`${service} has no ${target} target`);
      const fields = { service, target, imageTag };
      const deps = await releaseDeps("promote_release", `${service}:${target}`);
      const current = await readTargetState(deps, service, target).catch(() => null);
      const summary = [
        `Promote ${service} to ${target}: ${t.service.ecrRepo}:${imageTag}${current?.imageTag ? ` (replacing ${current.imageTag})` : ""}`,
        `- open a PR on twizz-gitops bumping ${t.valuesFile} image.tag`,
        `- nothing deploys until that PR is merged (merge_promotion); then Argo app ${t.argoApp} on ${t.cluster} rolls it out to https://${t.host}`,
      ].join("\n");
      return gated("promote_release", fields, confirm, summary, () => promoteRelease(deps, { service, target, imageTag, actor }));
    },
  );

  server.tool(
    "merge_promotion",
    "Release train gate 2: squash-merge an open promotion PR (sha-guarded; refused if the PR does not promote exactly service/target/imageTag). Argo CD then syncs staging. Operators; two-step confirm.",
    { pr: z.number().int().positive().describe("twizz-gitops PR number from release_train"), service: promotableSchema, target: targetSchema, imageTag: promotableTag, confirm: confirmSchema },
    async ({ pr, service, target, imageTag, confirm }) => {
      const t = releaseTarget(service, target);
      if (!t) throw new Error(`${service} has no ${target} target`);
      const deps = await releaseDeps("merge_promotion", `${service}:${target}#${pr}`);
      const found = await deps.promotions.getPr(pr);
      if (!found) throw new Error(`twizz-gitops PR #${pr} does not exist`);
      const parsed = parsePromotionBranch(found.branch);
      if (!parsed || parsed.service !== service || parsed.target !== target || parsed.tag !== imageTag) {
        throw new Error(`PR #${pr} (${found.branch}) is not the promotion ${service} ${target} → ${imageTag}`);
      }
      const fields = { pr: String(pr), service, target, imageTag };
      const summary = [
        `Merge twizz-gitops PR #${pr} "${found.title}" (head ${found.headSha.slice(0, 7)}, by ${found.author})`,
        `- squash-merge into main; refused by GitHub if the branch moves first`,
        `- Argo app ${t.argoApp} on ${t.cluster} then rolls ${service} to ${imageTag} at https://${t.host}`,
      ].join("\n");
      return gated("merge_promotion", fields, confirm, summary, () => mergePromotion(deps, { prNumber: pr, service, target, imageTag, actor }));
    },
  );

  server.tool(
    "delete_preview",
    "Tear down a PR preview environment by removing its `preview` label — GitOps prunes the namespace. Two-step confirm.",
    { repo: z.string().describe("owner/repo"), pr: z.number().int(), confirm: confirmSchema },
    async ({ repo, pr, confirm }) => {
      const fields = { repo, pr: String(pr) };
      return gated("delete_preview", fields, confirm, `Remove label 'preview' from ${repo}#${pr} (namespace will be pruned)`, async () => {
        const [owner, name] = repo.split("/");
        await octokit().issues.removeLabel({ owner, repo: name, issue_number: pr, name: "preview" });
        return `label removed from ${repo}#${pr}`;
      });
    },
  );

  server.tool(
    "trigger_preview_refresh",
    "Re-run the latest preview CI workflow run for a PR (rebuild + redeploy). Two-step confirm.",
    { repo: z.string().describe("owner/repo"), pr: z.number().int(), confirm: confirmSchema },
    async ({ repo, pr, confirm }) => {
      const fields = { repo, pr: String(pr) };
      return gated("trigger_preview_refresh", fields, confirm, `Re-run latest preview workflow for ${repo}#${pr}`, async () => {
        const [owner, name] = repo.split("/");
        const gh = octokit();
        const { data: prData } = await gh.pulls.get({ owner, repo: name, pull_number: pr });
        const { data } = await gh.actions.listWorkflowRunsForRepo({
          owner,
          repo: name,
          branch: prData.head.ref,
          per_page: 10,
        });
        const run = data.workflow_runs.find((r) => r.name === "preview") ?? data.workflow_runs[0];
        if (!run) throw new Error(`no workflow runs found for ${repo}#${pr}`);
        await gh.actions.reRunWorkflow({ owner, repo: name, run_id: run.id });
        return `re-ran workflow run ${run.id} (${run.name}) on ${prData.head.ref}`;
      });
    },
  );

  server.tool(
    "rotate_preview_secret",
    "Set one key inside a preview/* Secrets Manager secret (merge, not replace). Two-step confirm.",
    {
      secretName: z.string().describe("must start with preview/"),
      key: z.string(),
      value: z.string(),
      confirm: confirmSchema,
    },
    async ({ secretName, key, value, confirm }) => {
      const fields = { secretName, key };
      return gated("rotate_preview_secret", fields, confirm, `Set key '${key}' in secret '${secretName}'`, async () => {
        const creds = await operatorCreds("rotate_preview_secret", secretName, actor);
        const sm = new SecretsManagerClient({ region, credentials: creds });
        const current = await sm.send(new GetSecretValueCommand({ SecretId: secretName }));
        const parsed = current.SecretString ? JSON.parse(current.SecretString) : {};
        parsed[key] = value;
        await sm.send(new PutSecretValueCommand({ SecretId: secretName, SecretString: JSON.stringify(parsed) }));
        return `key '${key}' updated in ${secretName}`;
      });
    },
  );

  server.tool(
    "scale_shared_service",
    "Scale a shared singleton service on EKS-Twizz-NonProd (0-3 replicas). Two-step confirm.",
    {
      service: z.enum(["ffmpeg-service", "lolygram-discovery", "alertservice"]),
      replicas: z.number().int().min(0).max(3),
      confirm: confirmSchema,
    },
    async ({ service, replicas, confirm }) => {
      const fields = { service, replicas: String(replicas) };
      return gated("scale_shared_service", fields, confirm, `Scale shared/${service} to ${replicas} replicas`, async () => {
        const k8s = await import("@kubernetes/client-node");
        const kc = new k8s.KubeConfig();
        kc.loadFromFile(process.env.TWIZZ_NONPROD_KUBECONFIG ?? `${process.env.HOME}/.kube/twizz-nonprod.yaml`);
        const apps = kc.makeApiClient(k8s.AppsV1Api);
        await apps.patchNamespacedDeploymentScale(
          service,
          "shared",
          { spec: { replicas } },
          undefined, undefined, undefined, undefined, undefined,
          { headers: { "Content-Type": "application/merge-patch+json" } },
        );
        return `shared/${service} scaled to ${replicas}`;
      });
    },
  );

  // ── Nebula named environments ──────────────────────────────────────
  // Manual model: an EXISTING release image, a per-env Secrets Manager blob,
  // a manifest committed to twizz-gitops named-envs/<name>.yaml. No builds,
  // no kube API — Argo CD reconciles. See twizz-gitops/named-envs/README.md.

  server.tool(
    "create_named_env",
    "Provision a Nebula named environment from an EXISTING release image (ECR build-* tag): creates the per-env Secrets Manager blob (isolated Mongo db nebula_<name>, own Redis, fresh TOKEN_SECRET) and commits named-envs/<name>.yaml to twizz-gitops; Argo CD brings up https://<name>.prv.twizz.com (VPN+SSO). Two-step confirm.",
    {
      name: envName,
      service: serviceSchema,
      imageTag: z.string().regex(/^build-[0-9a-f-]{36}$/, "immutable ECR build-* tag (never latest/prod/dev)"),
      db: z.enum(["isolated", "clone"]).describe("isolated = empty db; clone = copy of the staging db via the chart's PreSync hook"),
      ttlHours: ttlSchema,
      frontendOrigins: z
        .array(z.string().url())
        .max(10)
        .optional()
        .describe("Browser origins allowed by the backend's ingress CORS (several frontends may call one backend); default [https://<name>-frontend.prv.twizz.com]"),
      confirm: confirmSchema,
    },
    async ({ name, service, imageTag, db, ttlHours, frontendOrigins, confirm }) => {
      const fields = { name, service, imageTag, db, ttlHours: String(ttlHours), frontendOrigins: (frontendOrigins ?? []).join(" ") };
      const summary = `Create named env '${name}' (${service}:${imageTag}, db=${db}, ttl=${ttlHours}h) -> https://${name}.prv.twizz.com; writes secret preview/${service}/${name} + named-envs/${name}.yaml`;
      return gated("create_named_env", fields, confirm, summary, async () =>
        createNamedEnv(await namedEnvDeps("create_named_env", name), { name, service, imageTag, db, ttlHours, frontendOrigins, actor }),
      );
    },
  );

  server.tool(
    "teardown_named_env",
    "Tear down a Nebula named environment: deletes named-envs/<name>.yaml (Argo CD prunes the app; the PostDelete hook drops its db) and force-deletes the per-env secret. The env-<name> namespace is reaped separately. Two-step confirm.",
    { name: envName, confirm: confirmSchema },
    async ({ name, confirm }) => {
      const fields = { name };
      return gated("teardown_named_env", fields, confirm, `Tear down named env '${name}' (manifest + secret; app pruned, db dropped)`, async () =>
        teardownNamedEnv(await namedEnvDeps("teardown_named_env", name), { name, actor }),
      );
    },
  );

  server.tool(
    "clone_staging_db",
    "Re-clone the staging Mongo db into a named env's nebula_<name> db by bumping db.generation in its manifest (the chart's PreSync hook does the copy in-cluster; source pinned to the preview/* staging blob). Two-step confirm.",
    { name: envName, confirm: confirmSchema },
    async ({ name, confirm }) => {
      // `source` is derived server-side and policy-pinned; it is never an input.
      const fields = { name, source: SERVICES["moly-backend"].sourceSecret };
      return gated("clone_staging_db", fields, confirm, `Re-clone staging db (${fields.source}) into nebula_${name} (bumps db.generation)`, async () =>
        cloneStagingDb(await namedEnvDeps("clone_staging_db", name), { name, actor }),
      );
    },
  );

  server.tool(
    "extend_named_env",
    "Extend a named env's TTL: rewrites expiresAt in named-envs/<name>.yaml to now + ttlHours. Two-step confirm.",
    { name: envName, ttlHours: ttlSchema, confirm: confirmSchema },
    async ({ name, ttlHours, confirm }) => {
      const fields = { name, ttlHours: String(ttlHours) };
      return gated("extend_named_env", fields, confirm, `Extend named env '${name}' by ${ttlHours}h from now`, async () =>
        extendNamedEnv(await namedEnvDeps("extend_named_env", name), { name, ttlHours, actor }),
      );
    },
  );
}
