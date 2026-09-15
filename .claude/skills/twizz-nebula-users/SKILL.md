---
name: twizz-nebula-users
description: Manage who can reach and use Nebula (nebula.prv.twizz.com) — add/remove a person across the three gates (NetBird VPN, twizz.com Google SSO, Nebula GitHub allowlist), grant/revoke operator (write) rights, and diagnose "I can't sign in". Use for "give X access to nebula", "make X an operator", "why is X denied", "offboard X".
---

# Nebula user management

Nebula sits behind three gates. A person must pass all three; each is managed
in a different place. Check them in this order when someone "can't get in".

| # | Gate | What admits a person | Where it is managed | Symptom when missing |
|---|---|---|---|---|
| 1 | **NetBird VPN** | member of NetBird group `staff` (self-hosted https://vpn.twizzbus.com) | NetBird dashboard; runbook `~/twizz_devops/docs/vpn-netbird.md`; roster `~/twizz_devops/scripts/vpn/07-who.sh` | `nebula.prv.twizz.com` does not resolve / times out (the ingress NLB is internal) |
| 2 | **Google SSO** (ingress-nginx global auth, oauth2-proxy at `auth.prv.twizz.com`) | any **twizz.com** Google Workspace account | Google Workspace (no allowlist to edit; the admin-gate allowlist in `infra/Pulumi.nonprod.yaml` is for the admin apps, not Nebula) | redirect loop or "unauthorized" before the Nebula page loads |
| 3 | **Nebula sign-in** (GitHub App `twizz-nebula`) | GitHub login in `ALLOWED_GITHUB_LOGINS` (SM `preview/nebula`), or active member of `ALLOWED_GITHUB_ORGS` (unset in-cluster) | `scripts/nebula-allow-login.sh` | "sign in" bounces back; an `AuditLog` row `action=signin allowed=false` names the login |

Writes: **any signed-in user** can "Spin up from a repo" (build-on-provision, through the
human gate) and manage the envs they own (teardown / extend / env vars / rebuild —
`manifest.owner` = their GitHub login). `NEBULA_OPERATORS` additionally unlocks the
release-image spin-up, clone-staging-db, and acting on anyone's env. Reads (Environments,
Projects, Clusters, Observer, Configurator) need only gate 3.

## Add a person (read-only)

1. Confirm gates 1–2: they appear in `07-who.sh` with group `staff` and have a twizz.com
   Google account. (Every first Google sign-in to NetBird creates a stray account —
   run `~/twizz_devops/scripts/vpn/08-merge-strays.sh`, see the runbook.)
2. Find their GitHub login. If they already tried to sign in, it is in the audit log:
   ```
   kubectl --kubeconfig ~/.kube/twizz-nonprod.yaml -n nebula exec postgres-0 -- sh -c \
     'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select \"createdAt\", actor, allowed from \"AuditLog\" where action=\x27signin\x27 order by \"createdAt\" desc limit 10;"'
   ```
3. Add the login (merges into the secret; never prints values):
   ```
   AWS_PROFILE=twizz bash scripts/nebula-allow-login.sh <github-login>
   ```
4. The pod reads the secret as env at start and the ExternalSecret resyncs hourly, so
   force it and restart:
   ```
   kubectl --kubeconfig ~/.kube/twizz-nonprod.yaml -n nebula annotate externalsecret nebula-env force-sync=$(date +%s) --overwrite
   kubectl --kubeconfig ~/.kube/twizz-nonprod.yaml -n nebula rollout restart deploy/dashboard
   ```

## Make someone an operator (writes)

`AWS_PROFILE=twizz bash scripts/nebula-allow-login.sh <github-login> --operator`, then the
resync + restart above. Keep the list short; every write is audited under their login.

## Remove / offboard

- Gate 3: edit `ALLOWED_GITHUB_LOGINS` / `NEBULA_OPERATORS` in SM `preview/nebula` (same
  merge pattern as the script, removing the login), resync, restart.
- Gate 1: NetBird → Team → Users → delete. Gate 2: suspend in Google Workspace.

## Notes

- `scripts/create-nebula-secret.sh` is the one-time bootstrap of `preview/nebula`; do not
  rerun it to change users. The old `update-nebula-oauth.sh` was deleted (it hardcoded the
  whole allowlist and would have dropped people).
- Secrets Manager writes may be blocked for Claude by the permission classifier; when they
  are, hand the exact command to the user to run with the `!` prefix.
- Observer runs are budgeted per login (`OBSERVER_DAILY_RUNS_PER_USER`) and globally
  (`OBSERVER_DAILY_RUNS`), set in the same secret via `scripts/nebula-set-observer-key.sh`.
- Current people (2026-09-10): operators `xenosnikos, TwizzyNicky, igormoly`; read-only
  additionally `bright-nik, algoniko, rohitagrohia`.
