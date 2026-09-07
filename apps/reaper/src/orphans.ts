export const PREVIEW_LABEL = "twizz-idp/preview";
export const DEFAULT_GRACE_MINUTES = 10;

export type NamespaceInfo = { name: string; labels: Record<string, string>; createdAt: Date | undefined };
export type ArgoAppInfo = { name: string; labels: Record<string, string> };

export type OrphanDecision = { namespace: string; action: "delete" | "keep"; reason: string };

/** Conservative orphan detection for preview namespaces Argo CD created but
 * will never delete. Deletes ONLY when: the namespace carries
 * `twizz-idp/preview=true`, is older than the grace period, matches a known
 * shape, and its owning Application is gone. Everything else is kept with a
 * reason. */
export function decideOrphan(
  ns: NamespaceInfo,
  apps: ArgoAppInfo[],
  now: Date,
  graceMinutes = DEFAULT_GRACE_MINUTES,
): OrphanDecision {
  const keep = (reason: string): OrphanDecision => ({ namespace: ns.name, action: "keep", reason });

  if (ns.labels[PREVIEW_LABEL] !== "true") return keep(`no ${PREVIEW_LABEL}=true label`);

  if (!ns.createdAt) return keep("unknown creation time");
  const ageMin = (now.getTime() - ns.createdAt.getTime()) / 60_000;
  if (ageMin < graceMinutes) return keep(`only ${ageMin.toFixed(1)} min old (grace ${graceMinutes} min)`);

  if (ns.name.startsWith("env-")) {
    const owner = apps.find((a) => a.name === ns.name);
    return owner ? keep(`Application ${owner.name} exists`) : { namespace: ns.name, action: "delete", reason: `no Application ${ns.name}` };
  }

  const pr = ns.name.match(/^pr-(.+)-(\d+)$/);
  if (pr) {
    const [, repo, number] = pr;
    const owner = apps.find(
      (a) => a.labels["twizz-idp/pr"] === number && (a.labels["twizz-idp/repo"] === undefined || a.labels["twizz-idp/repo"] === repo),
    );
    return owner
      ? keep(`Application ${owner.name} (pr ${number}) exists`)
      : { namespace: ns.name, action: "delete", reason: `no Application with twizz-idp/pr=${number} for ${repo}` };
  }

  return keep("not an env-* or pr-* namespace");
}

export function decideOrphans(namespaces: NamespaceInfo[], apps: ArgoAppInfo[], now: Date, graceMinutes?: number): OrphanDecision[] {
  return namespaces.map((ns) => decideOrphan(ns, apps, now, graceMinutes));
}
