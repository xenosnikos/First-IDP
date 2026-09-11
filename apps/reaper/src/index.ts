#!/usr/bin/env tsx
// Nebula reaper: tear down expired named envs, delete orphaned preview
// namespaces. Non-interactive (no confirm nonce) but every action is audited.
// See CLAUDE.md. Exit 1 on unexpected (phase-level) errors; per-item failures
// are logged and do not abort the run.
import { join } from "node:path";
import { homedir } from "node:os";
import { Octokit } from "@octokit/rest";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { GithubGitops, SecretsManagerStore, createAudit, listNamedEnvs, teardownNamedEnv } from "@twizz-idp/actions";
import { selectExpired } from "./expiry";
import { decideOrphans, DEFAULT_GRACE_MINUTES } from "./orphans";
import { realKubeClient, type KubeClient } from "./kube";

const DRY_RUN = /^(1|true|yes)$/i.test(process.env.REAPER_DRY_RUN ?? "");
const ACTOR = "reaper";
const GRACE_MINUTES = Number(process.env.REAPER_GRACE_MINUTES) || DEFAULT_GRACE_MINUTES;

function log(line: string) {
  console.log(`[reaper]${DRY_RUN ? "[dry-run]" : ""} ${line}`);
}

let prismaPromise: Promise<any> | undefined;
const audit = createAudit({
  actor: ACTOR,
  fallbackPath: process.env.REAPER_AUDIT_FILE ?? join(homedir(), ".twizz-reaper-audit.jsonl"),
  getAuditLog: async () => {
    if (!process.env.DATABASE_URL) return undefined;
    prismaPromise ??= import("@twizz-idp/db").then((m) => m.prisma);
    return (await prismaPromise).auditLog;
  },
});

/** Phase 1: expired named envs → teardownNamedEnv (manifest + secret). */
export async function reapExpired(deps: { gitops: GithubGitops; secrets: SecretsManagerStore }, now: Date) {
  const { envs, pending, broken } = await listNamedEnvs(deps);
  for (const b of broken) log(`broken manifest ${b.path}: ${b.error} (kept)`);
  const decisions = selectExpired(envs, now, pending);
  let failures = 0;
  for (const d of decisions) {
    if (d.action === "keep") {
      log(`env ${d.name}: keep (${d.reason})`);
      continue;
    }
    log(`env ${d.name}: EXPIRED ${d.expiresAt} (${d.overdueHours}h overdue) → teardown`);
    if (DRY_RUN) continue;
    try {
      const res = await teardownNamedEnv(deps, { name: d.name, actor: ACTOR });
      await audit({ action: "reaper.teardown_named_env", resource: d.name, allowed: true, detail: { expiresAt: d.expiresAt, ...res } });
      log(`env ${d.name}: torn down (secretDeleted=${res.secretDeleted})`);
    } catch (e) {
      failures++;
      await audit({ action: "reaper.teardown_named_env", resource: d.name, allowed: true, detail: { expiresAt: d.expiresAt, error: String(e) } });
      log(`env ${d.name}: teardown FAILED: ${String(e)}`);
    }
  }
  return { total: envs.length + pending.length, expired: decisions.filter((d) => d.action === "teardown").length, failures };
}

/** Phase 2: preview namespaces whose Argo Application is gone. */
export async function reapOrphans(kube: KubeClient, now: Date) {
  const [namespaces, apps] = await Promise.all([kube.listPreviewNamespaces(), kube.listArgoApplications()]);
  const decisions = decideOrphans(namespaces, apps, now, GRACE_MINUTES);
  let failures = 0;
  for (const d of decisions) {
    if (d.action === "keep") {
      log(`namespace ${d.namespace}: keep (${d.reason})`);
      continue;
    }
    log(`namespace ${d.namespace}: ORPHAN (${d.reason}) → delete`);
    if (DRY_RUN) continue;
    try {
      await kube.deleteNamespace(d.namespace);
      await audit({ action: "reaper.delete_namespace", resource: d.namespace, allowed: true, detail: { reason: d.reason } });
      log(`namespace ${d.namespace}: deleted`);
    } catch (e) {
      failures++;
      await audit({ action: "reaper.delete_namespace", resource: d.namespace, allowed: true, detail: { reason: d.reason, error: String(e) } });
      log(`namespace ${d.namespace}: delete FAILED: ${String(e)}`);
    }
  }
  return { namespaces: namespaces.length, orphans: decisions.filter((d) => d.action === "delete").length, failures };
}

async function main() {
  const now = new Date();
  log(`start ${now.toISOString()} grace=${GRACE_MINUTES}min`);
  const fatal: string[] = [];

  try {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error("GITHUB_TOKEN not set");
    const deps = {
      gitops: new GithubGitops(new Octokit({ auth: token })),
      secrets: new SecretsManagerStore(new SecretsManagerClient({ region: process.env.AWS_REGION ?? "eu-west-1" })),
    };
    const r = await reapExpired(deps, now);
    log(`expired envs: ${r.expired}/${r.total} torn down, ${r.failures} failed`);
  } catch (e) {
    fatal.push(`expired-envs phase: ${String(e)}`);
    log(`expired-envs phase FAILED: ${String(e)}`);
  }

  try {
    const r = await reapOrphans(realKubeClient(), now);
    log(`orphan namespaces: ${r.orphans}/${r.namespaces} deleted, ${r.failures} failed`);
  } catch (e) {
    fatal.push(`orphan-namespaces phase: ${String(e)}`);
    log(`orphan-namespaces phase FAILED: ${String(e)}`);
  }

  if (fatal.length) {
    console.error(`[reaper] ${fatal.length} phase(s) failed:\n  ${fatal.join("\n  ")}`);
    process.exit(1);
  }
  log("done");
}

// Only run when executed directly (tests import the phase functions).
if (process.argv[1] && /reaper\/src\/index\.ts$|\/index\.(m?js|ts)$/.test(process.argv[1]) && !process.env.VITEST) {
  main().catch((e) => {
    console.error("[reaper] fatal:", e);
    process.exit(1);
  });
}
