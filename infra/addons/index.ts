// twizz-idp platform add-ons (docs/NEBULA.md §N8). A separate stack because the original
// infra/ state was lost (infra/CLAUDE.md): everything here REFERENCES existing resources by
// name (roles, the NonProd cluster) and creates only new ones. Never import core resources here.
import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { createNonprodObservability } from "../src/observability";

const tags = { Project: "twizz-idp", Stack: "addons" };
const acct = "848281935985";
const region = "eu-west-1";

// ── 1. Container Insights on EKS-Twizz-NonProd (Observer / MCP logs for previews + named envs)
export const nonprodObservability = createNonprodObservability("EKS-Twizz-NonProd", tags);

// ── 2. twizz-sentinel log archive (s3://…/env=<env>/dt=YYYY-MM-DD/*.jsonl.gz) ──────────────
// Raw monolith log lines (user ids, IPs): private, SSE-KMS, TLS-only, expires after 365 days.
const archiveName = `twizz-sentinel-logs-${acct}`;
const archive = new aws.s3.BucketV2("sentinel-archive", { bucket: archiveName, tags: { ...tags, Purpose: "sentinel-log-archive", Data: "pii" } });
new aws.s3.BucketPublicAccessBlock("sentinel-archive", { bucket: archive.id, blockPublicAcls: true, ignorePublicAcls: true, blockPublicPolicy: true, restrictPublicBuckets: true });
new aws.s3.BucketOwnershipControls("sentinel-archive", { bucket: archive.id, rule: { objectOwnership: "BucketOwnerEnforced" } });
new aws.s3.BucketServerSideEncryptionConfigurationV2("sentinel-archive", { bucket: archive.id, rules: [{ applyServerSideEncryptionByDefault: { sseAlgorithm: "aws:kms" }, bucketKeyEnabled: true }] });
new aws.s3.BucketLifecycleConfigurationV2("sentinel-archive", {
  bucket: archive.id,
  rules: [
    { id: "expire-logs-365d", status: "Enabled", filter: { prefix: "env=" }, expiration: { days: 365 }, abortIncompleteMultipartUpload: { daysAfterInitiation: 1 } },
    { id: "expire-athena-results-7d", status: "Enabled", filter: { prefix: "athena-results/" }, expiration: { days: 7 } },
  ],
});
new aws.s3.BucketPolicy("sentinel-archive", {
  bucket: archive.id,
  policy: pulumi.jsonStringify({
    Version: "2012-10-17",
    Statement: [{ Sid: "TlsOnly", Effect: "Deny", Principal: "*", Action: "s3:*", Resource: [archive.arn, pulumi.interpolate`${archive.arn}/*`], Condition: { Bool: { "aws:SecureTransport": "false" } } }],
  }),
});

// ── 3. Athena: workgroup with enforced, encrypted results + a per-query scan cap; table with partition projection
export const athenaWorkgroup = new aws.athena.Workgroup("sentinel", {
  name: "sentinel",
  forceDestroy: true,
  configuration: {
    enforceWorkgroupConfiguration: true,
    publishCloudwatchMetricsEnabled: true,
    bytesScannedCutoffPerQuery: 10 * 1024 ** 3, // 10 GiB per query
    // results land under athena-results/ and inherit the bucket default (SSE-KMS); expire after 7 days
    resultConfiguration: { outputLocation: pulumi.interpolate`s3://${archive.bucket}/athena-results/` },
  },
  tags,
}).name;
const db = new aws.glue.CatalogDatabase("sentinel-logs", { name: "sentinel_logs", description: "twizz-sentinel raw log archive (twizz-sentinel deploy/athena-sentinel-logs.sql)" });
new aws.glue.CatalogTable("sentinel-app-logs", {
  name: "sentinel_app_logs",
  databaseName: db.name,
  tableType: "EXTERNAL_TABLE",
  parameters: {
    EXTERNAL: "TRUE",
    "projection.enabled": "true",
    "projection.env.type": "enum",
    "projection.env.values": "prod,staging",
    "projection.dt.type": "date",
    "projection.dt.format": "yyyy-MM-dd",
    "projection.dt.interval": "1",
    "projection.dt.interval.unit": "DAYS",
    "projection.dt.range": "2026-11-06,NOW",
    "storage.location.template": pulumi.interpolate`s3://${archive.bucket}/env=\${env}/dt=\${dt}/`,
  },
  partitionKeys: [
    { name: "env", type: "string" },
    { name: "dt", type: "string" },
  ],
  storageDescriptor: {
    location: pulumi.interpolate`s3://${archive.bucket}/`,
    inputFormat: "org.apache.hadoop.mapred.TextInputFormat",
    outputFormat: "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat",
    serDeInfo: { serializationLibrary: "org.openx.data.jsonserde.JsonSerDe" },
    columns: [
      { name: "ts", type: "bigint", comment: "epoch milliseconds" },
      { name: "pod", type: "string", comment: "kubernetes pod (log stream)" },
      { name: "msg", type: "string", comment: "the raw log line" },
    ],
  },
});

