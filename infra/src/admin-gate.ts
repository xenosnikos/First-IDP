import * as aws from "@pulumi/aws";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

// Admin-app gate: the Vercel-hosted staff tools (moly-admin, twizz-admin) become
// reachable ONLY at <app>.prv.twizz.com — i.e. over NetBird — and only for the
// emails in Pulumi config `adminAllowlist` (a second oauth2-proxy with an
// authenticated-emails file at auth-admin.prv.twizz.com; the staff-wide proxy
// at auth.prv.twizz.com stays untouched for everything else).
//
// The public Vercel URLs are then locked with Vercel Authentication ("all
// deployments"); nginx reaches Vercel by injecting the per-project
// x-vercel-protection-bypass token (SM preview/vercel-admin-bypass) into the
// proxied request. The token lands in the ingress annotation (cluster-readable
// only) and in local Pulumi state — never in git.
//
// One-time manual prerequisite: add https://auth-admin.prv.twizz.com/oauth2/callback
// to the Google OAuth client's authorized redirect URIs.
export function createAdminGate(provider: k8s.Provider, adminAllowlist: string[]) {
  const DOMAIN = "prv.twizz.com";
  const AUTH_ADMIN_HOST = `auth-admin.${DOMAIN}`;

  const APPS = [
    { name: "moly-admin", upstream: "moly-admin.vercel.app", bypassKey: "molyAdmin" },
    { name: "twizz-admin", upstream: "twizz-admin.vercel.app", bypassKey: "twizzAdmin" },
  ];

  const bypass = aws.secretsmanager
    .getSecretVersionOutput({ secretId: "preview/vercel-admin-bypass" })
    .secretString.apply((s) => JSON.parse(s) as Record<string, string>);

  // ── allowlist oauth2-proxy (auth ns already exists from bootstrap) ──
  const adminSsoSecret = new k8s.apiextensions.CustomResource(
    "oauth2-proxy-admin-secret",
    {
      apiVersion: "external-secrets.io/v1beta1",
      kind: "ExternalSecret",
      metadata: { name: "oauth2-proxy-admin", namespace: "auth" },
      spec: {
        refreshInterval: "1h",
        secretStoreRef: { name: "aws-secrets-manager", kind: "ClusterSecretStore" },
        target: { name: "oauth2-proxy-admin" },
        data: [
          { secretKey: "client-id", remoteRef: { key: "preview/google-sso", property: "clientId" } },
          { secretKey: "client-secret", remoteRef: { key: "preview/google-sso", property: "clientSecret" } },
          // own cookie secret: an admin session must not be forgeable from a staff one
          { secretKey: "cookie-secret", remoteRef: { key: "preview/admin-gate", property: "cookieSecret" } },
        ],
      },
    },
    { provider },
  );

  new k8s.helm.v3.Release(
    "oauth2-proxy-admin",
    {
      chart: "oauth2-proxy",
      version: "10.7.0",
      repositoryOpts: { repo: "https://oauth2-proxy.github.io/manifests" },
      namespace: "auth",
      values: {
        config: { existingSecret: "oauth2-proxy-admin" },
        // Allowlist ONLY — deliberately no email-domain arg: oauth2-proxy ORs its
        // rules, so adding the domain would re-open the gate to all of twizz.com.
        authenticatedEmailsFile: {
          enabled: true,
          restricted_access: adminAllowlist.join("\n"),
        },
        extraArgs: {
          provider: "google",
          "cookie-domain": `.${DOMAIN}`,
          "whitelist-domain": `.${DOMAIN}`,
          "cookie-name": "_oauth2_proxy_admin", // must differ from the staff proxy's cookie
          "cookie-secure": "true",
          "cookie-samesite": "lax",
          "cookie-expire": "12h",
          "cookie-refresh": "1h",
          "reverse-proxy": "true",
          "set-xauthrequest": "true",
          "skip-provider-button": "true",
          "redirect-url": `https://${AUTH_ADMIN_HOST}/oauth2/callback`,
        },
        ingress: {
          enabled: true,
          className: "nginx",
          path: "/oauth2",
          pathType: "Prefix",
          hosts: [AUTH_ADMIN_HOST],
          annotations: { "nginx.ingress.kubernetes.io/enable-global-auth": "false" },
        },
        resources: { requests: { cpu: "10m", memory: "32Mi" }, limits: { memory: "128Mi" } },
      },
    },
    { provider, dependsOn: [adminSsoSecret] },
  );

  // ── per-app reverse proxy to Vercel ─────────────────────────────────
  const ns = new k8s.core.v1.Namespace(
    "admin-proxy-ns",
    { metadata: { name: "admin-proxy" } },
    { provider },
  );

  for (const app of APPS) {
    const svc = new k8s.core.v1.Service(
      `${app.name}-upstream`,
      {
        metadata: { name: `${app.name}-upstream`, namespace: ns.metadata.name },
        spec: {
          type: "ExternalName",
          externalName: app.upstream,
          ports: [{ port: 443, name: "https" }],
        },
      },
      { provider },
    );

    new k8s.networking.v1.Ingress(
      `${app.name}-proxy`,
      {
        metadata: {
          name: `${app.name}-proxy`,
          namespace: ns.metadata.name,
          annotations: {
            // swap the staff-wide gate for the allowlist gate
            "nginx.ingress.kubernetes.io/enable-global-auth": "false",
            "nginx.ingress.kubernetes.io/auth-url": `https://${AUTH_ADMIN_HOST}/oauth2/auth`,
            "nginx.ingress.kubernetes.io/auth-signin": `https://${AUTH_ADMIN_HOST}/oauth2/start?rd=$scheme://$host$request_uri`,
            "nginx.ingress.kubernetes.io/auth-snippet": "proxy_set_header X-Forwarded-Host $host;",
            // HTTPS to Vercel with SNI + correct Host
            "nginx.ingress.kubernetes.io/backend-protocol": "HTTPS",
            "nginx.ingress.kubernetes.io/upstream-vhost": app.upstream,
            "nginx.ingress.kubernetes.io/configuration-snippet": pulumi.secret(
              bypass.apply(
                (b) =>
                  `proxy_ssl_server_name on;\nproxy_ssl_name ${app.upstream};\n` +
                  `proxy_set_header x-vercel-protection-bypass "${b[app.bypassKey]}";\n` +
                  `proxy_set_header x-vercel-set-bypass-cookie "true";`,
              ),
            ) as unknown as string,
          },
        },
        spec: {
          ingressClassName: "nginx",
          rules: [
            {
              host: `${app.name}.${DOMAIN}`,
              http: {
                paths: [
                  {
                    path: "/",
                    pathType: "Prefix",
                    backend: { service: { name: svc.metadata.name, port: { number: 443 } } },
                  },
                ],
              },
            },
          ],
        },
      },
      { provider },
    );
  }

  return {
    adminHosts: APPS.map((a) => `https://${a.name}.${DOMAIN}`),
    adminAuthHost: `https://${AUTH_ADMIN_HOST}`,
  };
}
