import { GitHubService } from "./github";
import { vercelService } from "./vercel";
import { awsService, type SecretEntry, type LivePod, type EksClusterInfo } from "./aws";
import { atlasService } from "./atlas";

// ── Types ────────────────────────────────────

export type DbConnection = {
  environment: string;
  secretName: string;
  secretKey: string;
  uri: string;
  host: string;
  database: string;
  matchedAtlasCluster?: string;
};

export type LiveEnvironment = {
  name: string;
  tier: "production" | "staging" | "dev" | "unknown";
  source: "eks" | "vercel" | "config";
  status: "live" | "configured" | "unknown";
  services: Array<{
    podName: string;
    containerName: string;
    status: string;
    restarts: number;
    cpuUtil?: number;
    memUtil?: number;
    node?: string;
  }>;
  endpoints: string[];
  databases: DbConnection[];
  secrets: SecretEntry[];
  nodes?: Array<{ name: string; cpu: number; mem: number; pods: number }>;
  eksCluster?: EksClusterInfo | null;
};

export type ProjectIntrospection = {
  repo: {
    name: string;
    fullName: string;
    language: string | null;
    defaultBranch: string;
    description: string | null;
  };
  type: "FRONTEND" | "BACKEND" | "FULLSTACK" | "UNKNOWN";
  detection: {
    hasDockerfile: boolean;
    hasVercelConfig: boolean;
    framework?: string;
    runtime?: string;
    deps: Record<string, string>;
  };
  environments: LiveEnvironment[];
  vercelDeployments: Array<{
    id: string;
    url: string;
    state: string;
    createdAt: number;
    branch?: string;
  }>;
};

// ── Helpers ──────────────────────────────────

function parseMongoUri(uri: string): { host: string; database: string } | null {
  try {
    // mongodb+srv://user:pass@cluster.xyz.mongodb.net/dbname?...
    const match = uri.match(/@([^/]+)\/([^?]+)/);
    if (match) return { host: match[1], database: match[2] };
    // fallback: just extract host
    const hostMatch = uri.match(/@([^/]+)/);
    if (hostMatch) return { host: hostMatch[1], database: "" };
    return null;
  } catch {
    return null;
  }
}

function inferEnvironment(name: string): "production" | "staging" | "dev" | "unknown" {
  const lower = name.toLowerCase();
  if (lower.includes("prod") || lower === "default") return "production";
  if (lower.includes("stag")) return "staging";
  if (lower.includes("dev") || lower.includes("non-prod") || lower.includes("qa") || lower.includes("preview")) return "dev";
  return "unknown";
}

const SYSTEM_NAMESPACES = new Set([
  "kube-system", "monitoring", "argo", "argocd", "external-secrets",
  "ingress-nginx", "cert-manager", "cloudwatch", "amazon-cloudwatch",
  "dynatrace",
]);

function inferTierFromNamespaceAndCluster(
  ns: string,
  clusterTiers: Array<"production" | "staging" | "dev">,
): "production" | "staging" | "dev" | "unknown" {
  const lower = ns.toLowerCase();

  // System namespaces -- skip
  if (SYSTEM_NAMESPACES.has(lower)) return "unknown";

  // Explicit namespace names override cluster context
  if (lower === "dev" || lower.includes("-dev")) return "dev";
  if (lower.includes("stag")) return "staging";
  if (lower === "production" || lower === "prod") return "production";

  // "jobs" namespace -- shared, assign to primary tier of this cluster
  if (lower === "jobs") return clusterTiers[0];

  // "default" namespace -- meaning depends on which cluster
  // On prod cluster: default = production
  // On staging cluster: default = staging
  if (lower === "default") return clusterTiers[0];

  // Anything else: check for hints, else use cluster's primary tier
  if (lower.includes("prod")) return "production";
  if (lower.includes("dev") || lower.includes("qa")) return "dev";
  return clusterTiers[0];
}

// Known naming aliases: the project was historically "Loly" before "Moly"/"Twizz"
const NAME_ALIASES: Record<string, string[]> = {
  moly: ["loly"],
  loly: ["moly"],
};

function matchPodToProject(podName: string, containerName: string, repoName: string): boolean {
  const base = repoName.toLowerCase();
  const bases = [base];

  // Expand aliases: "moly-backend" -> also try "loly-backend"
  for (const [from, aliases] of Object.entries(NAME_ALIASES)) {
    if (base.includes(from)) {
      for (const alias of aliases) {
        bases.push(base.replace(from, alias));
      }
    }
  }

  const variants: string[] = [];
  for (const b of bases) {
    variants.push(b, b.replace(/-/g, ""), b.replace(/_/g, ""), b.replace(/-/g, "_"));
  }

  const podLower = podName.toLowerCase();
  const containerLower = containerName.toLowerCase();
  return variants.some((v) => podLower.includes(v) || containerLower.includes(v));
}

