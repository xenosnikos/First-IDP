// build-watcher: a 1-minute CronJob sibling of the reaper. For every
// named-envs/pending/<name>.yaml: find/inspect the builder run, and on
// success move the manifest to named-envs/<name>.yaml with imageTag in ONE
// commit (Argo then deploys). Failures are recorded in place with the run
// link; expiry is shortened to 24 h so the evidence survives a day.
import { homedir } from "node:os";
import { join } from "node:path";
import { Octokit } from "@octokit/rest";
import { ECRClient } from "@aws-sdk/client-ecr";
import { EcrRegistry, GithubBuilds, GithubGitops, createAudit, listNamedEnvs, manifestPath, manifestToYaml, type BuildDispatcher, type FileChange, type GitopsRepo, type ImageRegistry, type NamedEnvManifest } from "@twizz-idp/actions";
import { decideBuild } from "./builds";

const ACTOR = "reaper:build-watcher";
const log = (msg: string) => console.log(`[build-watcher] ${msg}`);

let prismaPromise: Promise<{ auditLog: unknown }> | undefined;
const audit = createAudit({
  actor: ACTOR,
  fallbackPath: process.env.REAPER_AUDIT_FILE ?? join(homedir(), ".twizz-reaper-audit.jsonl"),
  getAuditLog: async () => {
    if (!process.env.DATABASE_URL) return undefined;
    prismaPromise ??= import("@twizz-idp/db").then((m) => m.prisma);
    return (await prismaPromise).auditLog as never;
  },
});

export type WatchDeps = { gitops: GitopsRepo; builds: BuildDispatcher; images: ImageRegistry; now?: () => Date };

export async function watchBuilds(deps: WatchDeps) {
  const now = (deps.now ?? (() => new Date()))();
  const { pending, broken } = await listNamedEnvs(deps);
  for (const b of broken) log(`broken manifest ${b.path}: ${b.error}`);
  const stats = { pending: pending.length, promoted: 0, failed: 0, attached: 0, waiting: 0 };
  for (const m of pending) {
    try {
      const b = m.build;
      let run = null;
      if (b?.runId != null) run = await deps.builds.getRun(b.runId).catch(() => null);
      else if (b) run = await deps.builds.findRun({ displayTitle: deps.builds.displayTitle({ envName: m.name, service: m.service, sha: m.source?.sha ?? "" }), createdAfter: new Date(Date.parse(b.startedAt) - 60_000) });
      const imageExists = b && run?.status === "completed" && run.conclusion === "success" ? !!(await deps.images.describeTag(m.service, b.expectedTag)) : false;
      const d = decideBuild(m, run, imageExists, now);
      const pendingPath = manifestPath(m.name, true);
      switch (d.action) {
        case "wait":
          stats.waiting++;
          log(`${m.name}: wait (${d.reason})`);
          break;
        case "attach-run": {
          stats.attached++;
          const next: NamedEnvManifest = { ...m, build: { ...m.build!, status: "RUNNING", runId: d.runId, runUrl: d.runUrl } };
          await deps.gitops.commit([{ path: pendingPath, content: manifestToYaml(next) }], `nebula: build ${m.name} running (run ${d.runId})`);
          log(`${m.name}: attached run ${d.runId}`);
          break;
        }
        case "promote": {
          stats.promoted++;
          const finishedAt = now.toISOString();
          const next: NamedEnvManifest = { ...m, imageTag: d.imageTag, build: { ...m.build!, status: "PASS", finishedAt, runUrl: d.runUrl ?? m.build?.runUrl } };
          const changes: FileChange[] = [{ path: pendingPath, content: null }, { path: manifestPath(m.name), content: manifestToYaml(next) }];
          await deps.gitops.commit(changes, `nebula: promote ${m.name} → ${d.imageTag} (${ACTOR})`);
          await audit({ action: "reaper.build_promote", resource: m.name, allowed: true, detail: { imageTag: d.imageTag, runUrl: d.runUrl, source: m.source } });
          log(`${m.name}: PROMOTED ${d.imageTag}`);
          break;
        }
        case "fail": {
          stats.failed++;
          const dayLater = new Date(now.getTime() + 24 * 3_600_000).toISOString();
          const expiresAt = Date.parse(m.expiresAt) < Date.parse(dayLater) ? m.expiresAt : dayLater;
          const next: NamedEnvManifest = { ...m, expiresAt, build: { ...m.build!, status: "FAIL", finishedAt: now.toISOString(), reason: d.reason, ...(d.runUrl ? { runUrl: d.runUrl } : {}) } };
          await deps.gitops.commit([{ path: pendingPath, content: manifestToYaml(next) }], `nebula: build ${m.name} FAILED (${d.reason})`);
          await audit({ action: "reaper.build_fail", resource: m.name, allowed: true, detail: { reason: d.reason, runUrl: d.runUrl, source: m.source } });
          log(`${m.name}: FAIL (${d.reason})`);
          break;
        }
        case "retry-delete": {
          const deployable = await deps.gitops.getFile(manifestPath(m.name));
          if (deployable) {
            await deps.gitops.commit([{ path: pendingPath, content: null }], `nebula: drop stale pending copy of ${m.name}`);
            log(`${m.name}: dropped stale pending copy`);
          } else log(`${m.name}: PASS in pending but no deployable file — leaving for a human`);
          break;
        }
      }
    } catch (e) {
      log(`${m.name}: watcher error: ${String((e as Error).message ?? e)}`);
    }
  }
  return stats;
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN not set");
  const gh = new Octokit({ auth: token });
  const region = process.env.AWS_REGION ?? "eu-west-1";
  const stats = await watchBuilds({ gitops: new GithubGitops(gh), builds: new GithubBuilds(gh), images: new EcrRegistry(new ECRClient({ region })) });
  log(`done: ${JSON.stringify(stats)}`);
}

if (process.argv[1]?.endsWith("watch-builds.ts")) {
  main().catch((e) => {
    log(`FATAL ${String(e)}`);
    process.exit(1);
  });
}
