// Pure classification for the Environments and Projects pages (docs/NEBULA.md
// §N3.4). No I/O: takes what kube.ts read and what listNamedEnvs parsed.
import { REGISTRY, repoSlug, serviceForApp, type ServiceEntry } from "@twizz-idp/actions";
import type { StatusWord } from "@/lib/nebula/status";

export type LiveApp = {
  name: string;
  namespace: string;
  project: string;
  labels: Record<string, string>;
  /** kind of the owner (ApplicationSet for generated apps) */
  ownerKind?: string;
  ownerName?: string;
  sourceRepoUrls: string[];
  sync: string;
  health: string;
};
export type LiveIngress = { namespace: string; name: string; hosts: string[] };
export type LiveDeployment = { namespace: string; name: string; images: string[]; ready: number; desired: number };
export type LiveAppSet = { name: string; prRepo?: string; prOwner?: string };

export type Origin = Extract<StatusWord, "NAMED" | "PR PREVIEW" | "GITOPS APP">;

/** Applications that are platform plumbing, never "environments": the
 * app-of-apps root, Nebula itself, and the `shared-*` singletons (Moly
 * sibling services in namespace `shared` that preview pods talk to via
 * ExternalName). Nebula is confined to what lives in the GitHub org; the
 * shared singletons are infrastructure it does not show. */
export const HIDDEN_APPS = new Set(["root", "nebula"]);
export function isPlatformApp(app: { name: string; namespace: string }): boolean {
  return HIDDEN_APPS.has(app.name) || app.name.startsWith("shared-") || app.namespace === "shared";
}

export function classifyApp(app: LiveApp): Origin {
  if (app.labels["twizz-idp/named-env"] === "true" || app.name.startsWith("env-")) return "NAMED";
  if (app.labels["twizz-idp/pr"] || app.ownerKind === "ApplicationSet") return "PR PREVIEW";
  return "GITOPS APP";
}

/** GitHub PR link for a PR-generator app, from the labels the appsets stamp. */
export function prLink(app: LiveApp, appsets: LiveAppSet[] = []): { repo: string; number: string; url: string } | undefined {
  const number = app.labels["twizz-idp/pr"];
  if (!number) return undefined;
  const repoLabel = app.labels["twizz-idp/repo"];
  const entry = REGISTRY.find((s) => s.detect.repo === repoLabel);
  const set = appsets.find((a) => a.name === app.ownerName);
  const slug = set?.prRepo && set.prOwner ? `${set.prOwner}/${set.prRepo}` : entry?.repo ?? (repoLabel ? `twizz-app/${repoLabel}` : undefined);
  if (!slug) return undefined;
  return { repo: slug, number, url: `https://github.com/${slug}/pull/${number}` };
}

export type AppView = {
  name: string;
  origin: Origin;
  namespace: string;
  project: string;
  sync: string;
  health: string;
  hosts: string[];
  images: string[];
  service?: string;
  pr?: { repo: string; number: string; url: string };
  sourceRepos: string[];
};

export function buildAppViews(apps: LiveApp[], ingresses: LiveIngress[], deployments: LiveDeployment[], appsets: LiveAppSet[]): AppView[] {
  return apps
    .filter((a) => !isPlatformApp(a))
    .map((a) => ({
      name: a.name,
      origin: classifyApp(a),
      namespace: a.namespace,
      project: a.project,
      sync: a.sync,
      health: a.health,
      hosts: ingresses.filter((i) => i.namespace === a.namespace).flatMap((i) => i.hosts),
      images: [...new Set(deployments.filter((d) => d.namespace === a.namespace).flatMap((d) => d.images))],
      service: serviceForApp(a.labels, a.sourceRepoUrls)?.name,
      pr: prLink(a, appsets),
      sourceRepos: a.sourceRepoUrls.map(repoSlug).filter((x): x is string => !!x),
    }))
    .sort((x, y) => x.origin.localeCompare(y.origin) || x.name.localeCompare(y.name));
}

// ── Projects ──────────────────────────────────────────────────────────

