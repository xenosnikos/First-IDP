import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";
import { Octokit } from "@octokit/rest";
import { ECRClient } from "@aws-sdk/client-ecr";
import {
  EcrRegistry,
  GithubGitops,
  SERVICE_NAMES,
  listNamedEnvs,
  listReleaseImages,
  type ServiceName,
} from "@twizz-idp/actions";
import { ensureReadonlyCreds, operatorCreds, region } from "../auth.js";
import { actor } from "../gate.js";

const NONPROD = "EKS-Twizz-NonProd";
const CLUSTERS = [NONPROD, "EKS-Moly-staging", "EKS-Moly-Prod"];

function text(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

async function core() {
  await ensureReadonlyCreds();
  return import("@twizz-idp/core");
}

export function registerReadTools(server: McpServer) {
  server.tool(
    "platform_status",
    "Live pod counts per cluster/namespace across all Twizz EKS clusters (read-only, CloudWatch Container Insights).",
    {},
    async () => {
      const { awsService } = await core();
      const clusters = await Promise.all(
        CLUSTERS.map(async (name) => {
          try {
            const pods = await awsService.getLivePods(name);
            const byNs: Record<string, number> = {};
            for (const p of pods) byNs[p.namespace] = (byNs[p.namespace] ?? 0) + 1;
            return { cluster: name, podsByNamespace: byNs, totalPods: pods.length };
          } catch (e) {
            return { cluster: name, error: String(e) };
          }
        }),
      );
      return text({ clusters });
    },
  );

  server.tool(
    "list_previews",
    "List PR preview environments (pr-* namespaces) on EKS-Twizz-NonProd with their pods.",
    {},
    async () => {
      const { awsService } = await core();
      const pods = await awsService.getLivePods(NONPROD);
      const previews: Record<string, Array<{ pod: string; status: string }>> = {};
      for (const p of pods) {
        if (!p.namespace.startsWith("pr-")) continue;
        (previews[p.namespace] ??= []).push({ pod: p.podName, status: p.status });
      }
      const entries = Object.entries(previews).map(([ns, ps]) => ({
        namespace: ns,
        url: `https://${ns.replace(/^pr-([a-z-]+)-(\d+)$/, "pr-$2-$1")}.prv.twizz.com`,
        pods: ps,
      }));
      return text({ count: entries.length, previews: entries });
    },
  );

  server.tool(
    "service_logs",
    "Fetch recent application logs for a service (CloudWatch Container Insights). Times are minutes back from now.",
    {
      cluster: z.enum([NONPROD, "EKS-Moly-staging", "EKS-Moly-Prod"]).default(NONPROD),
      namespace: z.string(),
      podName: z.string().optional(),
      minutesBack: z.number().int().min(1).max(1440).default(30),
      filter: z.string().optional().describe("CloudWatch filter pattern, e.g. ?ERROR"),
      limit: z.number().int().min(1).max(500).default(100),
    },
    async ({ cluster, namespace, podName, minutesBack, filter, limit }) => {
      const { awsService } = await core();
      const end = Date.now();
      const logs = await awsService.getPodLogs({
        clusterName: cluster,
        namespace,
        podName,
        startTime: end - minutesBack * 60_000,
        endTime: end,
        filterPattern: filter,
        limit,
      });
      return text({ lines: logs.length, logs });
    },
  );

  server.tool(
    "pipeline_status",
    "Recent GitHub Actions runs for a repo (the platform's CI engine).",
    {
      owner: z.string().default("twizz-app"),
      repo: z.string(),
      limit: z.number().int().min(1).max(30).default(10),
    },
    async ({ owner, repo, limit }) => {
      const token = process.env.GITHUB_TOKEN;
      if (!token) return text({ error: "GITHUB_TOKEN not set for the MCP server" });
      const { GitHubService } = await core();
      const runs = await new GitHubService(token).listWorkflowRuns(owner, repo, limit);
      return text({ runs });
    },
  );

  server.tool(
    "cluster_health",
    "EKS cluster info + node CPU/memory/pod pressure (read-only).",
    { cluster: z.enum([NONPROD, "EKS-Moly-staging", "EKS-Moly-Prod"]).default(NONPROD) },
    async ({ cluster }) => {
      const { awsService } = await core();
      const [info, nodes] = await Promise.all([
        awsService.describeEksCluster(cluster),
        awsService.getNodeMetrics(cluster).catch(() => []),
      ]);
      return text({ cluster: info, nodes });
    },
  );

  server.tool(
    "cost_report",
    "AWS cost by service for the last N days (Cost Explorer, unblended).",
    { days: z.number().int().min(1).max(90).default(7), topN: z.number().int().min(1).max(30).default(12) },
    async ({ days, topN }) => {
      await ensureReadonlyCreds();
      const ce = new CostExplorerClient({ region: "us-east-1" });
      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - days * 86_400_000);
      const fmt = (d: Date) => d.toISOString().slice(0, 10);
      const res = await ce.send(
        new GetCostAndUsageCommand({
          TimePeriod: { Start: fmt(startDate), End: fmt(endDate) },
          Granularity: "DAILY",
          Metrics: ["UnblendedCost"],
          GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
        }),
      );
      const totals: Record<string, number> = {};
      for (const day of res.ResultsByTime ?? []) {
        for (const g of day.Groups ?? []) {
          const svc = g.Keys?.[0] ?? "unknown";
          totals[svc] = (totals[svc] ?? 0) + Number(g.Metrics?.UnblendedCost?.Amount ?? 0);
        }
      }
      const sorted = Object.entries(totals)
        .sort(([, a], [, b]) => b - a)
        .slice(0, topN)
        .map(([service, usd]) => ({ service, usd: Math.round(usd * 100) / 100 }));
      const total = Math.round(Object.values(totals).reduce((a, b) => a + b, 0) * 100) / 100;
      return text({ days, totalUsd: total, byService: sorted });
    },
  );

  // ── Nebula named environments (read side) ──────────────────────────
  server.tool(
    "list_named_envs",
    "Nebula named environments as declared in twizz-gitops named-envs/*.yaml (name, service, imageTag, owner, expiresAt, db mode/generation, url).",
    {},
    async () => {
      const token = process.env.GITHUB_TOKEN;
      if (!token) return text({ error: "GITHUB_TOKEN not set for the MCP server" });
      const envs = await listNamedEnvs({ gitops: new GithubGitops(new Octokit({ auth: token })) });
      return text({
        count: envs.length,
        envs: envs.map((m) => ({ ...m, url: `https://${m.name}.prv.twizz.com`, namespace: `env-${m.name}`, argoApp: `env-${m.name}` })),
      });
    },
  );

  server.tool(
    "list_release_images",
    "Existing release images for a service: immutable ECR build-* tags (newest first) with the floating aliases (prod/latest/dev) that currently point at them. Pick one of these for create_named_env.",
    {
      service: z.enum(SERVICE_NAMES as [ServiceName, ...ServiceName[]]).default("moly-backend"),
      limit: z.number().int().min(1).max(50).default(20),
    },
    async ({ service, limit }) => {
      // Read-only call, but twizz-mcp-readonly (ViewOnlyAccess) lacks
      // ecr:DescribeImages, which is the only API that returns push dates and
      // co-tags. The operator role has it, so this runs there, session-tagged.
      const creds = await operatorCreds("list_release_images", service, actor);
      const images = await listReleaseImages({ images: new EcrRegistry(new ECRClient({ region, credentials: creds })) }, service, limit);
      return text({ service, count: images.length, images });
    },
  );
}

export { Octokit };
