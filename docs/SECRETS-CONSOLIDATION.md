# Secrets Consolidation — inventory, root cause, target, minimal migration

Audit date: 2026-08-21. Read-only. **No secret values appear in this file** — names, locations,
consumers and key-set shapes only. Scope: AWS 848281935985 (eu-west-1), EKS-Moly-staging
(`default`=staging, `dev`, `jobs`), local clones of `twizz-app/Moly-backend`,
`lolygram-discover`, `twizz-sentinel`, `twizz-idp`, `twizz-gitops`, Atlas project
`684296275fe8cc27d7b99d9b`. EKS-Moly-Prod was **not** connected to (see §5).

## 0. TL;DR

There is one real store already (Secrets Manager `<env>/moly/backend`, 44–58 keys each) but
**five parallel paths** feed the same values into the app, each with a different precedence:

1. SM JSON → `process.env` (secret **overwrites** env) — `AwsSecretsManager.getSecretString()`
2. ConfigMap `moly-cm`/`loly-cm` → `envFrom` (holds `ADMIN_PASSWORD`, `NEW_RELIC_LICENSE_KEY`, `EARNING_PASSWORD`, `INTERNAL_SERVICE_TOKEN`, `FFMPEG_JWT_SECRET` in the prod yaml)
3. K8s Secret `moly-secret`/`loly-secret` → **static IAM keys of `user-awscli`** used only to bootstrap path 1
4. Mongo `settings` collection (key/value docs) — Agora/Stripe/Google/Twitter/CCBill/reCAPTCHA/Wise creds, **read in preference to SM** by `SettingService.getValueByKey()`
5. `SETTING_DEFAULTS` (a JSON blob *inside* the SM secret) as fallback for path 4

Rotating a key in SM therefore only "takes" for families read via `global.secret.*`; anything
read via the settings collection (Agora, Stripe…) or via ConfigMap keeps the old value.

## 1. Inventory

Legend — SM = Secrets Manager, CM = ConfigMap, KS = K8s Secret, GHA = GitHub Actions secret.
"Divergent" = key sets differ across copies (observed by comparing key names only).

