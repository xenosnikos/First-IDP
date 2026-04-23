import * as pulumi from "@pulumi/pulumi";
import { createNetworking } from "./networking";
import { createEksCluster } from "./eks";
import { createEcsService } from "./ecs";
import { createDatabase } from "./rds";
import { createEcrRepos } from "./ecr";
import { createIamRoles } from "./iam";
import { createDnsRecords } from "./dns";

const tags = { Project: "twizz-idp" };

const networking = createNetworking(tags);
const ecr = createEcrRepos(tags);

const eks = createEksCluster(
  networking.vpcId,
  networking.privateSubnetIds,
  networking.publicSubnetIds,
  tags,
);

const iam = createIamRoles(eks.oidcProviderArn, eks.oidcProviderUrl, tags);

const rds = createDatabase(networking.vpcId, networking.privateSubnetIds, tags);

const ecs = createEcsService(
  networking.vpcId,
  networking.publicSubnetIds,
  networking.privateSubnetIds,
  ecr.idpRepoUrl,
  rds.endpoint,
  rds.dbName,
  tags,
);

const dns = createDnsRecords(ecs.albDnsName, eks.ingressNlbDnsName);

export const vpcId = networking.vpcId;
export const eksClusterName = eks.clusterName;
export const eksKubeconfig = eks.kubeconfig;
export const ecsClusterArn = ecs.clusterArn;
export const idpUrl = pulumi.interpolate`https://idp.twizz.app`;
export const rdsEndpoint = rds.endpoint;
export const ecrRepoUrls = ecr;
export const iamRoles = iam;
export const dnsRecords = dns;
