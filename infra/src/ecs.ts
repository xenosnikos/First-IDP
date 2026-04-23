import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as pulumi from "@pulumi/pulumi";

export function createEcsService(
  vpcId: pulumi.Output<string>,
  publicSubnetIds: pulumi.Output<string>[],
  privateSubnetIds: pulumi.Output<string>[],
  imageUri: pulumi.Output<string>,
  rdsEndpoint: pulumi.Output<string>,
  rdsDbName: pulumi.Output<string>,
  tags: Record<string, string>,
) {
  const cluster = new aws.ecs.Cluster("twizz-idp", {
    name: "twizz-idp",
    tags,
  });

  const alb = new awsx.lb.ApplicationLoadBalancer("twizz-idp-alb", {
    subnetIds: publicSubnetIds,
    tags,
  });

  const service = new awsx.ecs.FargateService("twizz-idp-dashboard", {
    cluster: cluster.arn,
    desiredCount: 1,
    networkConfiguration: {
      subnets: privateSubnetIds,
      assignPublicIp: false,
    },
    taskDefinitionArgs: {
      container: {
        name: "dashboard",
        image: imageUri,
        cpu: 512,
        memory: 1024,
        essential: true,
        portMappings: [{
          containerPort: 3000,
          targetGroup: alb.defaultTargetGroup,
        }],
        environment: [
          { name: "NODE_ENV", value: "production" },
          { name: "PORT", value: "3000" },
        ],
      },
    },
    tags,
  });

  return {
    clusterArn: cluster.arn,
    serviceArn: service.service.id,
    albDnsName: alb.loadBalancer.dnsName,
  };
}
