import { createNetworking } from "./networking";
import { createEksCluster } from "./eks";
import { createEcrRepos } from "./ecr";
import { createIamRoles } from "./iam";
import { createDnsRecords } from "./dns";
import { bootstrapCluster } from "./bootstrap";
import { createNetbirdRouter } from "./netbird";
import { createAdminGate } from "./admin-gate";
import * as pulumi from "@pulumi/pulumi";

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

const cfg = new pulumi.Config();

const bootstrap = bootstrapCluster(
  eks.kubeconfig,
  { esoRoleArn: iam.esoRoleArn, certManagerRoleArn: iam.certManagerRoleArn },
  {
    privateSubnetIds: networking.privateSubnetIds,
    googleDomain: cfg.get("googleDomain") ?? "twizz.com",
    argocdAdmins: cfg.getObject<string[]>("argocdAdmins") ?? [],
  },
);

// Vercel admin apps proxied behind the VPN + an SSO email allowlist.
const adminGate = createAdminGate(
  bootstrap.provider,
  cfg.getObject<string[]>("adminAllowlist") ?? [],
);

// VPN-only access: internal NLB + NetBird routing peer advertising the VPC CIDR.
const netbird = createNetbirdRouter(networking.vpcId, networking.privateSubnetIds[0], networking.vpcCidr, tags);

const dns = createDnsRecords(bootstrap.ingressNlbDnsName, tags);

export const vpcId = networking.vpcId;
export const eksClusterName = eks.clusterName;
export const ecrRepoUrls = ecr;
export const ingressNlbDnsName = bootstrap.ingressNlbDnsName;
export const previewZoneNameservers = dns.nameservers; // NS records for "prv" in the twizz.com zone at Cloudflare (one-time)
export const wildcardDomain = dns.wildcardDomain;
export const argocdUrl = "https://argocd.prv.twizz.com";
export const previewPodsRoleArn = iam.previewPodsRoleArn;
export const ghaEcrPushRoleArn = iam.ghaEcrPushRoleArn;
export const dashboardRoleArn = iam.dashboardRoleArn;
export const mcpReadonlyRoleArn = iam.mcpReadonlyRoleArn;
export const mcpOperatorRoleArn = iam.mcpOperatorRoleArn;
export const nebulaReaperRoleArn = iam.nebulaReaperRoleArn;
export const nebulaDashboardRoleArn = iam.nebulaDashboardRoleArn;
export const netbirdRouterInstanceId = netbird.instanceId;
export const netbirdAdvertisedCidr = netbird.advertisedCidr; // add as a NetBird network route via group "routers"
export const ssoLoginUrl = "https://auth.prv.twizz.com/oauth2/start";
export const adminAppUrls = adminGate.adminHosts;