export type RepoFact = { slug: string; name: string; private?: boolean; language?: string | null; defaultBranch?: string; updatedAt?: string; url: string };
export type ProjectView = RepoFact & {
  words: Extract<StatusWord, "DEPLOYED" | "PREVIEWABLE" | "REGISTERED" | "UNONBOARDED">[];
  apps: string[];
  registry?: Pick<ServiceEntry, "name" | "kind" | "status">;
  registeredId?: string;
};

/** Repos the platform is watching are the gitops repo itself — infra, not a project. */
export const INFRA_REPOS = new Set(["twizzynicky/twizz-gitops"]);

/** Projects = the GitHub org, plus repos Nebula demos before they move in.
 * twizz-support lives under xenosnikos/ "while the concept is proven"
 * (twizz-gitops bootstrap/twizz-support-repo-externalsecret.yaml). */
export const PROJECT_EXCEPTIONS = new Set(["xenosnikos/twizz-support"]);

export function isProjectRepo(slug: string, org: string): boolean {
  const k = slug.toLowerCase();
  return k.startsWith(`${org.toLowerCase()}/`) || PROJECT_EXCEPTIONS.has(k);
}

/** Union of org repos ∪ repos referenced by Applications ∪ registered rows,
 * with one word per fact. Deployed = an Application maps to the repo (by
 * registry label or by source URL); previewable = a PR-generator appset. */
export function buildProjectViews(
  orgRepos: RepoFact[],
  apps: AppView[],
  appsets: LiveAppSet[],
  registered: Array<{ id: string; githubRepoUrl: string }>,
  org = "twizz-app",
): ProjectView[] {
  const byKey = new Map<string, ProjectView>();
  const key = (slug: string) => slug.toLowerCase();
  const ensure = (slug: string, fact?: Partial<RepoFact>): ProjectView => {
    const k = key(slug);
    let v = byKey.get(k);
    if (!v) {
      v = { slug, name: slug.split("/")[1] ?? slug, url: `https://github.com/${slug}`, ...fact, words: [], apps: [] };
      byKey.set(k, v);
    } else if (fact) Object.assign(v, fact);
    return v;
  };

  for (const r of orgRepos) ensure(r.slug, r);

  for (const a of apps) {
    const entry = a.service ? REGISTRY.find((s) => s.name === a.service) : undefined;
    const slugs = entry ? [entry.repo] : a.sourceRepos.filter((s) => !INFRA_REPOS.has(key(s)));
    for (const slug of slugs) {
      const v = ensure(slug);
      v.apps.push(a.name);
      if (!v.words.includes("DEPLOYED")) v.words.push("DEPLOYED");
      if (entry) v.registry = { name: entry.name, kind: entry.kind, status: entry.status };
    }
  }

  for (const set of appsets) {
    if (!set.prRepo || !set.prOwner) continue;
    const v = ensure(`${set.prOwner}/${set.prRepo}`);
    if (!v.words.includes("PREVIEWABLE")) v.words.push("PREVIEWABLE");
  }

  for (const row of registered) {
    const slug = repoSlug(row.githubRepoUrl);
    if (!slug) continue;
    const v = ensure(slug);
    v.registeredId = row.id;
    if (!v.words.includes("REGISTERED")) v.words.push("REGISTERED");
  }

  for (const v of byKey.values()) {
    const entry = REGISTRY.find((s) => key(s.repo) === key(v.slug));
    if (entry && !v.registry) v.registry = { name: entry.name, kind: entry.kind, status: entry.status };
    if (v.words.length === 0) v.words.push("UNONBOARDED");
  }

  return [...byKey.values()].filter((v) => isProjectRepo(v.slug, org)).sort((x, y) => {
    const rank = (p: ProjectView) => (p.words.includes("DEPLOYED") ? 0 : p.words.includes("PREVIEWABLE") ? 1 : p.words.includes("REGISTERED") ? 2 : 3);
    return rank(x) - rank(y) || x.name.localeCompare(y.name);
  });
}
