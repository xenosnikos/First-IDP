import { GithubGitops, REGISTRY, listNamedEnvs, type NamedEnvManifest } from "@twizz-idp/actions";
import { GitHubService } from "@twizz-idp/core";
import { router, protectedProcedure } from "../trpc";
import { argoWord, ttlWord } from "@/lib/nebula/status";
import { octokit } from "../nebula/deps";
import { readClusterSnapshot } from "../nebula/kube";
import { buildAppViews, buildProjectViews, type RepoFact } from "../nebula/classify";

// Read side of the N3 pages (docs/NEBULA.md §N3.4). Everything here is a
// query; NAMED-env writes stay in `actions`.

const GITHUB_ORG = process.env.GITHUB_ORG ?? "twizz-app";

function namedView(m: NamedEnvManifest, live: ReturnType<typeof buildAppViews>[number] | undefined, reachable: boolean, now: Date) {
  const appName = `env-${m.name}`;
  const status = !reachable ? { sync: null, health: null, unreachable: true as const } : live ? { sync: live.sync, health: live.health } : { sync: null, health: null };
  const entry = REGISTRY.find((s) => s.name === m.service);
  return {
    ...m,
    url: `https://${m.name}.prv.twizz.com`,
    argoApp: appName,
    namespace: appName,
    dbName: `nebula_${m.name}`,
    secret: `${entry?.sourceSecret ?? "preview/" + m.service}/${m.name}`,
    argo: { ...status, ...argoWord(status) },
    ttl: ttlWord(m.expiresAt, now),
    hosts: live?.hosts ?? [],
    images: live?.images ?? [],
  };
}

export const nebulaRouter = router({
  /** Environments = what is running on non-prod: every Argo Application
   * (minus root/nebula) with its origin word; NAMED ones carry the manifest. */
  listEnvironments: protectedProcedure.query(async () => {
    const now = new Date();
    const [manifests, snap] = await Promise.all([
      listNamedEnvs({ gitops: new GithubGitops(octokit()) }).catch((e) => ({ error: String((e as Error).message ?? e) })),
      readClusterSnapshot(),
    ]);
    const views = buildAppViews(snap.apps, snap.ingresses, snap.deployments, snap.appsets);
    const named = Array.isArray(manifests) ? manifests : [];
    const namedByApp = new Map(named.map((m) => [`env-${m.name}`, m]));
    return {
      cluster: { name: "EKS-Twizz-NonProd", reachable: snap.reachable, reason: snap.reason },
      gitopsError: Array.isArray(manifests) ? undefined : manifests.error,
      named: named.map((m) => namedView(m, views.find((v) => v.name === `env-${m.name}`), snap.reachable, now)),
      // live NAMED apps whose manifest is gone (being pruned) still show, read-only
      others: views.filter((v) => !(v.origin === "NAMED" && namedByApp.has(v.name))).map((v) => ({ ...v, ...argoWord({ sync: v.sync, health: v.health }) })),
    };
  }),

  /** Projects = repos & what the platform knows about them. */
  listProjects: protectedProcedure.query(async ({ ctx }) => {
    const token = (ctx.session as { accessToken?: string }).accessToken ?? process.env.GITHUB_TOKEN;
    let orgRepos: RepoFact[] = [];
    let orgError: string | undefined;
    try {
      if (!token) throw new Error("no GitHub token on the session or the server");
      const repos = await new GitHubService(token).listOrgRepos(GITHUB_ORG);
      orgRepos = repos.map((r) => ({ slug: r.fullName, name: r.name, private: r.private, language: r.language, defaultBranch: r.defaultBranch, updatedAt: r.updatedAt, url: r.url }));
    } catch (e) {
      orgError = String((e as Error).message ?? e);
    }
    const [snap, registered] = await Promise.all([readClusterSnapshot(), ctx.prisma.project.findMany({ select: { id: true, githubRepoUrl: true } })]);
    const apps = buildAppViews(snap.apps, snap.ingresses, snap.deployments, snap.appsets);
    return {
      org: GITHUB_ORG,
      orgError,
      cluster: { reachable: snap.reachable, reason: snap.reason },
      projects: buildProjectViews(orgRepos, apps, snap.appsets, registered, GITHUB_ORG),
      registry: REGISTRY.map((s) => ({ name: s.name, kind: s.kind, status: s.status, repo: s.repo })),
    };
  }),
});
