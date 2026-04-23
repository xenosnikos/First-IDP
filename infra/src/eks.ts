import * as eks from "@pulumi/eks";
import * as pulumi from "@pulumi/pulumi";

export function createEksCluster(
  vpcId: pulumi.Output<string>,
  privateSubnetIds: pulumi.Output<string>[],
  publicSubnetIds: pulumi.Output<string>[],
  tags: Record<string, string>,
) {
  const cluster = new eks.Cluster("EKS-Twizz-NonProd", {
    name: "EKS-Twizz-NonProd",
    vpcId,
    privateSubnetIds,
    publicSubnetIds,
    instanceType: "t3.xlarge",
    desiredCapacity: 2,
    minSize: 1,
    maxSize: 6,
    nodeAssociatePublicIpAddress: false,
    version: "1.30",
    tags,
  });

  return {
    clusterName: pulumi.output("EKS-Twizz-NonProd"),
    kubeconfig: cluster.kubeconfig,
    oidcProviderArn: cluster.core.oidcProvider?.arn ?? pulumi.output(""),
    oidcProviderUrl: cluster.core.oidcProvider?.url ?? pulumi.output(""),
    ingressNlbDnsName: pulumi.output("placeholder-nlb.elb.eu-west-1.amazonaws.com"),
  };
}
