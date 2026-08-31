import * as eks from "@pulumi/eks";
import * as pulumi from "@pulumi/pulumi";

// EKS Auto Mode: AWS manages nodes, core addons (VPC CNI, CoreDNS, kube-proxy,
// EBS CSI), the pod identity agent, and a built-in LB controller. We add a spot
// NodePool in bootstrap.ts so workloads land on spot capacity scaling from zero.
export function createEksCluster(
  vpcId: pulumi.Output<string>,
  privateSubnetIds: pulumi.Output<string>[],
  publicSubnetIds: pulumi.Output<string>[],
  tags: Record<string, string>,
) {
  const cluster = new eks.Cluster("EKS-Twizz-NonProd", {
    name: "EKS-Twizz-NonProd",
    vpcId,
    privateSubnetIds,
    publicSubnetIds,
    version: "1.31",
    authenticationMode: eks.AuthenticationMode.Api,
    autoMode: {
      enabled: true,
      // built-in "system" + "general-purpose" (on-demand) pools; spot pool added in bootstrap
    },
    // Auto Mode ships its own coredns/kube-proxy — installing them as managed
    // addons on top conflicts (addon reports DEGRADED while the cluster is fine).
    corednsAddonOptions: { enabled: false },
    kubeProxyAddonOptions: { enabled: false },
    createOidcProvider: true, // IRSA: preview namespaces are dynamic (pr-*), so we
    // need StringLike wildcard trust — pod identity associations can't do that.
    // The generated kubeconfig execs `aws eks get-token`; pin the profile so it
    // never falls back to whatever the shell's default AWS account is.
    providerCredentialOpts: { profileName: "twizz" },
    tags,
  });

  return {
    cluster,
    clusterName: pulumi.output("EKS-Twizz-NonProd"),
    kubeconfig: cluster.kubeconfig,
    oidcProviderArn: cluster.oidcProviderArn,
    oidcProviderUrl: cluster.oidcProviderUrl,
  };
}
