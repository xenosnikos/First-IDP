import * as aws from "@pulumi/aws";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

// Release train (docs/NEBULA.md §N4): what lets the NON-PROD Argo CD deploy the
// staging tier of twizz-sentinel + twizz-admin into ONE namespace on
// EKS-Moly-staging, and nothing else there.
//
//   1. an IRSA role for the Argo CD service accounts (non-prod OIDC)
//   2. an EKS access entry on the staging cluster for that role, scoped to
//      namespace `sentinel` (AmazonEKSAdminPolicy, type namespace — no
//      cluster-wide grant of any kind)
//   3. the Argo CD cluster secret in "namespaced mode" (namespaces: sentinel,
//      clusterResources: false) — Argo will not even list cluster-scoped kinds
//   4. an IRSA role on the STAGING cluster's OIDC provider for the sentinel pod
//      (logs read, its own SM blob, Bedrock embeddings — no WAF/S3 until asked)
//   5. DNS: <svc>.stg.prv.twizz.com → the staging ingress-nginx ELB
//
// EKS-Moly-staging itself stays unmanaged by Pulumi (it predates this repo);
// only account-level resources (IAM, access entries, Route53) are created here.
// Prod has no equivalent of this file and must never get one.

export const STAGING_CLUSTER = "EKS-Moly-staging";
export const STAGING_NAMESPACE = "sentinel";
/** Argo CD cluster name (destination.name in AppProject/Applications). */
export const STAGING_ARGO_NAME = "eks-moly-staging";

export function createStagingAccess(
  nonprod: { oidcProviderArn: pulumi.Output<string>; oidcProviderUrl: pulumi.Output<string> },
  tags: Record<string, string>,
) {
  const accountId = aws.getCallerIdentityOutput().accountId;
  const region = "eu-west-1";
  const staging = aws.eks.getClusterOutput({ name: STAGING_CLUSTER });

  // ── 1. Argo CD deployer role (IRSA on non-prod) ──────────────────
  const argoSubjects = ["argocd-application-controller", "argocd-server", "argocd-applicationset-controller"].map((sa) => `system:serviceaccount:argocd:${sa}`);
  const argocdDeployerRole = new aws.iam.Role("twizz-argocd-staging-deployer", {
    name: "twizz-argocd-staging-deployer",
    description: "Argo CD on EKS-Twizz-NonProd → EKS-Moly-staging, namespace sentinel only (release train)",
    assumeRolePolicy: pulumi.all([nonprod.oidcProviderArn, nonprod.oidcProviderUrl]).apply(([arn, url]) => {
      const host = url.replace(/^https?:\/\//, "");
      return JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Federated: arn },
            Action: "sts:AssumeRoleWithWebIdentity",
            Condition: { StringEquals: { [`${host}:sub`]: argoSubjects, [`${host}:aud`]: "sts.amazonaws.com" } },
          },
        ],
      });
    }),
    tags,
  });
  new aws.iam.RolePolicy("twizz-argocd-staging-deployer-policy", {
    role: argocdDeployerRole.id,
    policy: staging.arn.apply((arn) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [{ Sid: "DescribeStagingCluster", Effect: "Allow", Action: ["eks:DescribeCluster"], Resource: arn }],
      }),
    ),
  });

  // ── 2. EKS access entry on staging, namespace-scoped ─────────────
  const entry = new aws.eks.AccessEntry("staging-argocd-access", {
    clusterName: STAGING_CLUSTER,
    principalArn: argocdDeployerRole.arn,
    type: "STANDARD",
    tags,
  });
  new aws.eks.AccessPolicyAssociation(
    "staging-argocd-namespace-admin",
    {
      clusterName: STAGING_CLUSTER,
      principalArn: argocdDeployerRole.arn,
      policyArn: "arn:aws:eks::aws:cluster-access-policy/AmazonEKSAdminPolicy",
      accessScope: { type: "namespace", namespaces: [STAGING_NAMESPACE] },
    },
    { dependsOn: [entry] },
  );

  // ── 4. sentinel pod role (IRSA on the STAGING cluster) ───────────
  const stagingOidc = aws.iam.getOpenIdConnectProviderOutput({ url: staging.identities[0].oidcs[0].issuer });
  const sentinelRole = new aws.iam.Role("twizz-staging-sentinel", {
    name: "twizz-staging-sentinel",
    description: "twizz-sentinel pods on EKS-Moly-staging (ns sentinel): CloudWatch Logs read, SM staging/twizz-sentinel, Bedrock embeddings",
    assumeRolePolicy: pulumi.all([stagingOidc.arn, stagingOidc.url]).apply(([arn, url]) => {
      const host = url.replace(/^https?:\/\//, "");
      return JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Federated: arn },
            Action: "sts:AssumeRoleWithWebIdentity",
            Condition: { StringEquals: { [`${host}:sub`]: `system:serviceaccount:${STAGING_NAMESPACE}:twizz-sentinel`, [`${host}:aud`]: "sts.amazonaws.com" } },
          },
        ],
      });
    }),
    tags,
  });
  new aws.iam.RolePolicy("twizz-staging-sentinel-policy", {
    role: sentinelRole.id,
    policy: accountId.apply((acct) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            // twizz-sentinel/deploy/iam-policy.json TailMonolithLogs, on the Container Insights group
            Sid: "TailStagingMonolithLogs",
            Effect: "Allow",
            Action: ["logs:DescribeLogStreams", "logs:FilterLogEvents", "logs:GetLogEvents", "logs:StartLiveTail"],
            Resource: [`arn:aws:logs:${region}:${acct}:log-group:/aws/containerinsights/${STAGING_CLUSTER}/application`, `arn:aws:logs:${region}:${acct}:log-group:/aws/containerinsights/${STAGING_CLUSTER}/application:*`],
          },
          { Sid: "DescribeAnyGroupForArnLookup", Effect: "Allow", Action: ["logs:DescribeLogGroups"], Resource: "*" },
          { Sid: "OwnConfigBlob", Effect: "Allow", Action: ["secretsmanager:GetSecretValue"], Resource: `arn:aws:secretsmanager:${region}:${acct}:secret:staging/twizz-sentinel*` },
          { Sid: "TitanEmbeddings", Effect: "Allow", Action: ["bedrock:InvokeModel"], Resource: `arn:aws:bedrock:${region}::foundation-model/amazon.titan-embed-text-v2:0` },
          // WafBlocklist / ArchiveLogBucket deliberately absent: SENTINEL_ACTIONS_ENABLED and
          // ARCHIVE_ENABLED are "false" in apps/twizz-sentinel/values-staging.yaml until asked.
        ],
      }),
    ),
  });

  return {
    argocdDeployerRoleArn: argocdDeployerRole.arn,
    sentinelRoleArn: sentinelRole.arn,
    stagingEndpoint: staging.endpoint,
    stagingCaData: staging.certificateAuthorities[0].data,
  };
}