| Family | Where it lives today | Consumers (which copy) | Duplicate / divergence |
|---|---|---|---|
| **Mongo app URI** (`MONGO_URI`, `SHIFT_FOUR_MONGO_URI`) | SM `{prod,staging,dev,local}/moly/backend`; Lambda `MongoUpdate` **plaintext env var `MONGO_URI`**; Notion "Twizz DB" page (per SECURITY-ROTATIONS §1); 6 Atlas users (`twizz_user` readWriteAnyDatabase, `harshit`,`rohit`,`oussama`,`mustapha`,`saad` readWrite@moly — `saad` has **no cluster scope**) | `mongodb.provider.ts:16,58` via `global.secret` | SM vs Lambda env vs Notion = 3 copies, not comparable (values not read). Atlas has personal users doing app work. |
| **AWS static keys — bootstrap** (`AWS_ACCES_KEY_ID`[sic], `AWS_SECRET_ACCESS_KEY`, `AWS_SECRET_NAME`, `AWS_REGION_NAME`) | KS `default/moly-secret`, `jobs/moly-secret` (→ `staging/moly/backend`), `dev/loly-secret` (→ `dev/moly/backend`); KS `default/access-key` (`accessKeyId`,`secretAccessKey`, **orphan, nothing mounts it**); CM `default/nodejs-env-stg` key `.env` (contains the same 4 names + `REDIS_PASSWORD`, **orphan**); CM `default/env-config` key `env` (orphan) | All 4 KS copies hold the **same IAM user `user-awscli`** key (created 2026-08-20, last used S3 today; older key `…QI2BBIUB` Inactive). Read by `AwsSecretsManager.ts:15`, `SQSService.ts:29`, `storage.controller.ts:73`, lolygram-discover `src/config/aws/AwsSecretsManager.ts`. Mounted by 10 deployments (`moly-backend`, `alert-service`, `invoice-gen`, `lolygram-discovery`, `sendgrid-webhook`, `stats-svc` in `default`; `loly-backend-dev`, `lolygram-discovery-dev` in `dev`; `email-service`, `payment-serv` in `jobs`) | 4 hand-made KS + 2 orphan CMs carrying the same key. Typo `AWS_ACCES_KEY_ID` is load-bearing everywhere. `user-awscli` policy `CliUser-DeployMedia-Scoped` is CodeBuild/ECR-shaped, **not** SM-scoped (SM access comes from elsewhere/implicit) — over-broad for a runtime identity. |
| **AWS static keys — S3 runtime** (`AWS_S3_ACCESS_KEY_ID`, `AWS_S3_SECRET_ACCESS_KEY`) | SM all 4 secrets | `global.secret` readers in storage module | IAM user `local-user` (policy `LocalUser-AppRuntime-Scoped`, last used **secretsmanager** 2026-08-20) is the likely owner; cannot confirm without reading the value. Second static-key family for the same pods. |
| **AWS static keys — humans/tools** | IAM users `Nick` (2 active keys; one is in `apps/dashboard/.env.local` `AWS_ACCESS_KEY_ID`), `Deepanshu` (used sts 2026-08-11), `abdellatif`, `badr` (inline `Dev-Secrets` = `secretsmanager:*` on dev/local/staging secrets), `rohit` | dashboard `.env.local`; humans | Dashboard has IRSA/OIDC role `twizz-dashboard-readonly` already — static key is redundant. |
| **Admin password / admin API key** | CM `moly-cm`/`loly-cm`/`jobs/moly-cm` key **`ADMIN_PASSWORD`** (+ repo files `molyb-{dev,staging,prod}-cm.yml`); SM `ADMIN_API_KEY` | `apiKey-auth.guard.ts:10` reads `global.secret.ADMIN_API_KEY`; `ADMIN_PASSWORD` consumed by seed/admin flows via env | Password in ConfigMap in 3 namespaces and committed to git. |
| **Earning password** | CM `moly-cm` `EARNING_PASSWORD`; SM? (not in key list) | `auth.service.ts:133` reads `global.secret.EARNING_PASSWORD \|\| process.env.EARNING_PASSWORD` | Lives only in CM today; code already prefers SM → moving it is a pure add. |
| **Internal service token** | CM `jobs/moly-cm` `INTERNAL_SERVICE_TOKEN` | `internal-service.guard.ts:26` actually verifies with `global.secret.TOKEN_SECRET` | CM key appears unused by the guard → candidate for deletion after grep in email/payment services. |
| **JWT / TOKEN_SECRET** | SM `TOKEN_SECRET` (all 4) | `auth.service.ts:155,179,205`, `ws-auth.guard.ts:88`, `file.service.ts:2317,2336` | Single copy — good. |
| **FFmpeg JWT** | KS `default/ffmpeg-secret` key `JWT_SECRET` (**orphan**); repo `molyb-prod-cm.yml` key `FFMPEG_JWT_SECRET` | `video.service.ts:223` reads `process.env.FFMPEG_JWT_SECRET` (only from CM/prod) | Two names for one secret; ffmpeg side unknown (prod). |
| **New Relic license** | CM `moly-cm` `NEW_RELIC_LICENSE_KEY` | newrelic agent via env | Credential in ConfigMap. |
| **Agora** (`AGORA_APP_ID`, `AGORA_CERTIFICATE`, `AGORA_CUSTOMER_ID/SECRET`) | SM (staging/local have CUSTOMER_*; **prod/dev lack them**); Mongo `settings` docs (seeded by `migrations/1646523906363-create-agora-setting.js`, editable via `PUT /admin/settings/:key`) | `agora.service.ts:20-21,43-44`, `agora-cloud-recording.service.ts:40-113` read **Mongo first** (`getValueByKey`), SM only as fallback | **Divergent by construction**: SM rotation is ignored while a Mongo doc exists. |
| **Stripe / Shift4 / Paysafe / Wise** | SM (`STRIPE_*`, `SHIFT_*`, `SHIFT4_WEBHOOK_SECRET`, `PAYSAFE_*` — dev lacks PAYSAFE_*, staging alone has `PAYSAFE_WEBHOOK_SECRET`, local has `WISE_API_SANDBOX_KEY` instead of `WISE_API_KEY`); Mongo `settings` keys `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `WISE_API_SANDBOX_KEY`, `CCBILL_*`, `BITPAY_API_TOKEN` (from `settings/constants/index.ts`); Lambda `ChargePipeline*` env `SHIFT4_SECRET_NAME` (pointer, OK) | `syncCache()` overlays `global.secret[key]` onto the settings cache for matching keys; but any `getValueByKey()` caller gets Mongo first | Same dual-store pattern as Agora. |
| **Google / Twitter OAuth, reCAPTCHA** | SM `GOOGLE_CLIENT_ID/SECRET`; Mongo `settings` `GOOGLE_*`, `TWITTER_CLIENT_*`, `GOOGLE_RECAPTCHA_*` | settings module | Twitter/reCAPTCHA exist **only** in Mongo. |
| **SMTP** (`SMTP_AUTH_USER/PASS`, `SMTP_TWIZZ_KEY`, `CREATOR_NOTIFICATION_SMTP_AUTH_PASS`, `MAILGUN_API_KEY`) | SM; Mongo `settings` `SMTP_TRANSPORTER` (object with `auth.user/pass`) | `setting.service.ts:54-60` copies SM user/pass **into** the cached `SMTP_TRANSPORTER`; `mailer.service.ts:51-52` and 8 other sites read `global.secret.SMTP_AUTH_PASS` directly | Two readers, two sources; works only because of the in-memory patch. dev lacks `SMTP_TWIZZ_KEY`. |
| **Redis** (`REDIS_HOST/PORT/PASSWORD/PREFIX`) | SM; CM `nodejs-env-stg` `.env` blob (orphan) | `redis.*`, `bullmq.module.ts`, `queue.service.ts` via `global.secret` | Orphan copy only. |
| **Third-party API keys** (MaxMind, Dataleon, Bincode, Bouncer, AI analyze, PostHog, SMS Factor, OpenRouter, NPM_TOKEN, GITHUB_TOKEN) | SM only; key sets differ per env (`OPENROUTER_API_KEY`, `BOUNCER_API_KEY` missing in dev; `GITHUB_TOKEN` only in prod; `NPM_TOKEN` absent in prod) | `global.secret` / env | Drift between envs, not duplication. |
| **SQS queue URL** | SM `SQS_QUEUE_URL`; code also reads `global.secret.AWS_SQS_QUEUE_URL` (`config/queue.ts:2`) with a hard-coded dev fallback | `SQSService.ts:35` vs `config/queue.ts:2` | Two names, one of which never exists in SM. |
| **GitHub token (platform)** | expected SM `preview/github` (**does not exist**); GHA `secrets.ORG_WATCH_TOKEN`, `secrets.OPENAI_KEY` (Moly-backend `pr_agent.yml`), `secrets.VERCEL_TOKEN` | twizz-gitops `bootstrap/github-token-externalsecret.yaml` | ESO will fail until `preview/github` exists. |
| **Dashboard / platform creds** | `apps/dashboard/.env.local` (21 keys incl. `GITHUB_CLIENT_SECRET`, `VERCEL_TOKEN`, `ATLAS_PRIVATE_KEY`, `ANTHROPIC_API_KEY`, stale `ARGO_TOKEN`, `ARGOCD_AUTH_TOKEN`); `twizz-sentinel/.env.example` + `src/config/secrets.ts` (`SENTINEL_API_KEY`, `ANTHROPIC_API_KEY`, `AWS_SECRET_NAME`) | dashboard locally | Rotation list already in SECURITY-ROTATIONS §2. |
| **CI** | CodeBuild projects (20) have **no** env vars; roles `codebuild-Moly-backend-service-role` etc.; GHA OIDC roles `twizz-gha-ecr-push`, `twizz-gha-sam-deploy` exist; `image_conversion_service` deploy.yml still uses `aws-access-key-id` (per `docs/enablement/image_conversion_service/NOTES.md`) | — | One static-key workflow left. |
| **Lambda `handleListenEarningProd`** | calls `GetSecretValue` on `prod/moly/backend` **~20×/second** (CloudTrail, today) | — | Not a sprawl issue but a cost/throttle one: no caching. |
| **Dynatrace** | KS `dynatrace/moly-backend-stg` (`apiToken`, `dataIngestToken`) | Dynatrace operator | Leave (operator-owned). |
| **Cluster plumbing** | cert-manager, ingress admission, Grafana, Loki, CloudWatch, OTel certs/secrets | operators | Out of scope. |

Not present: SSM Parameter Store (only the CDK bootstrap version), ECS (task family `Backend` has no env/secrets), External Secrets Operator or Secrets-Store CSI on staging (**absent**), IRSA on any app ServiceAccount (all run as `default`; only the EBS/EFS CSI controllers use IRSA).

## 2. Root cause — why rotations break

Four precedence rules coexist in Moly-backend (`lolygram-discover` copies rule 1):

1. `src/modules/storage/services/AwsSecretsManager.ts` → `process.env = { ...process.env, ...secret }`.
   **SM wins over env.** A ConfigMap/Helm override is silently discarded if SM has the same key, and
   a value rotated *only* in the CM is ignored.
2. `src/modules/settings/services/setting.service.ts#syncCache()` → overlays `global.secret[KEY]`
   onto the in-memory settings cache **only for keys that already exist in Mongo**, and patches
   `SMTP_TRANSPORTER.auth.*` specially. **SM wins over Mongo — but only in the cache.**
