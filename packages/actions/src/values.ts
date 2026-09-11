// Helm values Nebula writes to twizz-gitops for build-on-provision envs.
//  - apps/<service>/values.yaml   once per service (image repo, IRSA, quota…)
//  - apps/<service>/envs/<name>.yaml  per env (port, probes, non-secret env)
// The ApplicationSet layers the env file over the service file; secrets arrive
// via the chart's ExternalSecret from preview/<service>/<name> (envFrom).
import { Document as YamlDocument } from "yaml";

export const ECR_REGISTRY = "848281935985.dkr.ecr.eu-west-1.amazonaws.com";
export const PREVIEW_PODS_ROLE = "arn:aws:iam::848281935985:role/twizz-nonprod-preview-pods";

export function serviceValuesYaml(o: { service: string; ecrRepo: string; kind: "backend" | "frontend" | "worker" }): string {
  const doc = new YamlDocument({
    nameOverride: o.service,
    fullnameOverride: o.service,
    image: { repository: `${ECR_REGISTRY}/${o.ecrRepo}`, tag: "set-by-nebula", pullPolicy: "IfNotPresent" },
    replicaCount: 1,
    service: { type: "ClusterIP", port: o.kind === "frontend" ? 80 : 8080 },
    ingress: { enabled: true, className: "nginx", host: "", tls: { enabled: false }, annotations: { "nginx.ingress.kubernetes.io/proxy-body-size": "50m", "nginx.ingress.kubernetes.io/proxy-read-timeout": "300" } },
    serviceAccount: { create: true, roleArn: PREVIEW_PODS_ROLE },
    externalSecret: { enabled: true, secretStore: "aws-secrets-manager", remoteRef: "set-by-nebula", refreshInterval: "1m" },
    resources: { requests: { cpu: "100m", memory: "256Mi" }, limits: { memory: o.kind === "frontend" ? "256Mi" : "1Gi" } },
    ttl: "168h",
    namespace: {
      resourceQuota: { enabled: true, cpu: "2", memory: "4Gi", pods: "10" },
      networkPolicy: { enabled: true },
    },
  });
  doc.commentBefore = ` Written by Nebula for service "${o.service}" (build-on-provision). Per-env values live in envs/<name>.yaml; the ApplicationSet sets image.tag, ingress.host and externalSecret.remoteRef.`;
  return doc.toString({ lineWidth: 0 });
}

export function envValuesYaml(o: { name: string; port: number; healthPath: string; env: Record<string, string>; kind: "backend" | "frontend" | "worker" }): string {
  const env: Record<string, string> = {
    NODE_ENV: "production",
    PORT: String(o.port),
    HTTP_PORT: String(o.port),
    ...Object.fromEntries(Object.entries(o.env).sort(([a], [b]) => a.localeCompare(b))),
  };
  const probe = (delay: number, period: number) => ({ httpGet: { path: o.healthPath, port: "http" }, initialDelaySeconds: delay, periodSeconds: period });
  const doc = new YamlDocument({
    service: { port: o.port },
    readinessProbe: probe(10, 10),
    livenessProbe: probe(30, 30),
    env,
  });
  doc.commentBefore = ` Written by Nebula for env "${o.name}" from that branch's twizz.yaml. Non-secret only; secrets come from preview/<service>/${o.name}.`;
  return doc.toString({ lineWidth: 0 });
}