/** 3 + 5: the Argo CD cluster secret (needs the bootstrap provider) and the
 * two staging hostnames in the prv.twizz.com zone. */
export function registerStagingCluster(
  provider: k8s.Provider,
  access: ReturnType<typeof createStagingAccess>,
  dns: { zoneId: pulumi.Output<string>; ingressHostname: string },
  argocd: pulumi.Resource,
) {
  const clusterSecret = new k8s.core.v1.Secret(
    "argocd-cluster-eks-moly-staging",
    {
      metadata: {
        name: `cluster-${STAGING_ARGO_NAME}`,
        namespace: "argocd",
        labels: { "argocd.argoproj.io/secret-type": "cluster", "twizz-idp/tier": "staging" },
      },
      stringData: {
        name: STAGING_ARGO_NAME,
        server: access.stagingEndpoint,
        // namespaced mode: Argo only watches/applies inside this namespace and
        // never touches cluster-scoped resources on the staging cluster
        namespaces: STAGING_NAMESPACE,
        clusterResources: "false",
        config: access.stagingCaData.apply((ca) =>
          JSON.stringify({
            // argocd-k8s-auth signs the EKS token with the pod's IRSA credentials
            awsAuthConfig: { clusterName: STAGING_CLUSTER },
            tlsClientConfig: { insecure: false, caData: ca },
          }),
        ),
      },
    },
    { provider, dependsOn: [argocd] },
  );

  const hosts = ["sentinel", "admin"].map(
    (short) =>
      new aws.route53.Record(`staging-${short}-host`, {
        zoneId: dns.zoneId,
        name: `${short}.stg.prv.twizz.com`,
        type: "CNAME",
        ttl: 300,
        records: [dns.ingressHostname],
      }),
  );

  return { clusterSecretName: clusterSecret.metadata.name, hosts: hosts.map((h) => h.fqdn) };
}