// ── 4. IAM on EXISTING roles (created outside this stack; referenced by name) ───────────────
// prod sentinel (deploy/prod/bootstrap-prod.sh): write ITS prefix only + Titan embeddings
new aws.iam.RolePolicy("prod-sentinel-archive-embeddings", {
  role: "twizz-prod-sentinel",
  name: "twizz-prod-sentinel-archive-embeddings",
  policy: pulumi.jsonStringify({
    Version: "2012-10-17",
    Statement: [
      { Sid: "ArchiveWriteProdPrefix", Effect: "Allow", Action: ["s3:PutObject", "s3:AbortMultipartUpload"], Resource: pulumi.interpolate`${archive.arn}/env=prod/*` },
      { Sid: "ArchiveBucketProbe", Effect: "Allow", Action: ["s3:GetBucketLocation"], Resource: archive.arn },
      { Sid: "TitanEmbeddings", Effect: "Allow", Action: ["bedrock:InvokeModel"], Resource: `arn:aws:bedrock:${region}::foundation-model/amazon.titan-embed-text-v2:0` },
    ],
  }),
});

// Nebula (twizz-nebula-dashboard): READ the archive through the sentinel workgroup only
// staging sentinel (twizz-idp infra/src/staging.ts, state lost — referenced by name): write ITS
// prefix only. Titan embeddings are already in its own policy.
new aws.iam.RolePolicy("staging-sentinel-archive", {
  role: "twizz-staging-sentinel",
  name: "twizz-staging-sentinel-archive",
  policy: pulumi.jsonStringify({
    Version: "2012-10-17",
    Statement: [
      { Sid: "ArchiveWriteStagingPrefix", Effect: "Allow", Action: ["s3:PutObject", "s3:AbortMultipartUpload"], Resource: pulumi.interpolate`${archive.arn}/env=staging/*` },
      { Sid: "ArchiveBucketProbe", Effect: "Allow", Action: ["s3:GetBucketLocation"], Resource: archive.arn },
    ],
  }),
});

new aws.iam.RolePolicy("nebula-sentinel-archive-read", {
  role: "twizz-nebula-dashboard",
  name: "twizz-nebula-dashboard-sentinel-archive-read",
  policy: pulumi.jsonStringify({
    Version: "2012-10-17",
    Statement: [
      { Sid: "AthenaSentinelWorkgroup", Effect: "Allow", Action: ["athena:StartQueryExecution", "athena:GetQueryExecution", "athena:GetQueryResults", "athena:StopQueryExecution", "athena:GetWorkGroup"], Resource: `arn:aws:athena:${region}:${acct}:workgroup/sentinel` },
      { Sid: "GlueSentinelCatalog", Effect: "Allow", Action: ["glue:GetDatabase", "glue:GetTable", "glue:GetPartitions"], Resource: [`arn:aws:glue:${region}:${acct}:catalog`, `arn:aws:glue:${region}:${acct}:database/sentinel_logs`, `arn:aws:glue:${region}:${acct}:table/sentinel_logs/sentinel_app_logs`] },
      { Sid: "ArchiveRead", Effect: "Allow", Action: ["s3:GetObject"], Resource: [pulumi.interpolate`${archive.arn}/env=prod/*`, pulumi.interpolate`${archive.arn}/env=staging/*`] },
      { Sid: "ArchiveList", Effect: "Allow", Action: ["s3:ListBucket", "s3:GetBucketLocation"], Resource: archive.arn },
      { Sid: "AthenaResults", Effect: "Allow", Action: ["s3:GetObject", "s3:PutObject", "s3:AbortMultipartUpload"], Resource: pulumi.interpolate`${archive.arn}/athena-results/*` },
    ],
  }),
});

export const archiveBucket = archive.bucket;