3. `SettingService.getValueByKey()` → `findOne({key})` on Mongo, fallback to
   `JSON.parse(global.secret.SETTING_DEFAULTS)[key]`. **Mongo wins over SM.** Every Agora call
   site and the payment-gateway selector use this path. Rotating `AGORA_CERTIFICATE` in SM does
   nothing while the Mongo doc exists; an admin editing it in the UI (`PUT /admin/settings/:key`)
   silently forks the value from SM.
4. The SM client itself is bootstrapped from static keys copied into **four hand-made K8s
   Secrets** (`moly-secret` ×2, `loly-secret`, `access-key`) and two orphan ConfigMaps. Rotating
   `user-awscli` requires editing 4 Secrets in 3 namespaces by hand; missing one breaks boot for
   that namespace. The IAM user was rotated **yesterday** (2026-08-20) — which is exactly the
   moment this problem surfaces.

Secondary: typo `AWS_ACCES_KEY_ID` must be preserved across every copy; `AWS_SQS_QUEUE_URL`
vs `SQS_QUEUE_URL` name split; per-env key-set drift (table above) means a "rotate everywhere"
script cannot assume a common schema; credentials committed in `molyb-*-cm.yml`.

## 3. Target model (one source of truth)

- **Store:** AWS Secrets Manager only. Naming `<env>/<service>/<group>`; keep the existing
  `{dev,staging,prod}/moly/backend` as the per-service **runtime** group and add
  `preview/moly/backend` (dev clone, prod values stripped, Mongo → `nonprod-twizz` shared user)
  plus `preview/github` (ESO for Argo). One secret per service; one JSON key per env var.
