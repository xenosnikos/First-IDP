import {
  SecretsManagerClient,
  ListSecretsCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import {
  CloudWatchLogsClient,
  StartQueryCommand,
  GetQueryResultsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import {
  EKSClient,
  DescribeClusterCommand,
  ListNodegroupsCommand,
  DescribeNodegroupCommand,
} from "@aws-sdk/client-eks";

const region = process.env.AWS_REGION ?? "eu-west-1";
const smClient = new SecretsManagerClient({ region });
const cwlClient = new CloudWatchLogsClient({ region });
const eksClient = new EKSClient({ region });

export type SecretEntry = {
  name: string;
  arn: string;
  lastRotated?: string;
  keys: string[];
  values: Record<string, string>;
};

export type LivePod = {
  podName: string;
  namespace: string;
  containerName: string;
  status: string;
  restarts: number;
  cpuUtil?: number;
  memUtil?: number;
  memLimit?: number;
  nodeName?: string;
};

export type EksClusterInfo = {
  name: string;
  version: string;
  status: string;
  endpoint: string;
  nodeGroups: Array<{
    name: string;
    instanceType: string;
    desiredSize: number;
    minSize: number;
    maxSize: number;
    status: string;
  }>;
};

export class AWSService {
  // ── Secrets Manager ────────────────────────────

  async listSecrets(prefix: string): Promise<Array<{ name: string; arn: string; lastRotated?: string }>> {
    const result = await smClient.send(
      new ListSecretsCommand({ Filters: [{ Key: "name", Values: [prefix] }], MaxResults: 100 }),
    );
    return (result.SecretList ?? []).map((s) => ({
      name: s.Name ?? "",
      arn: s.ARN ?? "",
      lastRotated: s.LastRotatedDate?.toISOString(),
    }));
  }

  async getSecretKeys(secretId: string): Promise<string[]> {
    const result = await smClient.send(new GetSecretValueCommand({ SecretId: secretId }));
    if (!result.SecretString) return [];
    try { return Object.keys(JSON.parse(result.SecretString)); }
    catch { return ["_raw"]; }
  }

  async getSecretFull(secretId: string): Promise<SecretEntry> {
    const result = await smClient.send(new GetSecretValueCommand({ SecretId: secretId }));
    let keys: string[] = [];
    let values: Record<string, string> = {};
    if (result.SecretString) {
      try {
        values = JSON.parse(result.SecretString);
        keys = Object.keys(values);
      } catch {
        keys = ["_raw"];
        values = { _raw: result.SecretString };
      }
    }
    return { name: secretId, arn: result.ARN ?? "", keys, values };
  }

  async getAllSecrets(): Promise<SecretEntry[]> {
    const result = await smClient.send(new ListSecretsCommand({ MaxResults: 100 }));
    const secrets = result.SecretList ?? [];
    return Promise.all(secrets.map((s) => this.getSecretFull(s.Name ?? "")));
  }

  async putSecret(secretId: string, values: Record<string, string>): Promise<void> {
    const existing = await smClient.send(new GetSecretValueCommand({ SecretId: secretId }));
    let merged: Record<string, string> = {};
    if (existing.SecretString) {
      try { merged = JSON.parse(existing.SecretString); } catch {}
    }
    Object.assign(merged, values);
    await smClient.send(new PutSecretValueCommand({ SecretId: secretId, SecretString: JSON.stringify(merged) }));
  }

  // ── CloudWatch Container Insights ──────────────

  async getLivePods(clusterName: string): Promise<LivePod[]> {
    const logGroup = `/aws/containerinsights/${clusterName}/performance`;
    const now = Math.floor(Date.now() / 1000);

    const queryId = await cwlClient.send(new StartQueryCommand({
      logGroupName: logGroup,
      startTime: now - 300,
      endTime: now,
      queryString: `fields @timestamp, kubernetes.pod_name, kubernetes.namespace_name, kubernetes.container_name,
        pod_status, pod_number_of_container_restarts, pod_cpu_utilization, pod_memory_utilization,
        pod_memory_limit, NodeName
        | filter Type = "Pod"
        | sort @timestamp desc
        | dedup kubernetes.pod_name
        | limit 200`,
    }));

    if (!queryId.queryId) return [];

    // Poll for results
    let attempts = 0;
    while (attempts < 10) {
      await new Promise((r) => setTimeout(r, 1500));
      const results = await cwlClient.send(
        new GetQueryResultsCommand({ queryId: queryId.queryId }),
      );

      if (results.status === "Complete") {
        return (results.results ?? []).map((row) => {
          const get = (field: string) => row.find((f) => f.field === field)?.value ?? "";
          return {
            podName: get("kubernetes.pod_name"),
            namespace: get("kubernetes.namespace_name"),
            containerName: get("kubernetes.container_name"),
            status: get("pod_status") || "Unknown",
            restarts: parseInt(get("pod_number_of_container_restarts") || "0", 10),
            cpuUtil: parseFloat(get("pod_cpu_utilization")) || undefined,
            memUtil: parseFloat(get("pod_memory_utilization")) || undefined,
            memLimit: parseFloat(get("pod_memory_limit")) || undefined,
            nodeName: get("NodeName") || undefined,
          };
        });
      }
      attempts++;
    }
    return [];
  }

  async getNodeMetrics(clusterName: string): Promise<Array<{ name: string; cpu: number; mem: number; pods: number }>> {
    const logGroup = `/aws/containerinsights/${clusterName}/performance`;
    const now = Math.floor(Date.now() / 1000);

    const queryId = await cwlClient.send(new StartQueryCommand({
      logGroupName: logGroup,
      startTime: now - 300,
      endTime: now,
      queryString: `fields @timestamp, NodeName, node_cpu_utilization, node_memory_utilization, node_number_of_running_pods
        | filter Type = "Node"
        | sort @timestamp desc
        | dedup NodeName
        | limit 20`,
    }));

    if (!queryId.queryId) return [];

    let attempts = 0;
    while (attempts < 10) {
      await new Promise((r) => setTimeout(r, 1500));
      const results = await cwlClient.send(
        new GetQueryResultsCommand({ queryId: queryId.queryId }),
      );
      if (results.status === "Complete") {
        return (results.results ?? []).map((row) => {
          const get = (field: string) => row.find((f) => f.field === field)?.value ?? "";
          return {
            name: get("NodeName"),
            cpu: parseFloat(get("node_cpu_utilization")) || 0,
            mem: parseFloat(get("node_memory_utilization")) || 0,
            pods: parseInt(get("node_number_of_running_pods") || "0", 10),
          };
        });
      }
      attempts++;
    }
    return [];
  }

  // ── EKS Cluster Info ───────────────────────────

  async describeEksCluster(clusterName: string): Promise<EksClusterInfo | null> {
    try {
      const cluster = await eksClient.send(new DescribeClusterCommand({ name: clusterName }));
      const ngList = await eksClient.send(new ListNodegroupsCommand({ clusterName }));

      const nodeGroups = await Promise.all(
        (ngList.nodegroups ?? []).map(async (ng) => {
          const desc = await eksClient.send(
            new DescribeNodegroupCommand({ clusterName, nodegroupName: ng }),
          );
          const sc = desc.nodegroup?.scalingConfig;
          return {
            name: ng,
            instanceType: desc.nodegroup?.instanceTypes?.[0] ?? "unknown",
            desiredSize: sc?.desiredSize ?? 0,
            minSize: sc?.minSize ?? 0,
            maxSize: sc?.maxSize ?? 0,
            status: desc.nodegroup?.status ?? "UNKNOWN",
          };
        }),
      );

      return {
        name: clusterName,
        version: cluster.cluster?.version ?? "",
        status: cluster.cluster?.status ?? "",
        endpoint: cluster.cluster?.endpoint ?? "",
        nodeGroups,
      };
    } catch {
      return null;
    }
  }

  // ── Application Logs (Fluent-bit -> CloudWatch) ──

  async getPodLogs(params: {
    clusterName: string;
    namespace: string;
    podName?: string;
    containerName?: string;
    startTime: number;
    endTime: number;
    filterPattern?: string;
    limit?: number;
  }): Promise<Array<{ timestamp: string; message: string; podName: string; containerName: string }>> {
    const logGroup = `/aws/containerinsights/${params.clusterName}/application`;
    const limit = params.limit ?? 500;

    let query = `fields @timestamp, log, kubernetes.pod_name, kubernetes.container_name
      | filter kubernetes.namespace_name = "${params.namespace}"`;

    if (params.podName) {
      query += `\n| filter kubernetes.pod_name like "${params.podName}"`;
    }
    if (params.containerName) {
      query += `\n| filter kubernetes.container_name = "${params.containerName}"`;
    }
    if (params.filterPattern) {
      // Escape quotes in the filter pattern
      const escaped = params.filterPattern.replace(/"/g, '\\"');
      query += `\n| filter log like /${escaped}/`;
    }
    query += `\n| sort @timestamp desc\n| limit ${limit}`;

    const queryId = await cwlClient.send(new StartQueryCommand({
      logGroupName: logGroup,
      startTime: params.startTime,
      endTime: params.endTime,
      queryString: query,
    }));

    if (!queryId.queryId) return [];

    let attempts = 0;
    while (attempts < 15) {
      await new Promise((r) => setTimeout(r, 1500));
      const results = await cwlClient.send(
        new GetQueryResultsCommand({ queryId: queryId.queryId }),
      );

      if (results.status === "Complete") {
        return (results.results ?? []).map((row) => {
          const get = (field: string) => row.find((f) => f.field === field)?.value ?? "";
          return {
            timestamp: get("@timestamp"),
            message: get("log"),
            podName: get("kubernetes.pod_name"),
            containerName: get("kubernetes.container_name"),
          };
        }).reverse(); // Chronological order (query sorts desc for limit, reverse for display)
      }

      if (results.status === "Failed" || results.status === "Cancelled") {
        return [];
      }
      attempts++;
    }
    return [];
  }
}

export const awsService = new AWSService();