// ── 5. PLO in Nebula (docs/NEBULA.md §N9): the read-only identity of the plo CronJobs ───────
// CronJobs plo-plan / plo-cve / plo-dispatch (twizz-gitops apps/nebula/plo.yaml, SA `plo`) list
// what runs on the three clusters and what is newer. REPORT ONLY: no Update*, no Create*, no
// Delete*, no iam, no secretsmanager, no S3. The job that runs application repo code
// (plo-source, SA `plo-source`) has NO role at all and is not trusted here.
// On each cluster the role gets AmazonEKSViewPolicy (no Secrets) and the group `nebula-plo`, which
// has no rights until scripts/nebula-plo-access.sh applies infra/k8s/nebula-plo-rbac.yaml.
export const PLO_CLUSTERS = ["EKS-Twizz-NonProd", "EKS-Moly-staging", "EKS-Moly-Prod"] as const;
export const PLO_K8S_GROUP = "nebula-plo";

const ploHostCluster = aws.eks.getClusterOutput({ name: "EKS-Twizz-NonProd" });
const ploOidc = aws.iam.getOpenIdConnectProviderOutput({ url: ploHostCluster.identities[0].oidcs[0].issuer });
const ploRole = new aws.iam.Role("twizz-nebula-plo", {
  name: "twizz-nebula-plo",
  description: "Nebula PLO CronJobs (ns nebula, SA plo) on EKS-Twizz-NonProd: read-only EKS/SSM/CloudWatch/EC2 for lifecycle reports",
  assumeRolePolicy: pulumi.all([ploOidc.arn, ploOidc.url]).apply(([arn, url]) => {
    const host = url.replace(/^https?:\/\//, "");
    return JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Federated: arn },
          Action: "sts:AssumeRoleWithWebIdentity",
          // exactly one ServiceAccount; never a wildcard (plo-source must not match)
          Condition: { StringEquals: { [`${host}:sub`]: "system:serviceaccount:nebula:plo", [`${host}:aud`]: "sts.amazonaws.com" } },
        },
      ],
    });
  }),
  tags,
});

const ploClusterArns = PLO_CLUSTERS.flatMap((c) => [
  `arn:aws:eks:${region}:${acct}:cluster/${c}`,
  `arn:aws:eks:${region}:${acct}:addon/${c}/*/*`,
  `arn:aws:eks:${region}:${acct}:nodegroup/${c}/*/*`,
]);
new aws.iam.RolePolicy("nebula-plo-read", {
  role: ploRole.name,
  name: "twizz-nebula-plo-read",
  policy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "EksReadThreeClusters",
        Effect: "Allow",
        Action: ["eks:DescribeCluster", "eks:ListAddons", "eks:DescribeAddon", "eks:ListNodegroups", "eks:DescribeNodegroup", "eks:ListUpdates", "eks:DescribeUpdate", "eks:ListInsights", "eks:DescribeInsight"],
        Resource: ploClusterArns,
      },
      // version catalogues: these actions have no resource-level form
      { Sid: "EksVersionCatalogues", Effect: "Allow", Action: ["eks:ListClusters", "eks:DescribeAddonVersions", "eks:DescribeAddonConfiguration", "eks:DescribeClusterVersions"], Resource: "*" },
      // AWS-published AMI release parameters only (public, account-less ARNs); no account parameter is readable
      {
        Sid: "PublicAmiParameters",
        Effect: "Allow",
        Action: ["ssm:GetParameter", "ssm:GetParameters"],
        Resource: [`arn:aws:ssm:${region}::parameter/aws/service/eks/*`, `arn:aws:ssm:${region}::parameter/aws/service/bottlerocket/*`],
      },
      { Sid: "CloudWatchRead", Effect: "Allow", Action: ["cloudwatch:DescribeAlarms", "cloudwatch:GetMetricStatistics", "cloudwatch:GetMetricData", "cloudwatch:ListMetrics"], Resource: "*" },
      // Deliberately NOT ec2:DescribeLaunchTemplateVersions: versions carry instance user data.
      { Sid: "Ec2ImagesAndTemplates", Effect: "Allow", Action: ["ec2:DescribeImages", "ec2:DescribeLaunchTemplates"], Resource: "*" },
    ],
  }),
});

for (const cluster of PLO_CLUSTERS) {
  const entry = new aws.eks.AccessEntry(`nebula-plo-${cluster.toLowerCase()}`, {
    clusterName: cluster,
    principalArn: ploRole.arn,
    type: "STANDARD",
    kubernetesGroups: [PLO_K8S_GROUP],
    tags,
  });
  new aws.eks.AccessPolicyAssociation(
    `nebula-plo-view-${cluster.toLowerCase()}`,
    {
      clusterName: cluster,
      principalArn: ploRole.arn,
      policyArn: "arn:aws:eks::aws:cluster-access-policy/AmazonEKSViewPolicy",
      accessScope: { type: "cluster" },
    },
    { dependsOn: [entry] },
  );
}

export const ploRoleArn = ploRole.arn;
