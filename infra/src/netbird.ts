import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

// NetBird routing peer: a tiny EC2 instance in a private subnet that joins the
// company NetBird network and advertises the NonProd VPC CIDR to it. The
// ingress NLB is *internal*, so every *.prv.twizz.com hostname is reachable
// only through this peer (i.e. only from a NetBird-connected device).
//
// NetBird side (self-hosted https://vpn.twizzbus.com, Networks model; configured
// 2026-08-21 via the Management API with the owner PAT in SM vpn/netbird/owner):
//   - Setup key → SM preview/netbird (rotate after the peer has joined)
//   - Network `twizz-nonprod`: router = peer `twizz-nonprod-router` (masquerade on),
//     resource `nonprod-vpc` = 10.0.0.0/16
//   - Policy `staff-to-twizz-nonprod`: group `staff` → resource `nonprod-vpc`
//   - Group `nonprod-routers` holds the router peer
// Access to *.prv.twizz.com therefore == membership of the `staff` group.
//
// NOTE: if Pulumi REPLACES this instance (userData/AMI change), the new instance
// re-enrolls as a NEW peer (setup key is reusable) and VPN routing breaks until
// the NetBird network router + `nonprod-routers` group are re-pointed at the new
// peer id and the stale peer is deleted (Management API; last done 2026-08-31).
export function createNetbirdRouter(
  vpcId: pulumi.Output<string>,
  privateSubnetId: pulumi.Output<string>,
  vpcCidr: string,
  tags: Record<string, string>,
) {
  const region = aws.config.region ?? "eu-west-1";
  const acct = aws.getCallerIdentityOutput().accountId;

  const role = new aws.iam.Role("twizz-netbird-router", {
    name: "twizz-netbird-router",
    assumeRolePolicy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Principal: { Service: "ec2.amazonaws.com" }, Action: "sts:AssumeRole" }],
    }),
    tags,
  });

  // Setup key is fetched at boot from Secrets Manager — never in user-data/state.
  new aws.iam.RolePolicy("twizz-netbird-router-policy", {
    role: role.name,
    policy: acct.apply((a) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["secretsmanager:GetSecretValue"],
            Resource: `arn:aws:secretsmanager:${region}:${a}:secret:preview/netbird-*`,
          },
        ],
      }),
    ),
  });

  // SSM Session Manager for break-glass access (no SSH, no public IP).
  new aws.iam.RolePolicyAttachment("twizz-netbird-router-ssm", {
    role: role.name,
    policyArn: "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
  });

  const profile = new aws.iam.InstanceProfile("twizz-netbird-router-profile", {
    name: "twizz-netbird-router",
    role: role.name,
  });

  // Outbound only: NetBird dials out (WireGuard over UDP, relay fallback over 443).
  const sg = new aws.ec2.SecurityGroup("twizz-netbird-router-sg", {
    vpcId,
    description: "NetBird routing peer: egress only",
    egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
    tags: { ...tags, Name: "twizz-netbird-router" },
  });

  const ami = aws.ssm.getParameterOutput({
    name: "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64",
  });

  const userData = `#!/bin/bash
set -euo pipefail
dnf install -y jq
curl -fsSL https://pkgs.netbird.io/install.sh | sh
SECRET=$(aws secretsmanager get-secret-value --region ${region} --secret-id preview/netbird --query SecretString --output text)
KEY=$(echo "$SECRET" | jq -r .setupKey)
MGMT=$(echo "$SECRET" | jq -r '.managementUrl // "https://vpn.twizzbus.com:443"')
# Routing peers must forward; NetBird adds the masquerade rules itself.
echo 'net.ipv4.ip_forward=1' > /etc/sysctl.d/99-netbird.conf && sysctl --system
netbird up --setup-key "$KEY" --management-url "$MGMT" --hostname twizz-nonprod-router
`;

  const instance = new aws.ec2.Instance("twizz-netbird-router", {
    ami: ami.value,
    instanceType: "t4g.nano",
    subnetId: privateSubnetId,
    vpcSecurityGroupIds: [sg.id],
    iamInstanceProfile: profile.name,
    sourceDestCheck: false, // it routes for the VPC
    userData,
    userDataReplaceOnChange: true,
    metadataOptions: { httpTokens: "required" },
    rootBlockDevice: { volumeSize: 8, volumeType: "gp3", encrypted: true },
    tags: { ...tags, Name: "twizz-netbird-router" },
  }, {
    // The "latest AL2023" SSM lookup above changes whenever AWS publishes a new
    // AMI, which would force a REPLACE of this instance on an unrelated `pulumi up`
    // — i.e. a new NetBird peer and a VPN outage (the 2026-08-31 incident). Pin the
    // running AMI; refresh it deliberately by removing this option for one apply.
    ignoreChanges: ["ami"],
  });

  return { instanceId: instance.id, privateIp: instance.privateIp, advertisedCidr: vpcCidr };
}