- **Delivery:** ESO `ExternalSecret` (`dataFrom.extract`) → K8s Secret `<svc>-secrets`,
  `envFrom` in the pod. **No hand-made K8s Secrets, no credential keys in ConfigMaps, no SM
  client in the app, no secrets in Mongo.** Rotation = `PutSecretValue` → ESO refresh (1h, or
  `kubectl annotate externalsecret force-sync`) → `rollout restart`.
- **Identity:** IRSA for pods (`twizz-nonprod-preview-pods`, and an equivalent staging role);
  ESO via `twizz-eso`; CI via GitHub OIDC (`twizz-gha-ecr-push`, `twizz-gha-sam-deploy`);
  humans via SSO/`AWS_PROFILE`. Zero static access keys in clusters, CI, or `.env` files.
- **App contract:** read `process.env` only, once, at boot. Settings collection holds *business
  settings* (commissions, emails, feature flags) — never credentials.

Already provided by twizz-idp (NonProd): ESO + `ClusterSecretStore aws-secrets-manager`
(`infra/src/bootstrap.ts:160-196`), roles `twizz-eso` and `twizz-nonprod-preview-pods` scoped to
`secret:preview/*` (`infra/src/iam.ts:35-101`), chart template
`charts/twizz-service/templates/external-secret.yaml` (currently `externalSecret.enabled: false` in
`apps/moly-backend/values.yaml`), MCP `rotate_preview_secret` (audited `PutSecretValue`), GHA OIDC
roles. **Missing:** ESO on EKS-Moly-staging (not installed), an IRSA role for staging/dev
namespaces scoped to `staging/*` and `dev/*`, the `preview/*` secrets themselves, the app code
change, a `rollout restart` step after rotation (ESO updates the Secret but `envFrom` pods need a
restart — add `reloader` annotation or the MCP tool does it).

