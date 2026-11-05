---
name: nebula
description: Use Nebula (Twizz's internal developer platform) through the `nebula` MCP server — spin up a preview env of a twizz-app repo/branch on EKS-Twizz-NonProd (backend or frontend on <name>.prv.twizz.com), rebuild/extend/tear it down, promote a service to STAGING, and diagnose failures from NonProd/staging/PROD logs (read-only), the prod/staging monitor, CI runs and twizz-sentinel alerts. Use for "spin up a preview of my branch", "why is env X failing", "what's erroring in prod", "what's broken on staging", "promote sentinel to staging", "show sentinel alerts". Never to change production.
---

# Nebula from Claude Code

The `nebula` MCP server is Nebula itself (`https://nebula.prv.twizz.com/api/mcp`, VPN only).
You act as the user's GitHub login; Nebula decides what they may do:

- **everyone signed in**: all reads, `create_env_from_repo` (self-service previews)
- **env owner or operator**: `rebuild_env`, `set_env_vars`, `extend_env`, `teardown_env`
- **operators** (`nebula_whoami` → `operator: true`): `create_named_env`, `clone_staging_db`, `promote_release`, `merge_promotion`

**Production is read-only.** You can read EKS-Moly-Prod logs, pods, nodes and the prod monitor (and prod sentinel alerts once it is reachable) — nothing changes it: promotions only target staging, and prod capacity/Atlas are Nebula-UI-only. If the user asks to change prod, say so and point them to the platform owner.

Prod logs contain real user data: quote only what the diagnosis needs, never dump raw lines with personal data into PRs, tickets or chat.

## The confirm rule (every write)

1. Call the tool without `confirm`. Nothing happens; you get `CONFIRMATION REQUIRED` + a summary + a nonce.
2. Show the summary to the user **verbatim** and ask for an explicit yes.
3. Only after that yes, call again with **the exact same arguments** plus `confirm="<nonce>"`.

Never invent, reuse or "pre-confirm" a nonce. If the user changes anything, start again at step 1.
A `DENIED` / `FORBIDDEN` reply is final: report who may do it instead of retrying.

## Spin up a preview from a branch

1. `nebula_whoami`, then `list_envs` (is the name taken? is there already an env for this branch?).
2. `branch_head {repo, branch}` → pin the `sha`.
3. `repo_config {repo, sha}`:
   - has a valid twizz.yaml + Dockerfile → pass that twizz.yaml as `twizzYaml`, no `files`.
   - missing → write a minimal twizz.yaml (version 2, kind, port, healthPath, secrets by NAME, needs.mongo) and pass it in both `twizzYaml` and `files` (a config PR is opened on `nebula/<name>`).
4. Frontend? It must attach to a backend: `attachEnv` (a named env) or `attachUrl` (an `https://*.twizz.com` origin, e.g. the staging API).
5. `create_env_from_repo` → confirm rule. The env becomes `https://<name>.prv.twizz.com` once the build lands (a few minutes): watch it in `list_envs` (pending → ready).
6. **Secrets**: declared secrets are created blank. Values never go through you; tell the owner to fill them in Nebula (Environments → env → Env vars). `set_env_vars` is for non-credential values only and refuses anything that looks like a key.

## Diagnose a failing env / staging

Scope = `cluster` + `namespace`:
- named env `foo` → `EKS-Twizz-NonProd` / `env-foo`
- PR preview → `EKS-Twizz-NonProd` / `pr-<n>-<service>`
- staging → `EKS-Moly-staging` / `default` (dev: `dev`, sentinel: `sentinel`)
- production → `EKS-Moly-Prod` / `default` (cron jobs: `jobs`) — read-only

1. `cluster_overview` or `list_pods` — CrashLoopBackOff, restarts, missing pods?
2. `log_histogram` (cheap) to find the burst, then `fetch_logs` with `from`/`to` around it, `errorsOnly: true`, `filter` for the error code.
3. `get_group_samples {signature}` for the full context of one failure group.
4. Build failed (env stuck pending / FAIL)? `list_envs` shows the build; `ci_run` / `ci_job_logs` on `xenosnikos/First-IDP` (nebula-build.yml) or the service repo's own CI.
5. Security/fraud angle: `sentinel_status`, `sentinel_alerts`, `sentinel_alert {id, include: "similar"}`, `sentinel_events` — `tier: "production"` for prod (answers "not reachable" until prod sentinel is deployed with an endpoint).
6. Under load? `monitor {tier: "production" | "staging"}`.

A Logs Insights TIMEOUT or FAILED is **not** "no logs": narrow the window or pod and retry. Report what you saw with timestamps and pods; don't guess beyond the evidence.

## Promote to staging (operators)

1. `release_train` — candidates (immutable tags), what staging runs, Argo health, open promotion PRs.
2. `promote_release {service, imageTag}` → confirm rule → a PR on twizz-gitops. Nothing deploys yet.
3. `merge_promotion {prNumber, service, imageTag}` → confirm rule → Argo rolls staging (~3 min).
4. Verify: `release_train` (Argo Healthy on the new tag), then `fetch_logs` on staging `default` / the service's namespace.

## When something can't be done here

- Not reachable / `fetch failed`: the user must be on the NetBird VPN.
- `401`: `gh auth login` (or `NEBULA_GITHUB_TOKEN`); several gh accounts → `NEBULA_GH_USER=<login>`.
- `403 … not allowed on Nebula` / `not on the Nebula MCP list`: MCP is invitation-only; the platform owner adds them (`nebula-allow-login.sh <login> --mcp`).
- Capacity, node groups, Atlas tiers, any prod change: Nebula UI only, operators, by design.
