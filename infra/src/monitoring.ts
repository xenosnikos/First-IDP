import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export function createMonitoring(provider: k8s.Provider) {
  const ns = new k8s.core.v1.Namespace("monitoring", {
    metadata: { name: "monitoring" },
  }, { provider });

  new k8s.helm.v3.Release("kube-prometheus-stack", {
    chart: "kube-prometheus-stack",
    version: "65.1.0",
    namespace: "monitoring",
    repositoryOpts: { repo: "https://prometheus-community.github.io/helm-charts" },
    values: {
      grafana: {
        adminPassword: new pulumi.Config().getSecret("grafanaPassword") ?? "admin",
        ingress: { enabled: true, ingressClassName: "nginx", hosts: ["grafana.dev.twizz.app"] },
      },
    },
  }, { provider, dependsOn: [ns] });
}
