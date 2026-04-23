import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export function createIamRoles(
  oidcProviderArn: pulumi.Output<string>,
  oidcProviderUrl: pulumi.Output<string>,
  tags: Record<string, string>,
) {
  const esoRole = new aws.iam.Role("twizz-idp-eso-role", {
    assumeRolePolicy: pulumi.all([oidcProviderArn, oidcProviderUrl]).apply(([arn, url]) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Principal: { Federated: arn },
          Action: "sts:AssumeRoleWithWebIdentity",
          Condition: { StringEquals: { [`${url}:sub`]: "system:serviceaccount:external-secrets:external-secrets" } },
        }],
      })
    ),
    tags,
  });

  new aws.iam.RolePolicyAttachment("eso-secrets-policy", {
    role: esoRole.name,
    policyArn: "arn:aws:iam::aws:policy/SecretsManagerReadWrite",
  });

  const argoRole = new aws.iam.Role("twizz-idp-argo-role", {
    assumeRolePolicy: pulumi.all([oidcProviderArn, oidcProviderUrl]).apply(([arn, url]) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Principal: { Federated: arn },
          Action: "sts:AssumeRoleWithWebIdentity",
          Condition: { StringEquals: { [`${url}:sub`]: "system:serviceaccount:argo:argo-workflows" } },
        }],
      })
    ),
    tags,
  });

  const argoPolicy = new aws.iam.Policy("argo-ecr-s3-policy", {
    policy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        { Effect: "Allow", Action: ["ecr:*"], Resource: "*" },
        { Effect: "Allow", Action: ["s3:PutObject", "s3:GetObject", "s3:ListBucket"], Resource: "*" },
      ],
    }),
    tags,
  });

  new aws.iam.RolePolicyAttachment("argo-policy-attachment", {
    role: argoRole.name,
    policyArn: argoPolicy.arn,
  });

  return { esoRoleArn: esoRole.arn, argoRoleArn: argoRole.arn };
}