## 4. Minimal migration plan (zero downtime, 7 steps)

Each step is independently reversible; the old path keeps working until its "DELETE" line.

| # | Action | Who | Blast radius | Rollback | Deletes |
|---|---|---|---|---|---|
| **1** | **Code: make env the only input, SM client optional.** In `AwsSecretsManager.ts`: (a) only pass `credentials` when `AWS_ACCES_KEY_ID` is set (default chain → IRSA); (b) `process.env = { ...secret, ...process.env }` (env wins); (c) skip the SM call entirely when `AWS_SECRET_NAME` is unset and populate `global.secret = process.env` so the 40+ `global.secret.*` readers keep working. Same two-line change in `lolygram-discover/src/config/aws/AwsSecretsManager.ts`. Rename nothing yet (keep the `AWS_ACCES_KEY_ID` typo). Ship as the enablement PR already drafted in `docs/enablement/moly-backend/PATCHES.md` §2. | agent writes PR; user merges | None at runtime: with today's manifests `AWS_SECRET_NAME` is still set, so behaviour is identical except env now wins over SM (no current CM key collides with a *credential* SM key; only `S3_BUCKET_NAME`, `BUSINESS_URL`, `REDIS_*`-style config keys overlap — verify in PR). | revert PR | nothing yet — enabler |
| **2** | **Code: stop reading credentials from Mongo.** In `setting.service.ts`: make `getValueByKey()` return `process.env[key] ?? SETTING_DEFAULTS[key]` for any key listed in a new `CREDENTIAL_SETTING_KEYS` set (`AGORA_*`, `STRIPE_*`, `GOOGLE_CLIENT_*`, `TWITTER_CLIENT_*`, `GOOGLE_RECAPTCHA_*`, `CCBILL_*`, `BITPAY_API_TOKEN`, `WISE_API_*`, `SMTP_TRANSPORTER`); reject those keys in `admin-setting.controller.ts` `update()`/`create()` (HTTP 400); drop the `syncCache()` overlay block. Add the keys missing from SM first (`AGORA_CUSTOMER_ID/SECRET` in prod/dev, `TWITTER_*`, `GOOGLE_RECAPTCHA_*`) — values copied from the Mongo docs by the user. | agent PR + user copies values into SM via console/MCP | Agora/Stripe calls switch source at deploy; if SM lacks a key the call fails → pre-flight: diff Mongo keys vs SM keys per env (names only) before merge. | revert PR (Mongo docs untouched until step 7) | Mongo credential docs (step 7) |
| **3** | **Install ESO + IRSA on EKS-Moly-staging.** Reuse the Pulumi pattern from `bootstrap.ts`/`iam.ts` as a new small stack or Helm install (user decides; agent drafts): namespace `external-secrets`, `ClusterSecretStore aws-secrets-manager`, role `twizz-staging-eso` → `secret:staging/*`,`dev/*`; app role `twizz-staging-pods` (SM read on the same ARNs + the S3/SQS/MediaConvert actions from `LocalUser-AppRuntime-Scoped`), ServiceAccounts `moly-backend` in `default`/`dev`/`jobs` annotated with it. | user (cluster-admin apply) with agent-drafted manifests | Additive; no workload touched. | `helm uninstall` | — |
| **4** | **ExternalSecrets per namespace** (in `twizz-gitops`, or raw YAML for staging since it is not Argo-managed yet): `default/moly-backend-secrets` ← `staging/moly/backend`, `dev/loly-backend-secrets` ← `dev/moly/backend`, `jobs/moly-backend-secrets` ← `staging/moly/backend`, each `dataFrom.extract`, `refreshInterval: 1h`. Add `reloader.stakater.com/auto: "true"` (install Reloader) **or** document `rollout restart` as part of rotation. Also create `preview/moly/backend` + `preview/github` in SM and flip `externalSecret.enabled: true` / `remoteRef: preview/moly/backend` in `apps/moly-backend/values.yaml`, remove `AWS_SECRET_NAME` from its `env:`. | agent writes manifests; user applies / pushes gitops | Creates new Secrets alongside the old ones; nothing reads them yet. | delete the ExternalSecret objects | — |
| **5** | **Cut over deployments** (one namespace at a time, `dev` first): change `envFrom` from `moly-secret`/`loly-secret` to `<svc>-secrets`, set `serviceAccountName`, **remove `AWS_SECRET_NAME`** from the env, move `ADMIN_PASSWORD`, `EARNING_PASSWORD`, `NEW_RELIC_LICENSE_KEY`, `FFMPEG_JWT_SECRET`, `INTERNAL_SERVICE_TOKEN` into the SM JSON and delete those keys from `moly-cm`/`loly-cm` (+ the `molyb-*-cm.yml` files in the repo). Rolling update = zero downtime. | user applies (agent drafts diffs) | One namespace per apply; pods boot from env only. Readiness probe guards the rollout. | `kubectl rollout undo` (old Secret still present) | after soak: KS `default/moly-secret`, `jobs/moly-secret`, `dev/loly-secret`, `default/access-key`; CM `default/env-config`, `default/nodejs-env-stg`, `default/ffmpeg-secret`; credential keys in `moly-cm`/`loly-cm`; repo `molyb-*-cm.yml` credential keys |
| **6** | **Kill static AWS keys.** Move the S3/MediaConvert permissions of `LocalUser-AppRuntime-Scoped` onto the pod role (step 3) and remove `AWS_S3_ACCESS_KEY_ID/SECRET` from the SM JSON once `storage` code uses the default chain (check `storage.controller.ts:73`, `SQSService.ts:29`); switch `image_conversion_service/deploy.yml` to `role-to-assume: twizz-gha-sam-deploy`; replace the dashboard `.env.local` AWS pair with `AWS_PROFILE`/role. Point Lambda `MongoUpdate` at SM (`MONGO_URI` env → `SECRET_NAME`) and add a 5-min cache to `handleListenEarningProd`. | user (IAM deletes) | Per-key: deactivate first (`update-access-key --status Inactive`), watch CloudTrail 24h, then delete. | re-activate key | IAM users `user-awscli`, `local-user` (keys then users); `Nick` key `…V5UXAFUM` (unused since Jan 2026); `Deepanshu` key if idle; `badr` inline `Dev-Secrets` |
| **7** | **Delete duplicates + rotate once.** Remove credential docs from Mongo `settings` (keys in step 2 list) in each DB; delete the Notion credential block; drop Atlas personal users doing app duty (`saad` unscoped, `harshit`, `rohit`, `oussama`, `mustapha` → per-person read-only or remove) and create `app_staging`, `app_dev`, `app_preview` users with scoped roles; rotate every family **once** in SM (this is the first rotation that will actually propagate everywhere). | user | Rotation touches live envs — do per env, `rollout restart` after each. | SM `AWSPREVIOUS` stage (`update-secret-version-stage`) | stale `AWSPREVIOUS` versions after 7 days; `local/moly/backend` if nobody uses it (last accessed 2026-08-20 — confirm owner) |

