# Moly-backend enablement patches (one PR into MymTwo/Moly-backend)

Three code changes + two drop-in files (`preview.yml` → `.github/workflows/`,
`Dockerfile` → repo root). Together they make the app previewable on
EKS-Twizz-NonProd without changing prod/staging behaviour.

---

## 1. `src/main.ts` — CORS: allow dynamic preview origins (non-prod only)

The hardcoded `ALLOWED_ORIGINS` array rejects `https://pr-42-moly-backend.prv.twizz.com`
and Vercel preview URLs. Replace the `origin: ALLOWED_ORIGINS` line in
`app.enableCors({...})` with a callback:

```ts
const PREVIEW_ORIGIN_PATTERNS =
  process.env.NODE_ENV === 'production'
    ? []
    : [/\.preview\.twizz\.app$/, /\.vercel\.app$/];

app.enableCors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // same-origin / curl
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    try {
      const host = new URL(origin).hostname;
      if (PREVIEW_ORIGIN_PATTERNS.some((re) => re.test(host))) {
        return callback(null, true);
      }
    } catch {}
    return callback(new Error(`Origin ${origin} not allowed by CORS`), false);
  },
  // ...rest unchanged (methods, credentials, allowedHeaders, ...)
});
```

## 2. `src/modules/storage/services/AwsSecretsManager.ts` — IRSA + env precedence

Two problems for previews:
- The client passes `credentials: { accessKeyId: process.env.AWS_ACCES_KEY_ID, ... }`
  explicitly. In-cluster there are no static keys — passing `undefined` breaks the
  default AWS credential chain (IRSA web identity). Only pass credentials when the
  env keys exist.
- `process.env = { ...process.env, ...secret }` lets the secret OVERWRITE env vars,
  so per-namespace overrides from the ConfigMap (QUEUE_ENV, APP_URL, …) are lost.
  Env must win over the secret.

```ts
const client = new SecretsManagerClient({
  region: process.env.AWS_REGION,
  ...(process.env.AWS_ACCES_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
    ? {
        credentials: {
          accessKeyId: process.env.AWS_ACCES_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        },
      }
    : {}), // default chain: IRSA in-cluster, profile locally
});
```

```ts
const secret = JSON.parse(response.SecretString);

// Per-PR preview isolation: rewrite the Mongo database path when set.
if (process.env.MONGO_DB_OVERRIDE) {
  const rewriteDb = (uri: string, db: string) =>
    uri?.replace(/(mongodb(?:\+srv)?:\/\/[^/]+)\/[^?]*/, `$1/${db}`);
  secret.MONGO_URI = rewriteDb(secret.MONGO_URI, process.env.MONGO_DB_OVERRIDE);
  secret.SHIFT_FOUR_MONGO_URI = rewriteDb(
    secret.SHIFT_FOUR_MONGO_URI,
    `${process.env.MONGO_DB_OVERRIDE}_shift4`,
  );
}

global.secret = secret;
// env wins over secret (was the other way around):
process.env = { ...secret, ...process.env };
```

Note `global.secret` receives the overridden URIs, so `mongodb.provider.ts`
needs no change.

## 3. `k8s/` manifests — nothing to change

The NonProd chart replaces the raw YAML entirely; existing staging/prod manifests
stay untouched. Do NOT copy `deployment-pr.yaml` conventions — that file is
production (4 replicas, `:prod` tag), not pull-request related.

## Files to add

| Source (this folder) | Destination in Moly-backend |
|---|---|
| `preview.yml` | `.github/workflows/preview.yml` |
| `Dockerfile` | `Dockerfile` (replaces single-stage build) |

## Prerequisites (platform side, once)

- `pulumi up` applied → roles `twizz-gha-ecr-push`, `twizz-nonprod-preview-pods` exist
- Secrets Manager `preview/moly-backend` created (dev secret clone, prod values stripped,
  Mongo pointing at `nonprod-twizz` Atlas cluster with the shared preview user)
- `TwizzyNicky/twizz-gitops` repo pushed + root-app applied

## Verify end-to-end

1. Open a PR with any change; CI builds, pushes `pr-<n>-<sha>`, adds `preview` label.
2. `https://pr-<n>-moly-backend.prv.twizz.com/health` → 200 within ~10 min.
3. Mongo: connections land in db `pr_moly_<n>` on nonprod-twizz (check Atlas metrics).
4. Close the PR → namespace `pr-moly-backend-<n>` disappears.