// EKS-Moly-Prod = production only
// EKS-Moly-staging = staging + dev (different namespaces on same cluster)
const EKS_CLUSTERS: Array<{ name: string; tiers: Array<"production" | "staging" | "dev"> }> = [
  { name: process.env.EKS_PROD_CLUSTER ?? "EKS-Moly-Prod", tiers: ["production"] },
  { name: process.env.EKS_STAGING_CLUSTER ?? "EKS-Moly-staging", tiers: ["staging", "dev"] },
];

// ── Main introspection ──────────────────────

export async function introspectProject(
  githubToken: string,
  owner: string,
  repoName: string,
): Promise<ProjectIntrospection> {
  const github = new GitHubService(githubToken);

  // Phase 1: Detect project type first
  const [repos, detection, pkgRaw] = await Promise.allSettled([
    github.listOrgRepos(owner),
    github.detectProjectType(owner, repoName, "main"),
    github.getFileContent(owner, repoName, "package.json", "main"),
  ]);

  const repoList = repos.status === "fulfilled" ? repos.value : [];
  const repo = repoList.find((r) => r.name === repoName);
  const detect = detection.status === "fulfilled" ? detection.value : { type: "UNKNOWN" as const, deps: {}, hasDockerfile: false, hasVercelConfig: false };

  const isBackend = detect.type === "BACKEND" || detect.type === "FULLSTACK";
  const isFrontend = detect.type === "FRONTEND" || detect.type === "FULLSTACK";

  // Phase 2: Fetch from ALL clusters in parallel + secrets + Atlas + Vercel
  type ClusterData = {
    tiers: Array<"production" | "staging" | "dev">;
    clusterName: string;
    pods: Awaited<ReturnType<typeof awsService.getLivePods>>;
    nodes: Awaited<ReturnType<typeof awsService.getNodeMetrics>>;
    eksInfo: Awaited<ReturnType<typeof awsService.describeEksCluster>>;
  };

  const clusterFetches = isBackend
    ? EKS_CLUSTERS.map(async (c): Promise<ClusterData> => {
        const [pods, nodes, eksInfo] = await Promise.allSettled([
          awsService.getLivePods(c.name),
          awsService.getNodeMetrics(c.name),
          awsService.describeEksCluster(c.name),
        ]);
        return {
          tiers: c.tiers,
          clusterName: c.name,
          pods: pods.status === "fulfilled" ? pods.value : [],
          nodes: nodes.status === "fulfilled" ? nodes.value : [],
          eksInfo: eksInfo.status === "fulfilled" ? eksInfo.value : null,
        };
      })
    : [];

  const [clusterResults, secretsResult, atlasResult, vercelResult] = await Promise.allSettled([
    Promise.all(clusterFetches),
    awsService.getAllSecrets(),
    isBackend ? atlasService.listClusters() : Promise.resolve([]),
    isFrontend ? vercelService.listProjects() : Promise.resolve([]),
  ]);

  const clusterData = clusterResults.status === "fulfilled" ? clusterResults.value : [];
  const secrets = secretsResult.status === "fulfilled" ? secretsResult.value as SecretEntry[] : [];
  const atlasClusters = atlasResult.status === "fulfilled" ? atlasResult.value as Awaited<ReturnType<typeof atlasService.listClusters>> : [];
  const vProjects = vercelResult.status === "fulfilled" ? vercelResult.value as Awaited<ReturnType<typeof vercelService.listProjects>> : [];

  // Parse package.json description
  let description: string | null = null;
  if (pkgRaw.status === "fulfilled" && pkgRaw.value) {
    try { description = JSON.parse(pkgRaw.value).description ?? null; } catch {}
  }

  // Detect framework
  let framework: string | undefined;
  let runtime: string | undefined;
  if (detect.deps["next"]) framework = "Next.js";
  else if (detect.deps["react"]) framework = "React";
  else if (detect.deps["vue"]) framework = "Vue";
  else if (detect.deps["@nestjs/core"]) framework = "NestJS";
  else if (detect.deps["express"]) framework = "Express";
  if (detect.deps["typescript"]) runtime = "TypeScript";
  else if (detect.hasDockerfile) runtime = "Node.js";

  // ── Extract DB connections from secrets ────

  const mongoKeys = ["MONGODB_URI", "MONGO_URI", "DATABASE_URI", "MONGO_URL", "DB_URI", "MONGODB_URL"];
  const dbConnections: DbConnection[] = [];

  for (const secret of secrets) {
    for (const key of mongoKeys) {
      const val = secret.values[key];
      if (val) {
        const parsed = parseMongoUri(val);
        if (parsed) {
          // Match to Atlas cluster
          const matched = atlasClusters.find((c) =>
            c.connectionString && parsed.host.includes(
              c.connectionString.replace("mongodb+srv://", "").split("/")[0],
            ),
          );

          dbConnections.push({
            environment: inferEnvironment(secret.name),
            secretName: secret.name,
            secretKey: key,
            uri: val.replace(/\/\/[^:]+:[^@]+@/, "//***:***@"), // mask credentials
            host: parsed.host,
            database: parsed.database,
            matchedAtlasCluster: matched?.clusterName,
          });
        }
      }
    }
  }

  // ── Build environments from ALL sources ─────
  // Three discovery paths:
  // 1. Live pods in EKS (running right now)
  // 2. Secrets in AWS SM (configured, may or may not be running)
  // 3. Vercel targets (frontend environments)

  const tierLabels: Record<string, string> = {
    production: "Production",
    staging: "Staging",
    dev: "Development",
  };

  const envMap = new Map<string, LiveEnvironment>();

  function getOrCreateEnv(tier: "production" | "staging" | "dev", source: "eks" | "vercel" | "config"): LiveEnvironment {
    const key = `${source}-${tier}`;
    if (!envMap.has(key)) {
      envMap.set(key, {
        name: tierLabels[tier] ?? tier,
        tier,
        source,
        status: "configured",
        services: [],
        endpoints: [],
        databases: [],
        secrets: [],
      });
    }
    return envMap.get(key)!;
  }

  // ── 1. Discover environments from secrets ────
  // Secrets tell us what environments EXIST even if pods aren't running

  const relevantSecrets = secrets.filter((s) => {
    const lower = s.name.toLowerCase();
    const repoLower = repoName.toLowerCase();
    return lower.includes(repoLower) ||
           lower.includes(repoLower.replace(/-/g, "/")) ||
           (lower.includes("moly") && repoLower.includes("moly")) ||
           (lower.includes("backend") && repoLower.includes("backend")) ||
           (lower.includes("email") && repoLower.includes("email"));
  });

  if (isBackend) {
    for (const secret of relevantSecrets) {
      const tier = inferEnvironment(secret.name);
      if (tier === "unknown") continue;
      const env = getOrCreateEnv(tier, "eks");
      env.secrets.push(secret);
    }
  }

  // ── 2. Link DB connections to their environments ──

  for (const db of dbConnections) {
    if (!isBackend) continue;
    const tier = db.environment;
    if (tier === "unknown") continue;
    const env = getOrCreateEnv(tier as any, "eks");
    env.databases.push(db);
  }

  // ── 3. Match live pods from ALL clusters ────
  // EKS-Moly-staging hosts both staging (default ns) and dev (dev ns)
  // Namespace + cluster context together determine the tier.

  for (const cd of clusterData) {
    const projectPods = cd.pods.filter((p) => matchPodToProject(p.podName, p.containerName, repoName));

    for (const pod of projectPods) {
      const tier = inferTierFromNamespaceAndCluster(pod.namespace, cd.tiers);
      if (tier === "unknown") continue;

      const env = getOrCreateEnv(tier, "eks");
      env.status = "live";
      env.services.push({
        podName: pod.podName,
        containerName: pod.containerName,
        status: pod.status,
        restarts: pod.restarts,
        cpuUtil: pod.cpuUtil,
        memUtil: pod.memUtil,
        node: pod.nodeName,
      });
    }

    // Attach cluster info + nodes to ALL tiers this cluster serves
    for (const tier of cd.tiers) {
      const env = envMap.get(`eks-${tier}`);
      if (env) {
        env.eksCluster = cd.eksInfo;
        env.nodes = cd.nodes;
      }
    }
  }

  // ── 4. Vercel environments ────────────────────

  let vercelDeployments: ProjectIntrospection["vercelDeployments"] = [];
  try {
    const repoLower = repoName.toLowerCase();
    const vProject = vProjects.find(
      (p) => (p.linkedRepo && p.linkedRepo.toLowerCase() === repoLower) ||
             p.name.toLowerCase() === repoLower ||
             p.linkedRepo?.toLowerCase().includes(repoLower) ||
             repoLower.includes(p.name.toLowerCase()),
    );

    if (vProject) {
      const projectDetail = await vercelService.getProjectDetail(vProject.id);

      for (const vEnv of projectDetail.environments) {
        const tier = vEnv.name === "Production" ? "production" as const
          : vEnv.name === "Staging" ? "staging" as const
          : "dev" as const;

        const env = getOrCreateEnv(tier, "vercel");
        env.name = vEnv.name;
        env.status = vEnv.state === "READY" ? "live" : "configured";
        env.services.push({
          podName: vEnv.branch ? `branch: ${vEnv.branch}` : vProject.name,
          containerName: "vercel",
          status: vEnv.state,
          restarts: 0,
        });
        env.endpoints = vEnv.aliases.length > 0 ? vEnv.aliases : [vEnv.url];
      }

      const deploys = await vercelService.listDeployments(vProject.id, 15);
      vercelDeployments = deploys.map((d) => ({
        id: d.id,
        url: d.url,
        state: d.state,
        createdAt: d.createdAt,
        branch: d.meta?.githubCommitRef,
      }));
    }
  } catch { /* vercel not configured */ }

  // ── 5. If no environments were discovered from any source, check for ALL secrets ──

  if (envMap.size === 0 && isBackend && secrets.length > 0) {
    // Fallback: create environments from any secrets we find
    for (const secret of secrets) {
      const tier = inferEnvironment(secret.name);
      if (tier === "unknown") continue;
      const env = getOrCreateEnv(tier, "config");
      env.secrets.push(secret);
    }
  }

  return {
    repo: {
      name: repoName,
      fullName: `${owner}/${repoName}`,
      language: repo?.language ?? null,
      defaultBranch: repo?.defaultBranch ?? "main",
      description,
    },
    type: detect.type,
    detection: { ...detect, framework, runtime },
    environments: Array.from(envMap.values()),
    vercelDeployments,
  };
}

