import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

// Container Insights on EKS-Twizz-NonProd (docs/NEBULA.md §N7). Staging and prod
// ship pod logs + performance metrics to /aws/containerinsights/<cluster>/*;
// NonProd never did, so the Observer (and the MCP log tools) had nothing for
// previews and named envs. Same shape as the Moly clusters:
//   - EKS addon amazon-cloudwatch-observability (CloudWatch agent + Fluent Bit)
//   - its service account via EKS Pod Identity (Auto Mode ships the agent;
//     fixed ns/sa, so no IRSA wildcard needed) with CloudWatchAgentServerPolicy
//   - the four log groups pre-created with 1-day retention (staging/prod use 1 day;
//     otherwise the agent creates them with "never expire").
export function createNonprodObservability(clusterName: pulumi.Input<string>, tags: Record<string, string>, opts: { dependsOn?: pulumi.Resource[] } = {}) {
  const cluster = "EKS-Twizz-NonProd";

  const groups = ["application", "dataplane", "host", "performance"].map(
    (kind) =>
      new aws.cloudwatch.LogGroup(`ci-${kind}`, {
        name: `/aws/containerinsights/${cluster}/${kind}`,
        retentionInDays: 1,
        tags,
      }),
  );

  const role = new aws.iam.Role("nonprod-cloudwatch-agent", {
    name: "twizz-nonprod-cloudwatch-agent",
    description: "CloudWatch agent + Fluent Bit on EKS-Twizz-NonProd (ns amazon-cloudwatch), via EKS Pod Identity",
    assumeRolePolicy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Principal: { Service: "pods.eks.amazonaws.com" }, Action: ["sts:AssumeRole", "sts:TagSession"] }],
    }),
    tags,
  });
  new aws.iam.RolePolicyAttachment("nonprod-cloudwatch-agent-policy", {
    role: role.name,
    policyArn: "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy",
  });

  const assoc = new aws.eks.PodIdentityAssociation("nonprod-cloudwatch-agent", {
    clusterName,
    namespace: "amazon-cloudwatch",
    serviceAccount: "cloudwatch-agent",
    roleArn: role.arn,
    tags,
  });

  const addon = new aws.eks.Addon(
    "amazon-cloudwatch-observability",
    {
      clusterName,
      addonName: "amazon-cloudwatch-observability",
      resolveConflictsOnCreate: "OVERWRITE",
      resolveConflictsOnUpdate: "OVERWRITE",
      tags,
    },
    { dependsOn: [assoc, ...groups, ...(opts.dependsOn ?? [])] },
  );

  return { addonName: addon.addonName, agentRoleArn: role.arn };
}
