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
