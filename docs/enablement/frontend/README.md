# frontend (MymTwo/frontend) — Vercel PR previews

Goal: native Vercel preview per PR, optionally pointed at a backend preview.

## 1. Reconcile the Vercel project link (one-time, dashboard clicks)

- Canonical project: `prj_3Op05Dm743j4qscD37c6hpfHRnfD` ("frontend") in team
  `team_ocn3vwvvs3VDxcjxNcY7l8Mu` (Loly) — this is what the deploy hooks target.
- The repo's `.vercel/project.json` points at a DIFFERENT project
  (`prj_vlZvw7vg…`, org `team_eZiKDLZ…`) — stale. Delete `.vercel/` from the
  working tree (it's local linkage only) and re-link: `vercel link` → Loly team →
  frontend project.
- In Vercel → frontend project → Settings → Git: **connect `MymTwo/frontend`**.
  Once connected, every PR gets a preview deployment automatically; pushes to
  `staging`/`dev` deploy those branches.

## 2. Delete the curl deploy-hook workflow

Remove `.github/workflows/deploy.yml` (the two `api.vercel.com/v1/integrations/deploy/...`
curls). The Git integration replaces it. Keep `pr_agent.yml` until Phase 6 swaps
it for claude-code-action.

## 3. (Opt-in) point a frontend PR at a backend preview

`REACT_APP_*` is baked at build time, so the wiring must happen before Vercel
builds. Add `backend-link.yml` (in this folder) — when a PR body contains a line
`Backend-PR: #<n>`, it sets branch-scoped env vars via the Vercel API before the
preview build:

- `REACT_APP_API_ENDPOINT=https://pr-<n>-moly-backend.prv.twizz.com`
- `REACT_APP_SOCKET_ENDPOINT=wss://pr-<n>-moly-backend.prv.twizz.com`

Default (no tag): previews use the staging backend — zero coupling.

Secrets needed in the repo: `VERCEL_TOKEN` (scoped to the Loly team). Project/team
ids are public identifiers and live in the workflow env.

## 4. Hygiene while you're in there

- `vercel.json` carries a plaintext `X-Prerender-Token` — move to a Vercel env var
  and rotate it (see twizz-idp/docs/SECURITY-ROTATIONS.md §4).
