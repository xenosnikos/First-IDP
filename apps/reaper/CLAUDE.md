# @twizz-idp/reaper

Hourly CronJob (namespace `nebula`, SA `reaper`, IRSA `twizz-nebula-reaper`) that
closes the two gaps GitOps leaves open:

1. **Expired named envs** — `named-envs/*.yaml` whose `expiresAt` is past →
   `teardownNamedEnv` (manifest commit + per-env secret delete). Argo prunes the
   app; the chart's PostDelete hook drops the db.
2. **Orphan namespaces** — namespaces labelled `twizz-idp/preview=true` whose
   Argo Application is gone (`env-<name>` → `env-<name>`; `pr-<repo>-<n>` →
   labels `twizz-idp/repo`/`twizz-idp/pr`). Argo never deletes namespaces it
   created. Grace period 10 min; unlabelled namespaces are never touched.

Non-interactive, so no confirm nonce — but every action writes an AuditLog row
(`actor: reaper`; Prisma when `DATABASE_URL`, else a JSONL file) and a stdout line
(CloudWatch). `REAPER_DRY_RUN=true` only prints what it would do.

Run locally: `GITHUB_TOKEN=… AWS_PROFILE=twizz KUBECONFIG=~/.kube/twizz-nonprod.yaml REAPER_DRY_RUN=true pnpm --filter @twizz-idp/reaper start`.
Decision logic is pure (`expiry.ts`, `orphans.ts`) and unit-tested.
