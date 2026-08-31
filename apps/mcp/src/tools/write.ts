import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { Octokit } from "@octokit/rest";
import { evaluatePolicy } from "../policy.js";
import { issueNonce, consumeNonce } from "../confirm.js";
import { audit, actor } from "../audit.js";
import { operatorCreds, region } from "../auth.js";

function text(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

/** The four gates, in order: policy → confirm nonce → session-tagged operator
 * creds → audit row (success, failure, and denial alike). */
async function gated(
  tool: string,
  fields: Record<string, string>,
  confirm: string | undefined,
  summary: string,
  action: () => Promise<unknown>,
) {
  const decision = evaluatePolicy(tool, fields);
  if (!decision.allowed) {
    await audit({ action: `mcp.${tool}`, resource: JSON.stringify(fields), allowed: false, detail: { reason: decision.reason } });
    return text({ denied: true, reason: decision.reason });
  }

  if (!confirm) {
    const nonce = issueNonce(tool, fields);
    return text({
      confirmationRequired: true,
      summary,
      instruction: `Re-run ${tool} with the same arguments plus confirm: "${nonce}" within 5 minutes.`,
      confirm: nonce,
    });
  }

  const consumed = consumeNonce(confirm, tool, fields);
  if (!consumed.ok) {
    await audit({ action: `mcp.${tool}`, resource: JSON.stringify(fields), allowed: false, detail: { reason: consumed.reason } });
    return text({ denied: true, reason: consumed.reason });
  }

  try {
    const result = await action();
    await audit({ action: `mcp.${tool}`, resource: JSON.stringify(fields), allowed: true, detail: { result: String(result).slice(0, 500) } });
    return text({ done: true, result });
  } catch (e) {
    await audit({ action: `mcp.${tool}`, resource: JSON.stringify(fields), allowed: true, detail: { error: String(e) } });
    return text({ error: String(e) });
  }
}

function octokit(): Octokit {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN not set for the MCP server");
  return new Octokit({ auth: token });
}

const confirmSchema = z
  .string()
  .optional()
  .describe("Confirmation token from the previous call (two-step confirm)");

export function registerWriteTools(server: McpServer) {
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
}
