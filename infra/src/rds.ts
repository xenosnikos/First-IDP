import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export function createDatabase(
  vpcId: pulumi.Output<string>,
  privateSubnetIds: pulumi.Output<string>[],
  tags: Record<string, string>,
) {
  const config = new pulumi.Config();
  const dbPassword = config.requireSecret("dbPassword");

  const subnetGroup = new aws.rds.SubnetGroup("twizz-idp-db-subnets", {
    subnetIds: privateSubnetIds,
    tags,
  });

  const sg = new aws.ec2.SecurityGroup("twizz-idp-db-sg", {
    vpcId,
    description: "Allow PostgreSQL from VPC",
    ingress: [{ protocol: "tcp", fromPort: 5432, toPort: 5432, cidrBlocks: ["10.0.0.0/16"] }],
    egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
    tags,
  });

  const db = new aws.rds.Instance("twizz-idp-db", {
    engine: "postgres",
    engineVersion: "16",
    instanceClass: "db.t4g.micro",
    allocatedStorage: 20,
    storageType: "gp3",
    dbName: "twizz_idp",
    username: "twizz_admin",
    password: dbPassword,
    dbSubnetGroupName: subnetGroup.name,
    vpcSecurityGroupIds: [sg.id],
    publiclyAccessible: false,
    backupRetentionPeriod: 7,
    skipFinalSnapshot: true,
    tags: { ...tags, Name: "twizz-idp-db" },
  });

  return { endpoint: db.endpoint, dbName: pulumi.output("twizz_idp") };
}