### Deprecation checklist (tick only after the corresponding step has soaked)

- [ ] K8s Secrets: `default/moly-secret`, `jobs/moly-secret`, `dev/loly-secret`, `default/access-key`, `default/ffmpeg-secret`
- [ ] ConfigMaps: `default/env-config`, `default/nodejs-env-stg`; keys `ADMIN_PASSWORD`, `EARNING_PASSWORD`, `NEW_RELIC_LICENSE_KEY`, `INTERNAL_SERVICE_TOKEN` from `moly-cm`/`loly-cm`/`jobs/moly-cm`
- [ ] Repo files: credential keys in `molyb-dev-cm.yml`, `molyb-staging-cm.yml`, `molyb-prod-cm.yml`; `deployment*.yaml` `secretRef: moly-secret`
- [ ] Mongo `settings` docs for every key in `CREDENTIAL_SETTING_KEYS` (all DBs, incl. per-PR `pr_moly_<n>`)
- [ ] IAM: access keys then users `user-awscli`, `local-user`; `Nick` legacy key; `badr` `Dev-Secrets` inline policy; review `Deepanshu`
- [ ] Lambda `MongoUpdate` env `MONGO_URI`
- [ ] SM: `local/moly/backend` (if unowned); `SETTING_DEFAULTS` stays (non-secret) but should move to a ConfigMap eventually
- [ ] `apps/dashboard/.env.local`: `AWS_ACCESS_KEY_ID/SECRET`, `ARGO_TOKEN`, `ARGOCD_AUTH_TOKEN`, `ARGO_WORKFLOWS_URL`, `ARGO_CD_URL`
- [ ] Notion "Twizz DB" credential block; `~/twizz_devops/deploykey*`
- [ ] Code: `AwsSecretsManager.ts` SM branch (both repos) once no manifest sets `AWS_SECRET_NAME`; `config/queue.ts` `AWS_SQS_QUEUE_URL`; fix the `AWS_ACCES_KEY_ID` typo last (both sides at once)