// ── All-environments overview ──────────────

export type ServiceInstance = {
  project: string;
  podName: string;
  containerName: string;
  namespace: string;
  status: string;
  restarts: number;
  cpuUtil?: number;
  memUtil?: number;
  node?: string;
  source: "eks" | "vercel";
  cluster?: string;
};

export type EnvironmentOverview = {
  tier: "production" | "staging" | "dev";
  label: string;
  services: ServiceInstance[];
  databases: Array<DbConnection & { project: string }>;
  clusters: string[];
};

export type AllEnvironmentsData = {
  environments: EnvironmentOverview[];
  projects: Array<{ name: string; type: "FRONTEND" | "BACKEND" | "FULLSTACK" | "UNKNOWN" }>;
};

/**
 * Fetches a cross-project view of ALL environments: every pod on every cluster,
 * every Vercel deployment, grouped by tier.
 */
export async function introspectAllEnvironments(
  githubToken: string,
  owner: string,
): Promise<AllEnvironmentsData> {
  const github = new GitHubService(githubToken);

  // Fetch everything in parallel: repos, all EKS pods, Vercel projects, secrets, Atlas
  const clusterFetches = EKS_CLUSTERS.map(async (c) => {
    const [pods, eksInfo] = await Promise.allSettled([
      awsService.getLivePods(c.name),
      awsService.describeEksCluster(c.name),
    ]);
    return {
      tiers: c.tiers,
      clusterName: c.name,
      pods: pods.status === "fulfilled" ? pods.value : [],
      eksInfo: eksInfo.status === "fulfilled" ? eksInfo.value : null,
    };
  });

  const [reposResult, clustersResult, vercelResult, secretsResult, atlasResult] = await Promise.allSettled([
    github.listOrgRepos(owner),
    Promise.all(clusterFetches),
    vercelService.listProjects(),
    awsService.getAllSecrets(),
    atlasService.listClusters(),
  ]);

  const repos = reposResult.status === "fulfilled" ? reposResult.value : [];
  const clusterData = clustersResult.status === "fulfilled" ? clustersResult.value : [];
  const vProjects = vercelResult.status === "fulfilled" ? vercelResult.value : [];
  const secrets = secretsResult.status === "fulfilled" ? secretsResult.value as SecretEntry[] : [];
  const atlasClusters = atlasResult.status === "fulfilled" ? atlasResult.value : [];

  // Detect project types in parallel (lightweight -- just checks for Dockerfile / vercel.json)
  const typeChecks = repos.slice(0, 30).map(async (r) => {
    try {
      const det = await github.detectProjectType(owner, r.name, r.defaultBranch);
      return { name: r.name, type: det.type };
    } catch {
      return { name: r.name, type: "UNKNOWN" as const };
    }
  });
  const projects = await Promise.all(typeChecks);
  const projectMap = new Map(projects.map((p) => [p.name.toLowerCase(), p]));

  // Build tier maps
  const tierMap = new Map<string, EnvironmentOverview>();
  function getOrCreateTier(tier: "production" | "staging" | "dev"): EnvironmentOverview {
    if (!tierMap.has(tier)) {
      const labels: Record<string, string> = { production: "Production", staging: "Staging", dev: "Development" };
      tierMap.set(tier, { tier, label: labels[tier], services: [], databases: [], clusters: [] });
    }
    return tierMap.get(tier)!;
  }

  // 1. Map EKS pods to tiers, infer project from pod/container name
  for (const cd of clusterData) {
    for (const pod of cd.pods) {
      const tier = inferTierFromNamespaceAndCluster(pod.namespace, cd.tiers);
      if (tier === "unknown") continue;

      // Try to match pod to a known project
      let projectName = "unknown";
      for (const p of projects) {
        if (matchPodToProject(pod.podName, pod.containerName, p.name)) {
          projectName = p.name;
          break;
        }
      }

      const env = getOrCreateTier(tier);
      env.services.push({
        project: projectName,
        podName: pod.podName,
        containerName: pod.containerName,
        namespace: pod.namespace,
        status: pod.status,
        restarts: pod.restarts,
        cpuUtil: pod.cpuUtil,
        memUtil: pod.memUtil,
        node: pod.nodeName,
        source: "eks",
        cluster: cd.clusterName,
      });

      if (!env.clusters.includes(cd.clusterName)) {
        env.clusters.push(cd.clusterName);
      }
    }
  }

  // 2. Map Vercel deployments to tiers
  for (const vp of vProjects) {
    try {
      const detail = await vercelService.getProjectDetail(vp.id);
      const projectName = vp.linkedRepo ?? vp.name;

      for (const vEnv of detail.environments) {
        const tier = vEnv.name === "Production" ? "production" as const
          : vEnv.name === "Staging" ? "staging" as const
          : "dev" as const;

        const env = getOrCreateTier(tier);
        env.services.push({
          project: projectName,
          podName: vEnv.branch ? `branch: ${vEnv.branch}` : vp.name,
          containerName: "vercel",
          namespace: vEnv.name.toLowerCase(),
          status: vEnv.state,
          restarts: 0,
          source: "vercel",
        });
      }
    } catch { /* skip failed project */ }
  }

  // 3. Map DB connections from secrets to tiers
  const mongoKeys = ["MONGODB_URI", "MONGO_URI", "DATABASE_URI", "MONGO_URL", "DB_URI", "MONGODB_URL"];
  for (const secret of secrets) {
    for (const key of mongoKeys) {
      const val = secret.values[key];
      if (!val) continue;
      const parsed = parseMongoUri(val);
      if (!parsed) continue;

      const tier = inferEnvironment(secret.name);
      if (tier === "unknown") continue;

      const matched = atlasClusters.find((c) =>
        c.connectionString && parsed.host.includes(
          c.connectionString.replace("mongodb+srv://", "").split("/")[0],
        ),
      );

      // Infer project from secret name
      let projectName = "unknown";
      for (const p of projects) {
        const lower = secret.name.toLowerCase();
        const pLower = p.name.toLowerCase();
        if (lower.includes(pLower) || lower.includes(pLower.replace(/-/g, "/"))) {
          projectName = p.name;
          break;
        }
      }

      const env = getOrCreateTier(tier as "production" | "staging" | "dev");
      env.databases.push({
        project: projectName,
        environment: tier,
        secretName: secret.name,
        secretKey: key,
        uri: val.replace(/\/\/[^:]+:[^@]+@/, "//***:***@"),
        host: parsed.host,
        database: parsed.database,
        matchedAtlasCluster: matched?.clusterName,
      });
    }
  }

  // Sort tiers: production -> staging -> dev
  const order = ["production", "staging", "dev"];
  const environments = order
    .map((t) => tierMap.get(t))
    .filter((e): e is EnvironmentOverview => !!e);

  return { environments, projects };
}
