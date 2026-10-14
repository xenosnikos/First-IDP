import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

// Capacity control (docs/NEBULA.md §N5) on the two Moly clusters, by decision
// of the platform owner (2026-10-14): Nebula reads live state on EKS-Moly-Prod
// and EKS-Moly-staging and may resize ONLY workloads in ns default + jobs
// (replicas / HPA / container resources) and the clusters' managed node
// groups (min / desired / max). Everything else stays out of reach.
//
// What this module creates (account-level; it never creates cluster objects):
//   - EKS access entries for the dashboard's IRSA role, mapped to the
//     Kubernetes group `nebula-capacity`. The group has NO rights until the
//     RBAC in infra/k8s/nebula-capacity-rbac.yaml is applied to the cluster
//     (scripts/nebula-capacity-access.sh) — an entry alone grants nothing.
//   - eks:Describe/List/UpdateNodegroupConfig on those clusters' node groups.
// The prod API allowlist (publicAccessCidrs) is not Pulumi-managed (the cluster
// is not ours); scripts/nebula-capacity-access.sh adds Nebula's NAT IP to it.

export const CAPACITY_CLUSTERS = ["EKS-Moly-Prod", "EKS-Moly-staging"] as const;
export const CAPACITY_K8S_GROUP = "nebula-capacity";

export function createCapacityAccess(dashboardRole: { name: pulumi.Input<string>; arn: pulumi.Input<string> }, tags: Record<string, string>) {
  const region = aws.getRegionOutput().name;
  const accountId = aws.getCallerIdentityOutput().accountId;

  new aws.iam.RolePolicy("twizz-nebula-dashboard-capacity", {
    role: dashboardRole.name,
    policy: pulumi.all([region, accountId]).apply(([r, acct]) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "NodegroupsRead",
            Effect: "Allow",
            Action: ["eks:ListNodegroups", "eks:DescribeNodegroup"],
            Resource: CAPACITY_CLUSTERS.flatMap((c) => [`arn:aws:eks:${r}:${acct}:cluster/${c}`, `arn:aws:eks:${r}:${acct}:nodegroup/${c}/*/*`]),
          },
          {
            // scaling config only; the dashboard gates + caps every call
            Sid: "NodegroupsScale",
            Effect: "Allow",
            Action: ["eks:UpdateNodegroupConfig"],
            Resource: CAPACITY_CLUSTERS.map((c) => `arn:aws:eks:${r}:${acct}:nodegroup/${c}/*/*`),
          },
        ],
      }),
    ),
  });

  for (const cluster of CAPACITY_CLUSTERS) {
    new aws.eks.AccessEntry(`nebula-capacity-${cluster.toLowerCase()}`, {
      clusterName: cluster,
      principalArn: dashboardRole.arn,
      type: "STANDARD",
      kubernetesGroups: [CAPACITY_K8S_GROUP],
      tags,
    });
  }
}