## 5. Open questions / not verified

- **Prod (EKS-Moly-Prod) not inspected** by instruction. Assumed to mirror staging (`moly-cm` + `moly-secret` + `prod/moly/backend`); `deployment-pr.yaml`/`molyb-prod-cm.yml` in the repo suggest so, and prod additionally carries `FFMPEG_JWT_SECRET`/`CLOUDFRONT_PUBLIC_KEY_ID` in the CM. Steps 3–5 for prod need a separate, coordinated window.
- Which IAM user owns `AWS_S3_ACCESS_KEY_ID` inside the SM JSON (suspected `local-user`) — value not read.
- Who/what uses `local/moly/backend` (accessed 2026-08-20) and `Nick` key `…VBDNZJWK` (used today, iam, us-east-1 — probably this machine's `AWS_PROFILE=twizz`).
- `user-awscli`'s attached policy has no `secretsmanager` actions, yet the pods boot — either an inline grant not listed here, a resource policy on the secrets, or SM access failing silently in some namespaces. Check `aws secretsmanager get-resource-policy` per secret and the pods' boot logs.
- Whether the Mongo `settings` credential docs currently **differ** from SM (values not compared). Treat as divergent until the user diffs them.
- Email/payment services in `jobs` and the five sidecar services in `default` are separate repos (`alert-service`, `invoicegen`, `sendgridwebhook`, `statsservice`, `emailservice`, `paymentserv`) — not cloned locally; they mount `moly-secret` and presumably share the SM loader pattern. Step 1 must be repeated in each before step 5 removes `AWS_SECRET_NAME`.
- Atlas user `twizz_user` (`readWriteAnyDatabase`) is likely the app user in `MONGO_URI`; unconfirmed.
- CloudTrail lookup only returned the last 50 events (all `handleListenEarningProd`); other SM readers (pods via `user-awscli`) did not surface in that window.
