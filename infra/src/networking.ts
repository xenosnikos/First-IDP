import * as aws from "@pulumi/aws";

export function createNetworking(tags: Record<string, string>) {
  const vpc = new aws.ec2.Vpc("twizz-idp-vpc", {
    cidrBlock: "10.0.0.0/16",
    enableDnsSupport: true,
    enableDnsHostnames: true,
    tags: { ...tags, Name: "twizz-idp-vpc" },
  });

  const azs = ["eu-west-1a", "eu-west-1b", "eu-west-1c"];

  const publicSubnets = azs.map((az, i) =>
    new aws.ec2.Subnet(`twizz-idp-public-${i}`, {
      vpcId: vpc.id,
      cidrBlock: `10.0.${i + 1}.0/24`,
      availabilityZone: az,
      mapPublicIpOnLaunch: true,
      tags: { ...tags, Name: `twizz-idp-public-${az}` },
    })
  );

  const privateSubnets = azs.map((az, i) =>
    new aws.ec2.Subnet(`twizz-idp-private-${i}`, {
      vpcId: vpc.id,
      cidrBlock: `10.0.${i + 11}.0/24`,
      availabilityZone: az,
      tags: { ...tags, Name: `twizz-idp-private-${az}` },
    })
  );

  const igw = new aws.ec2.InternetGateway("twizz-idp-igw", {
    vpcId: vpc.id,
    tags: { ...tags, Name: "twizz-idp-igw" },
  });

  const publicRt = new aws.ec2.RouteTable("twizz-idp-public-rt", {
    vpcId: vpc.id,
    routes: [{ cidrBlock: "0.0.0.0/0", gatewayId: igw.id }],
    tags: { ...tags, Name: "twizz-idp-public-rt" },
  });

  publicSubnets.forEach((subnet, i) =>
    new aws.ec2.RouteTableAssociation(`twizz-idp-public-rta-${i}`, {
      subnetId: subnet.id,
      routeTableId: publicRt.id,
    })
  );

  const eip = new aws.ec2.Eip("twizz-idp-nat-eip", { tags });
  const natGw = new aws.ec2.NatGateway("twizz-idp-nat", {
    allocationId: eip.id,
    subnetId: publicSubnets[0].id,
    tags: { ...tags, Name: "twizz-idp-nat" },
  });

  const privateRt = new aws.ec2.RouteTable("twizz-idp-private-rt", {
    vpcId: vpc.id,
    routes: [{ cidrBlock: "0.0.0.0/0", natGatewayId: natGw.id }],
    tags: { ...tags, Name: "twizz-idp-private-rt" },
  });

  privateSubnets.forEach((subnet, i) =>
    new aws.ec2.RouteTableAssociation(`twizz-idp-private-rta-${i}`, {
      subnetId: subnet.id,
      routeTableId: privateRt.id,
    })
  );

  return {
    vpcId: vpc.id,
    publicSubnetIds: publicSubnets.map(s => s.id),
    privateSubnetIds: privateSubnets.map(s => s.id),
  };
}
