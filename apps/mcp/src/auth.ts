import { STSClient, AssumeRoleCommand, type Tag } from "@aws-sdk/client-sts";

const REGION = process.env.AWS_REGION ?? "eu-west-1";
const ACCOUNT = process.env.TWIZZ_AWS_ACCOUNT ?? "848281935985";

const READONLY_ROLE =
  process.env.TWIZZ_MCP_READONLY_ROLE_ARN ?? `arn:aws:iam::${ACCOUNT}:role/twizz-mcp-readonly`;
const OPERATOR_ROLE =
  process.env.TWIZZ_MCP_OPERATOR_ROLE_ARN ?? `arn:aws:iam::${ACCOUNT}:role/twizz-mcp-operator`;

// STS client uses the ambient profile/creds ONCE, to assume the scoped roles.
// Everything after startup runs on role credentials, never the base profile.
const sts = new STSClient({ region: REGION });

type Creds = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: Date;
};

async function assume(roleArn: string, sessionName: string, tags?: Tag[]): Promise<Creds> {
  const res = await sts.send(
    new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: sessionName.slice(0, 64),
      DurationSeconds: 3600,
      Tags: tags,
    }),
  );
  const c = res.Credentials!;
  return {
    accessKeyId: c.AccessKeyId!,
    secretAccessKey: c.SecretAccessKey!,
    sessionToken: c.SessionToken!,
    expiration: c.Expiration!,
  };
}

let readonlyCreds: Creds | undefined;

/** Assume the readonly role and export its creds into process.env so every
 * SDK client constructed afterwards (including @twizz-idp/core singletons,
 * which must be imported AFTER this runs) uses readonly credentials. */
export async function activateReadonlyCreds(): Promise<void> {
  readonlyCreds = await assume(READONLY_ROLE, "twizz-mcp-read");
  process.env.AWS_ACCESS_KEY_ID = readonlyCreds.accessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = readonlyCreds.secretAccessKey;
  process.env.AWS_SESSION_TOKEN = readonlyCreds.sessionToken;
  delete process.env.AWS_PROFILE;
}

/** Fresh readonly creds if the current ones are about to expire (long sessions). */
export async function ensureReadonlyCreds(): Promise<void> {
  if (!readonlyCreds || readonlyCreds.expiration.getTime() - Date.now() < 5 * 60_000) {
    await activateReadonlyCreds();
  }
}

/** Per-call operator credentials, session-tagged with tool/resource/actor so
 * CloudTrail records exactly which gated action used them. */
export async function operatorCreds(tool: string, resource: string, actor: string) {
  const creds = await assume(OPERATOR_ROLE, `mcp-${tool}`, [
    { Key: "tool", Value: tool.slice(0, 128) },
    { Key: "resource", Value: resource.slice(0, 128) },
    { Key: "actor", Value: actor.slice(0, 128) },
  ]);
  return {
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    sessionToken: creds.sessionToken,
  };
}

export const region = REGION;
