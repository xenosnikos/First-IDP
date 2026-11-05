# twizz-nebula (Claude Code plugin)

Nebula from Claude Code: spin up preview envs on EKS-Twizz-NonProd, promote to
staging, and diagnose with the Observer log queries (NonProd, staging, **prod**)
and twizz-sentinel alerts. **Production is read-only**: no tool changes it.

**Access is by invitation**: you must be allowed on Nebula AND on its MCP list
(operators, plus `NEBULA_MCP_USERS`, managed by the platform owner with
`scripts/nebula-allow-login.sh <login> --mcp`). Others get a 403.

The MCP server is Nebula itself (`POST https://nebula.prv.twizz.com/api/mcp`,
docs/NEBULA.md §N7). Every tool runs the same tRPC procedure as the Nebula UI,
as you, so the operator/owner rules, the two-step confirm gate and the audit log
are identical. Nothing to install on the laptop beyond the plugin.

## Install

Prerequisites: NetBird VPN connected, `gh auth login` done with the GitHub
account that is allowed on Nebula.

```
/plugin marketplace add xenosnikos/First-IDP
/plugin install twizz-nebula@twizz-idp
```

(From a local clone: `/plugin marketplace add /path/to/twizz-idp`.)

Token: the plugin's `headersHelper` runs `gh auth token` on each connection.
Override with `NEBULA_GITHUB_TOKEN`, or pick a gh account with
`NEBULA_GH_USER=<login>` when you have several.

## Tools

Reads: `nebula_whoami`, `list_envs`, `list_projects`, `list_repos`,
`list_branches`, `branch_head`, `repo_config`, `release_train`,
`release_images`, `cluster_overview`, `list_pods`, `log_histogram`,
`fetch_logs`, `get_group_samples`, `node_metrics`, `monitor`,
`list_ci_runs`, `ci_run`, `ci_job_logs`, `sentinel_status`, `sentinel_alerts`,
`sentinel_alert`, `sentinel_alert_stats`, `sentinel_events`.

Writes (two-step confirm): `create_env_from_repo`, `rebuild_env`,
`set_env_vars`, `extend_env`, `teardown_env` (owner or operator);
`create_named_env`, `clone_staging_db`, `promote_release`, `merge_promotion`
(operators).

The `nebula` skill describes the workflows (spin up, diagnose, promote).

## Relation to apps/mcp

`apps/mcp` (`twizz-platform`, stdio) is the platform owner's local server with
direct AWS/GitHub credentials. This plugin is the team path: no AWS keys on
laptops, Nebula's RBAC and audit on every call.
