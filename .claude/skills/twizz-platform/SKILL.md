---
name: twizz-platform
description: Operate the Twizz IDP platform — inspect clusters/previews/logs/costs and perform gated platform actions (tear down previews, rebuild, rotate preview secrets, scale shared services) through the twizz-platform MCP server with strict authorization. Use for "why is pr-42 failing", "list previews", "cost this week", "delete the preview for PR 17", "onboard repo X".
---

# Twizz Platform Operations

All platform operations go through the `twizz-platform` MCP server (configured in
`.mcp.json`, runs locally over stdio). It NEVER uses the admin AWS profile: read
tools run as `twizz-mcp-readonly` (assumed at startup), write tools assume
`twizz-mcp-operator` per call with session tags (tool/resource/actor → CloudTrail).

## Read tools (no gating)

| Tool | Use for |
|---|---|
| `platform_status` | pods per namespace on all three EKS clusters |
| `list_previews` | live `pr-*` preview envs on NonProd + their URLs |
| `service_logs` | CloudWatch app logs (cluster/namespace/pod, filter pattern, minutes back) |
| `pipeline_status` | recent GitHub Actions runs for a repo |
| `cluster_health` | EKS control-plane info + node pressure |
| `cost_report` | AWS spend by service, last N days |

## Write tools (all gated)

`delete_preview`, `trigger_preview_refresh`, `rotate_preview_secret`,
`scale_shared_service`.

Gates, in order — do not try to bypass them:
1. **Policy** (`apps/mcp/policy.yaml`): allowlist per tool; anything matching
   `*prod*` is denied globally. Denials are audited too.
2. **Two-step confirm**: first call returns a summary + `confirm` nonce. Show the
   summary to the user, get their explicit yes, then repeat the call with
   `confirm`. Never auto-confirm in the same breath without user approval.
3. **Session-tagged operator role** — scoped IAM, `preview/*` resources only.
4. **Audit log** — every call lands in the `AuditLog` table (or
   `~/.twizz-mcp-audit.jsonl` fallback).

## Playbooks

- **"Why is PR 42's preview broken?"** → `list_previews` (does `pr-moly-backend-42`
  exist?) → `service_logs` for that namespace (filter `?ERROR`) → `pipeline_status`
  for the repo (did CI push the image?). Common causes: CI never added the
  `preview` label; ImagePullBackOff (image tag mismatch); secret
  `preview/moly-backend` missing → app throws at boot.
- **"Tear down PR 17"** → `delete_preview {repo, pr}` — it only removes the
  `preview` label; Argo CD prunes the namespace within a minute.
- **"Rebuild PR 42"** → `trigger_preview_refresh`.
- **"Onboard repo X"** → not an MCP tool yet; follow `docs/enablement/` patterns
  (CI workflow + gitops values + ApplicationSet) until the onboarding CLI ships.

## Environment the server expects

`AWS_PROFILE=twizz` (only to assume the two roles), `GITHUB_TOKEN` (repo scope,
for pipeline_status + label operations), optional `DATABASE_URL` (Neon audit),
optional `TWIZZ_NONPROD_KUBECONFIG` (defaults to `~/.kube/twizz-nonprod.yaml`).
