// Kubernetes bearer tokens for EKS, the same scheme as `aws eks get-token`:
// a SigV4-presigned STS GetCallerIdentity URL (with the cluster name bound in
// the signed `x-k8s-aws-id` header), base64url-encoded behind `k8s-aws-v1.`.
// Implemented on node:crypto so the dashboard needs no extra signing deps;
// credentials come from the SDK's default chain (IRSA in-cluster).
import { createHash, createHmac } from "node:crypto";
import { EKSClient, DescribeClusterCommand, DescribeNodegroupCommand, ListNodegroupsCommand, UpdateNodegroupConfigCommand } from "@aws-sdk/client-eks";

export type AwsCreds = { accessKeyId: string; secretAccessKey: string; sessionToken?: string };

const hmac = (key: Buffer | string, s: string) => createHmac("sha256", key).update(s, "utf8").digest();
const sha256hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
// RFC 3986 encoding, as SigV4 requires
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Presign GET sts:GetCallerIdentity for `cluster` and wrap it as an EKS token. Pure (time injectable). */
export function eksTokenFor(o: { cluster: string; region: string; creds: AwsCreds; now?: Date; expiresSec?: number }): string {
  const now = o.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // YYYYMMDDTHHMMSSZ
  const date = amzDate.slice(0, 8);
  const host = `sts.${o.region}.amazonaws.com`;
  const scope = `${date}/${o.region}/sts/aws4_request`;
  const query: Record<string, string> = {
    Action: "GetCallerIdentity",
    Version: "2011-06-15",
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${o.creds.accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(o.expiresSec ?? 60),
    "X-Amz-SignedHeaders": "host;x-k8s-aws-id",
    ...(o.creds.sessionToken ? { "X-Amz-Security-Token": o.creds.sessionToken } : {}),
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${enc(k)}=${enc(query[k])}`)
    .join("&");
  const canonicalRequest = ["GET", "/", canonicalQuery, `host:${host}`, `x-k8s-aws-id:${o.cluster}`, "", "host;x-k8s-aws-id", sha256hex("")].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${o.creds.secretAccessKey}`, date), o.region), "sts"), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  const url = `https://${host}/?${canonicalQuery}&X-Amz-Signature=${signature}`;
  return `k8s-aws-v1.${Buffer.from(url).toString("base64url")}`;
}

export type EksAccess = { cluster: string; server: string; caData: string; token: string };

const eks = new EKSClient({ region: process.env.AWS_REGION ?? "eu-west-1" });

/** Endpoint + CA from DescribeCluster, a fresh token from the default credential chain. */
export async function eksAccess(cluster: string): Promise<EksAccess> {
  const region = await eks.config.region();
  const [desc, creds] = await Promise.all([eks.send(new DescribeClusterCommand({ name: cluster })), eks.config.credentials()]);
  const server = desc.cluster?.endpoint;
  const caData = desc.cluster?.certificateAuthority?.data;
  if (!server || !caData) throw new Error(`EKS ${cluster}: no endpoint/CA in DescribeCluster`);
  return { cluster, server, caData, token: eksTokenFor({ cluster, region, creds }) };
}

export type NodegroupInfo = { name: string; status: string; instanceTypes: string[]; capacityType?: string; min: number; desired: number; max: number };

/** Managed node groups of a cluster with their scaling config. */
export async function listNodegroups(cluster: string): Promise<NodegroupInfo[]> {
  const names = (await eks.send(new ListNodegroupsCommand({ clusterName: cluster }))).nodegroups ?? [];
  return Promise.all(
    names.map(async (nodegroupName) => {
      const ng = (await eks.send(new DescribeNodegroupCommand({ clusterName: cluster, nodegroupName }))).nodegroup;
      return {
        name: nodegroupName,
        status: ng?.status ?? "UNKNOWN",
        instanceTypes: ng?.instanceTypes ?? [],
        capacityType: ng?.capacityType,
        min: ng?.scalingConfig?.minSize ?? 0,
        desired: ng?.scalingConfig?.desiredSize ?? 0,
        max: ng?.scalingConfig?.maxSize ?? 0,
      };
    }),
  );
}

/** Scaling config only (min/desired/max). Callers gate + cap it. */
export async function updateNodegroupScaling(cluster: string, nodegroupName: string, size: { min: number; desired: number; max: number }): Promise<string> {
  const r = await eks.send(new UpdateNodegroupConfigCommand({ clusterName: cluster, nodegroupName, scalingConfig: { minSize: size.min, desiredSize: size.desired, maxSize: size.max } }));
  return r.update?.id ?? "";
}
