# Security Rotation Checklist (Phase 0)

Compiled 2026-08-11 during the IDP rebuild audit. **No secret values appear in this file.**
Items marked [COORD] will break other people/systems if rotated unilaterally — coordinate first.
Items marked [SELF] can be done solo.

## 1. MongoDB Atlas nonprod users [COORD]

Plaintext connection strings with passwords for users `rohit`, `oussama`, `mustapha` (and possibly
more) are published on the Notion page **"Twizz DB"** (`app.notion.com/p/23762fc5392c80b79d70df40be7d6f6d`),
targeting `nonprod-twizz.tjeemu.mongodb.net/moly`.

- [ ] Rotate each user's password in Atlas (or delete the users and issue per-person users fresh)
- [ ] Notify Rohit, Oussama, Mustapha of new creds via a secret channel (1Password/SM), never Notion
- [ ] Delete the credential block from the Notion page after rotation
- [ ] Going forward: nonprod DB creds live in AWS Secrets Manager `preview/*` secrets only

## 2. Dashboard `.env.local` [SELF, mostly]

`apps/dashboard/.env.local` holds 19 live values that sat on disk (gitignored, never committed).
Rotate because the file predates this audit and its history is unknown:

- [ ] GitHub OAuth app client secret (twizz-app org OAuth app `Ov23lirMDHUPPYwRkz5A`)
- [ ] Vercel token (team `team_ocn3vwvvs3VDxcjxNcY7l8Mu`)
- [ ] MongoDB Atlas API key pair (project `684296275fe8cc27d7b99d9b`, public key `iydvdumt`)
- [ ] Anthropic API key (Nebula Observer: SM `preview/nebula` key `ANTHROPIC_API_KEY`; set with `scripts/nebula-set-observer-key.sh`, then restart the dashboard)
- [ ] AWS access key pair, if any static pair is present — prefer deleting it entirely and using
      `AWS_PROFILE=twizz` locally / OIDC in CI (Phase 2+ removes all static AWS keys)
- [ ] Argo / ArgoCD tokens (moot after Phase 1 — old Argo Workflows setup is deleted)
- [ ] `NEXTAUTH_SECRET` regenerate (`openssl rand -base64 32`)

## 3. SSH deploy key [SELF]

`~/twizz_devops/deploykey` (+ `.pub`) — unencrypted RSA private key, comment `root@Xenbook2`,
not covered by that folder's `.gitignore` patterns.

- [ ] Identify which repo(s) have this deploy key installed (GitHub repo → Settings → Deploy keys)
- [ ] Remove it from GitHub, delete the local files, re-issue per-repo keys only if actually needed
- [ ] If kept: `chmod 600`, add `deploykey*` to `.gitignore`

## 4. Moly-backend repo plaintext secrets [COORD]

In `MymTwo/Moly-backend` working tree / manifests:

- [ ] `ADMIN_PASSWORD` present in dev/staging ConfigMap YAMLs (`molyb-dev-cm.yml`, `molyb-staging-cm.yml`)
      → rotate the password AND move the key into the `moly-secret`/`loly-secret` k8s Secret or SM
- [ ] `frontend/vercel.json` contains a plaintext `X-Prerender-Token` → move to a Vercel env var,
      rotate the token at prerender.io
- [ ] `.env` files on disk in Moly-backend / frontend / commandcenter — verify gitignored, rotate any
      value that is also a prod value

## 5. Kube-context safety [SELF] — DONE (see below)

`~/.kube/config` mixes 4 clusters from 3 orgs and its `current-context` was an unrelated Azure
cluster. Per-cluster kubeconfigs now live in `~/.kube/twizz-*.yaml`; use
`KUBECONFIG=~/.kube/twizz-staging.yaml kubectl ...` (aliases: `ktw-staging`, `ktw-prod`).
Never merge Twizz contexts back into the default config.

## 6. Process going forward

- Secrets only in AWS Secrets Manager (runtime) or provider-native stores (Vercel env vars)
- No secrets in Notion, ConfigMaps, repo files, or chat
- CI auth is GitHub OIDC → IAM roles (no static keys) from Phase 2 onward
- The MCP write-tier audit log (Phase 7) records all platform secret operations
