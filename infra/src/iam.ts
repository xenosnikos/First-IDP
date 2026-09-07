import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();

// All platform roles in one place. IRSA (OIDC federation) is used for in-cluster
// service accounts because preview namespaces are dynamic (pr-*) and IRSA trust
// policies support StringLike wildcards; EKS Pod Identity associations do not.
export function createIamRoles(
  oidcProviderArn: pulumi.Output<string>,
  oidcProviderUrl: pulumi.Output<string>,
  tags: Record<string, string>,
) {
  const accountId = aws.getCallerIdentityOutput().accountId;
  const region = "eu-west-1";

  const irsaTrust = (subPattern: string, like = true) =>
    pulumi.all([oidcProviderArn, oidcProviderUrl]).apply(([arn, url]) => {
      const host = url.replace(/^https?:\/\//, "");
      return JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Federated: arn },
            Action: "sts:AssumeRoleWithWebIdentity",
            Condition: {
              [like ? "StringLike" : "StringEquals"]: { [`${host}:sub`]: subPattern },
            },
          },
        ],
      });
    });

  // ── ESO: read preview/* secrets only ─────────────────────────────
  const esoRole = new aws.iam.Role("twizz-eso", {
    name: "twizz-eso",
    assumeRolePolicy: irsaTrust("system:serviceaccount:external-secrets:external-secrets", false),
    tags,
  });

  new aws.iam.RolePolicy("twizz-eso-policy", {
    role: esoRole.name,
    policy: accountId.apply((acct) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
            Resource: `arn:aws:secretsmanager:${region}:${acct}:secret:preview/*`,
          },
          {
            Effect: "Allow",
            Action: ["secretsmanager:ListSecrets"],
            Resource: "*",
          },
        ],
      }),
    ),
  });

  // ── Preview pods: any SA in a pr-* / env-* (Nebula named env) / shared namespace ──
  const previewPodsRole = new aws.iam.Role("twizz-nonprod-preview-pods", {
    name: "twizz-nonprod-preview-pods",
    assumeRolePolicy: pulumi.all([oidcProviderArn, oidcProviderUrl]).apply(([arn, url]) => {
      const host = url.replace(/^https?:\/\//, "");
      return JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Federated: arn },
            Action: "sts:AssumeRoleWithWebIdentity",
            Condition: {
              StringLike: {
                [`${host}:sub`]: [
                  "system:serviceaccount:pr-*:*",
                  "system:serviceaccount:env-*:*",
                  "system:serviceaccount:shared:*",
                  "system:serviceaccount:dev:*",
                ],
              },
            },
          },
        ],
      });
    }),
    tags,
  });

  new aws.iam.RolePolicy("twizz-preview-pods-policy", {
    role: previewPodsRole.name,
    policy: accountId.apply((acct) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "PreviewSecrets",
            Effect: "Allow",
            Action: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
            Resource: `arn:aws:secretsmanager:${region}:${acct}:secret:preview/*`,
          },
          {
            Sid: "DevBuckets",
            Effect: "Allow",
            Action: ["s3:GetObject", "s3:PutObject", "s3:ListBucket", "s3:DeleteObject"],
            Resource: ["arn:aws:s3:::*dev*", "arn:aws:s3:::*dev*/*", "arn:aws:s3:::*staging*", "arn:aws:s3:::*staging*/*"],
          },
          {
            Sid: "DevQueues",
            Effect: "Allow",
            Action: ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:GetQueueUrl"],
            Resource: `arn:aws:sqs:${region}:${acct}:*dev*`,
          },
          {
            Sid: "PreviewLambdas",
            Effect: "Allow",
            Action: ["lambda:InvokeFunction"],
            Resource: [
              `arn:aws:lambda:${region}:${acct}:function:twizz-image-conversion-pr-*`,
              `arn:aws:lambda:${region}:${acct}:function:twizz-image-conversion-dev*`,
            ],
          },
        ],
      }),
    ),
  });

  // ── Nebula boot keys: static creds for STOCK release images ──────
  // Moly-backend's AwsSecretsManager.ts passes `credentials: { accessKeyId:
  // process.env.AWS_ACCES_KEY_ID, ... }` (sic) explicitly, so without static
  // keys the SDK never falls back to IRSA and the pod cannot boot. This IAM
  // user can do exactly one thing: read the preview/moly-backend* secrets
  // (the shared blob, the per-env copies, and this boot secret itself). ESO
  // syncs `preview/moly-backend-boot` into each named env -> envFrom.
  const nebulaBootUser = new aws.iam.User("twizz-nebula-boot", {
    name: "twizz-nebula-boot",
    tags,
  });

  new aws.iam.UserPolicy("twizz-nebula-boot-policy", {
    user: nebulaBootUser.name,
    policy: accountId.apply((acct) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "MolyBackendPreviewSecretsReadOnly",
            Effect: "Allow",
            Action: ["secretsmanager:GetSecretValue"],
            Resource: `arn:aws:secretsmanager:${region}:${acct}:secret:preview/moly-backend*`,
          },
        ],
      }),
    ),
  });

  const nebulaBootKey = new aws.iam.AccessKey("twizz-nebula-boot-key", {
    user: nebulaBootUser.name,
  });

  const nebulaBootSecret = new aws.secretsmanager.Secret("preview-moly-backend-boot", {
    name: "preview/moly-backend-boot",
    description: "Static boot keys for stock Moly-backend images in Nebula named envs (ESO -> envFrom)",
    tags,
  });

  // Key name deliberately matches the app's typo (AWS_ACCES_KEY_ID, one S).
  new aws.secretsmanager.SecretVersion("preview-moly-backend-boot-v", {
    secretId: nebulaBootSecret.id,
    secretString: pulumi
      .all([nebulaBootKey.id, nebulaBootKey.secret])
      .apply(([id, secret]) => JSON.stringify({ AWS_ACCES_KEY_ID: id, AWS_SECRET_ACCESS_KEY: secret })),
  });

  // ── cert-manager: Route53 DNS-01 for *.prv.twizz.com ─────────
  const certManagerRole = new aws.iam.Role("twizz-cert-manager", {
    name: "twizz-cert-manager",
    assumeRolePolicy: irsaTrust("system:serviceaccount:cert-manager:cert-manager", false),
    tags,
  });

  new aws.iam.RolePolicy("twizz-cert-manager-policy", {
    role: certManagerRole.name,
    policy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        { Effect: "Allow", Action: "route53:GetChange", Resource: "arn:aws:route53:::change/*" },
        {
          Effect: "Allow",
          Action: ["route53:ChangeResourceRecordSets", "route53:ListResourceRecordSets"],
          Resource: "arn:aws:route53:::hostedzone/*",
        },
        { Effect: "Allow", Action: ["route53:ListHostedZones", "route53:ListHostedZonesByName"], Resource: "*" },
      ],
    }),
  });

  // ── Dashboard on Vercel: OIDC federation, read-only ──────────────
  // Set `vercelTeamSlug` config to enable; docs: vercel.com/docs/oidc/aws
  const vercelTeamSlug = config.get("vercelTeamSlug");
  let dashboardRole: aws.iam.Role | undefined;
  if (vercelTeamSlug) {
    const vercelOidc = new aws.iam.OpenIdConnectProvider("vercel-oidc", {
      url: "https://oidc.vercel.com/" + vercelTeamSlug,
      clientIdLists: [`https://vercel.com/${vercelTeamSlug}`],
      tags,
    });

    dashboardRole = new aws.iam.Role("twizz-dashboard-readonly", {
      name: "twizz-dashboard-readonly",
      assumeRolePolicy: vercelOidc.arn.apply((arn) =>
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Federated: arn },
              Action: "sts:AssumeRoleWithWebIdentity",
              Condition: {
                StringEquals: {
                  [`oidc.vercel.com/${vercelTeamSlug}:aud`]: `https://vercel.com/${vercelTeamSlug}`,
                },
                StringLike: {
                  [`oidc.vercel.com/${vercelTeamSlug}:sub`]: `owner:${vercelTeamSlug}:project:twizz-idp:*`,
                },
              },
            },
          ],
        }),
      ),
      tags,
    });

    new aws.iam.RolePolicy("twizz-dashboard-readonly-policy", {
      role: dashboardRole.name,
      policy: accountId.apply((acct) =>
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Sid: "Introspection",
              Effect: "Allow",
              Action: [
                "eks:DescribeCluster",
                "eks:ListClusters",
                "logs:GetLogEvents",
                "logs:FilterLogEvents",
                "logs:DescribeLogGroups",
                "logs:DescribeLogStreams",
                "logs:StartQuery",
                "logs:GetQueryResults",
                "cloudwatch:GetMetricData",
                "cloudwatch:ListMetrics",
              ],
              Resource: "*",
            },
            {
              Sid: "SecretKeysNotValues",
              Effect: "Allow",
              Action: ["secretsmanager:ListSecrets", "secretsmanager:DescribeSecret"],
              Resource: "*",
            },
            {
              Sid: "PreviewSecretKeys",
              Effect: "Allow",
              Action: ["secretsmanager:GetSecretValue"],
              Resource: `arn:aws:secretsmanager:${region}:${acct}:secret:preview/*`,
            },
          ],
        }),
      ),
    });
  }

  // ── GitHub Actions: OIDC federation for ECR pushes (no static keys) ──
  const githubOidc = new aws.iam.OpenIdConnectProvider("github-oidc", {
    url: "https://token.actions.githubusercontent.com",
    clientIdLists: ["sts.amazonaws.com"],
    tags,
  });

  const ghaEcrPush = new aws.iam.Role("twizz-gha-ecr-push", {
    name: "twizz-gha-ecr-push",
    assumeRolePolicy: githubOidc.arn.apply((arn) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Federated: arn },
            Action: "sts:AssumeRoleWithWebIdentity",
            Condition: {
              StringEquals: {
                "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
              },
              StringLike: {
                "token.actions.githubusercontent.com:sub": [
                  "repo:twizz-app/*",
                ],
              },
            },
          },
        ],
      }),
    ),
    tags,
  });

  new aws.iam.RolePolicy("twizz-gha-ecr-push-policy", {
    role: ghaEcrPush.name,
    policy: accountId.apply((acct) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          { Sid: "EcrAuth", Effect: "Allow", Action: "ecr:GetAuthorizationToken", Resource: "*" },
          {
            Sid: "EcrPush",
            Effect: "Allow",
            Action: [
              "ecr:BatchCheckLayerAvailability",
              "ecr:CompleteLayerUpload",
              "ecr:InitiateLayerUpload",
              "ecr:PutImage",
              "ecr:UploadLayerPart",
              "ecr:BatchGetImage",
              "ecr:GetDownloadUrlForLayer",
            ],
            Resource: `arn:aws:ecr:${region}:${acct}:repository/*`,
          },
        ],
      }),
    ),
  });

  // ── GitHub Actions: SAM deploys for per-PR Lambda stacks ────────────
  const ghaSamDeploy = new aws.iam.Role("twizz-gha-sam-deploy", {
    name: "twizz-gha-sam-deploy",
    assumeRolePolicy: githubOidc.arn.apply((arn) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Federated: arn },
            Action: "sts:AssumeRoleWithWebIdentity",
            Condition: {
              StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
              StringLike: {
                "token.actions.githubusercontent.com:sub": "repo:twizz-app/image_conversion_service:*",
              },
            },
          },
        ],
      }),
    ),
    tags,
  });

  new aws.iam.RolePolicy("twizz-gha-sam-deploy-policy", {
    role: ghaSamDeploy.name,
    policy: accountId.apply((acct) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "CfnPreviewStacks",
            Effect: "Allow",
            Action: "cloudformation:*",
            Resource: [
              `arn:aws:cloudformation:${region}:${acct}:stack/twizz-image-conversion*/*`,
              `arn:aws:cloudformation:${region}:${acct}:stack/aws-sam-cli-managed-default*/*`,
            ],
          },
          {
            Sid: "SamArtifacts",
            Effect: "Allow",
            Action: ["s3:GetObject", "s3:PutObject", "s3:ListBucket", "s3:CreateBucket", "s3:GetBucketLocation"],
            Resource: ["arn:aws:s3:::aws-sam-cli-managed-default*", "arn:aws:s3:::aws-sam-cli-managed-default*/*"],
          },
          {
            Sid: "EcrForImages",
            Effect: "Allow",
            Action: ["ecr:*"],
            Resource: `arn:aws:ecr:${region}:${acct}:repository/twizzimageconversion*`,
          },
          { Sid: "EcrAuth", Effect: "Allow", Action: "ecr:GetAuthorizationToken", Resource: "*" },
          {
            Sid: "LambdaAndAlarms",
            Effect: "Allow",
            Action: ["lambda:*", "cloudwatch:PutMetricAlarm", "cloudwatch:DeleteAlarms", "cloudwatch:DescribeAlarms", "cloudwatch:PutDashboard", "cloudwatch:DeleteDashboards"],
            Resource: "*",
          },
          {
            Sid: "FunctionRoles",
            Effect: "Allow",
            Action: ["iam:CreateRole", "iam:DeleteRole", "iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:GetRole", "iam:PassRole", "iam:TagRole", "iam:GetRolePolicy"],
            Resource: `arn:aws:iam::${acct}:role/twizz-image-conversion*`,
          },
          {
            Sid: "PreviewSsm",
            Effect: "Allow",
            Action: ["ssm:PutParameter", "ssm:DeleteParameter", "ssm:GetParameter"],
            Resource: `arn:aws:ssm:${region}:${acct}:parameter/preview/*`,
          },
        ],
      }),
    ),
  });

  // ── MCP roles: assumed locally via AssumeRole, never the admin profile ──
  const mcpReadonly = new aws.iam.Role("twizz-mcp-readonly", {
    name: "twizz-mcp-readonly",
    assumeRolePolicy: accountId.apply((acct) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { AWS: `arn:aws:iam::${acct}:root` },
            Action: ["sts:AssumeRole", "sts:TagSession"],
          },
        ],
      }),
    ),
    tags,
  });

  new aws.iam.RolePolicyAttachment("twizz-mcp-readonly-viewonly", {
    role: mcpReadonly.name,
    policyArn: "arn:aws:iam::aws:policy/job-function/ViewOnlyAccess",
  });

  new aws.iam.RolePolicy("twizz-mcp-readonly-extras", {
    role: mcpReadonly.name,
    policy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "LogsAndCost",
          Effect: "Allow",
          Action: [
            "logs:GetLogEvents",
            "logs:FilterLogEvents",
            "logs:StartQuery",
            "logs:GetQueryResults",
            "ce:GetCostAndUsage",
            "ce:GetCostForecast",
          ],
          Resource: "*",
        },
      ],
    }),
  });

  const mcpOperator = new aws.iam.Role("twizz-mcp-operator", {
    name: "twizz-mcp-operator",
    assumeRolePolicy: accountId.apply((acct) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { AWS: `arn:aws:iam::${acct}:root` },
            Action: ["sts:AssumeRole", "sts:TagSession"],
          },
        ],
      }),
    ),
    // Deliberately narrow: preview secrets + preview ECR cleanup. Widen only with
    // matching entries in apps/mcp/policy.yaml (Phase 7).
    tags,
  });

  new aws.iam.RolePolicy("twizz-mcp-operator-policy", {
    role: mcpOperator.name,
    policy: accountId.apply((acct) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "PreviewSecretsRW",
            Effect: "Allow",
            Action: [
              "secretsmanager:GetSecretValue",
              "secretsmanager:DescribeSecret",
              "secretsmanager:PutSecretValue",
              "secretsmanager:CreateSecret",
              "secretsmanager:TagResource",
              "secretsmanager:DeleteSecret", // teardown_named_env removes preview/<svc>/<env>
            ],
            Resource: `arn:aws:secretsmanager:${region}:${acct}:secret:preview/*`,
          },
          {
            Sid: "PreviewEcrCleanup",
            Effect: "Allow",
            Action: ["ecr:BatchDeleteImage", "ecr:ListImages", "ecr:DescribeImages"],
            Resource: `arn:aws:ecr:${region}:${acct}:repository/*`,
          },
          {
            Sid: "DescribeOnly",
            Effect: "Allow",
            Action: ["eks:DescribeCluster"],
            Resource: `arn:aws:eks:${region}:${acct}:cluster/EKS-Twizz-NonProd`,
          },
        ],
      }),
    ),
  });

  return {
    ghaEcrPushRoleArn: ghaEcrPush.arn,
    esoRoleArn: esoRole.arn,
    previewPodsRoleArn: previewPodsRole.arn,
    certManagerRoleArn: certManagerRole.arn,
    dashboardRoleArn: dashboardRole?.arn,
    mcpReadonlyRoleArn: mcpReadonly.arn,
    mcpOperatorRoleArn: mcpOperator.arn,
  };
}
