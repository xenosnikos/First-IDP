import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

// One-time cluster bootstrap, run by Pulumi right after cluster creation:
// ingress-nginx, cert-manager (+ wildcard cert), External Secrets, Argo CD,
// and the spot NodePool. After Phase 3, Argo CD manages everything else
// (app-of-apps from TwizzyNicky/twizz-gitops); these Helm releases stay Pulumi-owned.
export function bootstrapCluster(
  kubeconfig: pulumi.Output<any>,
  roles: {
    esoRoleArn: pulumi.Output<string>;
    certManagerRoleArn: pulumi.Output<string>;
  },
  access: {
    privateSubnetIds: pulumi.Output<string>[]; // internal NLB lives here (VPN-only)
    googleDomain: string; // Workspace domain allowed through SSO
    argocdAdmins: string[]; // emails granted role:admin in Argo CD
  },
) {
  const DOMAIN = "prv.twizz.com";
  const AUTH_HOST = `auth.${DOMAIN}`;
  const ARGOCD_HOST = `argocd.${DOMAIN}`;
  const provider = new k8s.Provider("nonprod", {
    kubeconfig: kubeconfig.apply((kc) => (typeof kc === "string" ? kc : JSON.stringify(kc))),
  });

  // ── Spot NodePool (EKS Auto Mode / Karpenter API) ────────────────
  const spotPool = new k8s.apiextensions.CustomResource(
    "spot-nodepool",
    {
      apiVersion: "karpenter.sh/v1",
      kind: "NodePool",
      metadata: { name: "spot" },
      spec: {
        template: {
          spec: {
            nodeClassRef: { group: "eks.amazonaws.com", kind: "NodeClass", name: "default" },
            requirements: [
              { key: "karpenter.sh/capacity-type", operator: "In", values: ["spot"] },
              { key: "eks.amazonaws.com/instance-category", operator: "In", values: ["t", "m", "c"] },
              { key: "kubernetes.io/arch", operator: "In", values: ["amd64"] },
            ],
          },
        },
        limits: { cpu: "48", memory: "96Gi" },
        disruption: { consolidationPolicy: "WhenEmptyOrUnderutilized", consolidateAfter: "60s" },
      },
    },
    { provider },
  );

  // ── cert-manager ─────────────────────────────────────────────────
  const certManagerNs = new k8s.core.v1.Namespace(
    "cert-manager-ns",
    { metadata: { name: "cert-manager" } },
    { provider },
  );

  const certManager = new k8s.helm.v3.Release(
    "cert-manager",
    {
      chart: "cert-manager",
      version: "1.16.2",
      repositoryOpts: { repo: "https://charts.jetstack.io" },
      namespace: certManagerNs.metadata.name,
      values: {
        crds: { enabled: true },
        serviceAccount: {
          name: "cert-manager",
          annotations: { "eks.amazonaws.com/role-arn": roles.certManagerRoleArn },
        },
        // DNS-01 self-check happens against public resolvers
        extraArgs: ["--dns01-recursive-nameservers-only", "--dns01-recursive-nameservers=8.8.8.8:53,1.1.1.1:53"],
      },
    },
    { provider },
  );

  const issuer = new k8s.apiextensions.CustomResource(
    "letsencrypt-dns01",
    {
      apiVersion: "cert-manager.io/v1",
      kind: "ClusterIssuer",
      metadata: { name: "letsencrypt-dns01" },
      spec: {
        acme: {
          server: "https://acme-v02.api.letsencrypt.org/directory",
          email: "info@twizz.app",
          privateKeySecretRef: { name: "letsencrypt-dns01-account" },
          solvers: [
            {
              selector: { dnsZones: ["twizz.com"] },
              dns01: { route53: { region: "eu-west-1" } },
            },
          ],
        },
      },
    },
    { provider, dependsOn: [certManager] },
  );

  // ── ingress-nginx with the wildcard cert as default TLS ──────────
  const ingressNs = new k8s.core.v1.Namespace(
    "ingress-nginx-ns",
    { metadata: { name: "ingress-nginx" } },
    { provider },
  );

  const wildcardCert = new k8s.apiextensions.CustomResource(
    "wildcard-preview-cert",
    {
      apiVersion: "cert-manager.io/v1",
      kind: "Certificate",
      metadata: { name: "wildcard-preview", namespace: ingressNs.metadata.name },
      spec: {
        secretName: "wildcard-preview-tls",
        issuerRef: { name: "letsencrypt-dns01", kind: "ClusterIssuer" },
        dnsNames: ["*.prv.twizz.com"],
      },
    },
    { provider, dependsOn: [issuer] },
  );

  const ingressNginx = new k8s.helm.v3.Release(
    "ingress-nginx",
    {
      chart: "ingress-nginx",
      version: "4.11.3",
      repositoryOpts: { repo: "https://kubernetes.github.io/ingress-nginx" },
      namespace: ingressNs.metadata.name,
      values: {
        controller: {
          service: {
            annotations: {
              "service.beta.kubernetes.io/aws-load-balancer-type": "external",
              "service.beta.kubernetes.io/aws-load-balancer-nlb-target-type": "ip",
              // INTERNAL: no public endpoint. *.prv.twizz.com resolves to private IPs
              // reachable only through the NetBird routing peer (netbird.ts).
              "service.beta.kubernetes.io/aws-load-balancer-scheme": "internal",
              "service.beta.kubernetes.io/aws-load-balancer-subnets": pulumi
                .all(access.privateSubnetIds)
                .apply((ids) => ids.join(",")),
            },
          },
          extraArgs: {
            "default-ssl-certificate": "ingress-nginx/wildcard-preview-tls",
          },
          config: {
            "proxy-body-size": "1200m", // Moly-backend uploads
            "use-proxy-protocol": "false",
            // Google SSO gate for EVERY ingress on the cluster (oauth2-proxy below).
            // Opt out per-ingress with nginx.ingress.kubernetes.io/enable-global-auth: "false".
            "global-auth-url": `https://${AUTH_HOST}/oauth2/auth`,
            "global-auth-signin": `https://${AUTH_HOST}/oauth2/start?rd=$scheme://$host$request_uri`,
            "global-auth-response-headers": "X-Auth-Request-User,X-Auth-Request-Email",
            "global-auth-snippet": "proxy_set_header X-Forwarded-Host $host;",
          },
          // admin-gate.ts injects the Vercel bypass header via per-ingress snippets.
          // Must be the chart value — a raw config entry gets overridden by the
          // chart's own allow-snippet-annotations templating.
          allowSnippetAnnotations: true,
        },
      },
    },
    { provider, dependsOn: [wildcardCert, spotPool] },
  );

  // The NLB hostname materialises on the controller Service; dns.ts consumes it.
  // Pulumi suffixes the Helm release name; the chart names the controller
  // service "<release>-controller".
  const nginxSvc = k8s.core.v1.Service.get(
    "ingress-nginx-controller-svc",
    pulumi.interpolate`${ingressNs.metadata.name}/${ingressNginx.status.name}-controller`,
    { provider, dependsOn: [ingressNginx] },
  );

  const ingressNlbDnsName = nginxSvc.status.loadBalancer.ingress.apply(
    (ing) => ing?.[0]?.hostname ?? "",
  );

  // ── External Secrets Operator ────────────────────────────────────
  const esoNs = new k8s.core.v1.Namespace(
    "external-secrets-ns",
    { metadata: { name: "external-secrets" } },
    { provider },
  );

  const eso = new k8s.helm.v3.Release(
    "external-secrets",
    {
      chart: "external-secrets",
      version: "0.10.7",
      repositoryOpts: { repo: "https://charts.external-secrets.io" },
      namespace: esoNs.metadata.name,
      values: {
        serviceAccount: {
          name: "external-secrets",
          annotations: { "eks.amazonaws.com/role-arn": roles.esoRoleArn },
        },
      },
    },
    { provider },
  );

  // Cluster-wide store: any namespace can reference preview/* secrets via ESO.
  const secretStore = new k8s.apiextensions.CustomResource(
    "aws-secrets-manager-store",
    {
      apiVersion: "external-secrets.io/v1beta1",
      kind: "ClusterSecretStore",
      metadata: { name: "aws-secrets-manager" },
      spec: {
        provider: {
          aws: {
            service: "SecretsManager",
            region: "eu-west-1",
            auth: {
              jwt: {
                serviceAccountRef: { name: "external-secrets", namespace: "external-secrets" },
              },
            },
          },
        },
      },
    },
    { provider, dependsOn: [eso] },
  );

  // ── oauth2-proxy: Google Workspace SSO gate (auth.prv.twizz.com) ─
  const authNs = new k8s.core.v1.Namespace("auth-ns", { metadata: { name: "auth" } }, { provider });

  const ssoSecret = new k8s.apiextensions.CustomResource(
    "oauth2-proxy-google-secret",
    {
      apiVersion: "external-secrets.io/v1beta1",
      kind: "ExternalSecret",
      metadata: { name: "oauth2-proxy-google", namespace: authNs.metadata.name },
      spec: {
        refreshInterval: "1h",
        secretStoreRef: { name: "aws-secrets-manager", kind: "ClusterSecretStore" },
        target: { name: "oauth2-proxy-google" },
        data: [
          { secretKey: "client-id", remoteRef: { key: "preview/google-sso", property: "clientId" } },
          { secretKey: "client-secret", remoteRef: { key: "preview/google-sso", property: "clientSecret" } },
          { secretKey: "cookie-secret", remoteRef: { key: "preview/google-sso", property: "cookieSecret" } },
        ],
      },
    },
    { provider, dependsOn: [secretStore] },
  );

  new k8s.helm.v3.Release(
    "oauth2-proxy",
    {
      chart: "oauth2-proxy",
      version: "10.7.0",
      repositoryOpts: { repo: "https://oauth2-proxy.github.io/manifests" },
      namespace: authNs.metadata.name,
      values: {
        config: { existingSecret: "oauth2-proxy-google" },
        extraArgs: {
          provider: "google",
          "email-domain": access.googleDomain,
          "cookie-domain": `.${DOMAIN}`,
          "whitelist-domain": `.${DOMAIN}`,
          "cookie-secure": "true",
          "cookie-samesite": "lax",
          "cookie-expire": "12h",
          "cookie-refresh": "1h",
          "reverse-proxy": "true",
          "set-xauthrequest": "true",
          "skip-provider-button": "true",
          "redirect-url": `https://${AUTH_HOST}/oauth2/callback`,
        },
        ingress: {
          enabled: true,
          className: "nginx",
          path: "/oauth2",
          pathType: "Prefix",
          hosts: [AUTH_HOST],
          annotations: { "nginx.ingress.kubernetes.io/enable-global-auth": "false" },
        },
        resources: { requests: { cpu: "10m", memory: "32Mi" }, limits: { memory: "128Mi" } },
      },
    },
    { provider, dependsOn: [ingressNginx, ssoSecret] },
  );

  // ── Argo CD ──────────────────────────────────────────────────────
  const argocdNs = new k8s.core.v1.Namespace(
    "argocd-ns",
    { metadata: { name: "argocd" } },
    { provider },
  );

  // Dex reads $argocd-google-sso:clientSecret; the label is what makes Argo CD
  // mount it for $-references.
  const argocdSso = new k8s.apiextensions.CustomResource(
    "argocd-google-sso-secret",
    {
      apiVersion: "external-secrets.io/v1beta1",
      kind: "ExternalSecret",
      metadata: { name: "argocd-google-sso", namespace: argocdNs.metadata.name },
      spec: {
        refreshInterval: "1h",
        secretStoreRef: { name: "aws-secrets-manager", kind: "ClusterSecretStore" },
        target: {
          name: "argocd-google-sso",
          template: { metadata: { labels: { "app.kubernetes.io/part-of": "argocd" } } },
        },
        data: [
          { secretKey: "clientId", remoteRef: { key: "preview/google-sso", property: "clientId" } },
          { secretKey: "clientSecret", remoteRef: { key: "preview/google-sso", property: "clientSecret" } },
        ],
      },
    },
    { provider, dependsOn: [secretStore] },
  );

  const argocd = new k8s.helm.v3.Release(
    "argocd",
    {
      chart: "argo-cd",
      version: "7.7.10",
      repositoryOpts: { repo: "https://argoproj.github.io/argo-helm" },
      namespace: argocdNs.metadata.name,
      values: {
        global: { domain: ARGOCD_HOST },
        configs: {
          params: { "server.insecure": true }, // TLS terminates at nginx (wildcard cert)
          cm: {
            url: `https://${ARGOCD_HOST}`,
            // Google Workspace SSO via Dex, restricted to the company domain.
            "dex.config": [
              "connectors:",
              "  - type: google",
              "    id: google",
              "    name: Google",
              "    config:",
              "      clientID: $argocd-google-sso:clientId",
              "      clientSecret: $argocd-google-sso:clientSecret",
              `      redirectURI: https://${ARGOCD_HOST}/api/dex/callback`,
              "      hostedDomains:",
              `        - ${access.googleDomain}`,
            ].join("\n"),
          },
          rbac: {
            "policy.default": "role:readonly", // any twizz.com account can look
            "policy.csv": access.argocdAdmins.map((e) => `g, ${e}, role:admin`).join("\n"),
            scopes: "[email]",
          },
        },
        server: {
          ingress: {
            enabled: true,
            ingressClassName: "nginx",
            hostname: ARGOCD_HOST,
            tls: false, // default wildcard cert covers it
            // Dex already enforces Google SSO (and the CLI/gRPC path can't do the
            // oauth2-proxy dance), so skip the nginx-level gate here.
            annotations: { "nginx.ingress.kubernetes.io/enable-global-auth": "false" },
          },
        },
      },
    },
    { provider, dependsOn: [ingressNginx, argocdSso] },
  );

  return { provider, ingressNlbDnsName, argocd };
}
