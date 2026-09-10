// The service registry (docs/NEBULA.md §N3.2). TypeScript on purpose: it is
// consumed at build time by the Zod/policy enums, the MCP tool schemas and the
// wizard, and every entry is unit-tested. Chart values live in twizz-gitops;
// entries only point at them. Nothing a caller types is ever used as a secret
// name or ECR repo — those are DERIVED from `service` through this table.

export type ServiceKind = "backend" | "frontend";
export type ServiceStatus = "SHIPPED" | "PLANNED";
export type Framework = "cra" | "vite" | "next";

export type ServiceEntry = {
  name: string;
  kind: ServiceKind;
  /** GitHub source repo (owner/name) — Projects page, PR-appset matching. */
  repo: string;
  /** ECR repository holding the deployable images. */
  ecrRepo: string;
  /** Backend only: the shared preview blob copied per env (never a frontend). */
  sourceSecret?: string;
  /** Per-env Helm values in twizz-gitops. */
  valuesFile: string;
  /** SHIPPED entries can be provisioned; PLANNED are shown honestly, never offered. */
  status: ServiceStatus;
  /** Frontend only (chunk 3): how a build-on-provision works for this repo. */
  build?: {
    workflow: string;
    framework: Framework;
    apiEnvVar: string;
    socketEnvVar?: string;
    serve: "static" | "next-standalone" | "node-server";
    notes?: string;
  };
  /** How live Argo Applications map back to this entry (label values). */
  detect: { service?: string; repo?: string };
};

const GITOPS_VALUES = (name: string) => `apps/${name}/values.yaml`;

export const REGISTRY: readonly ServiceEntry[] = [
  {
    name: "moly-backend",
    kind: "backend",
    repo: "twizz-app/Moly-backend",
    ecrRepo: "molybackend",
    sourceSecret: "preview/moly-backend",
    valuesFile: GITOPS_VALUES("moly-backend"),
    status: "SHIPPED",
    detect: { service: "moly-backend", repo: "moly-backend" },
  },
  // ── Demo services shown in Nebula before/while their repos live in the org.
  // PLANNED: visible on Projects/Environments with a kind, never offered by
  // the spin-up wizard (PROVISIONABLE stays moly-backend only).
  {
    name: "twizz-sentinel",
    kind: "backend",
    repo: "twizz-app/twizz-sentinel",
    ecrRepo: "twizz-sentinel",
    sourceSecret: "preview/twizz-sentinel",
    valuesFile: GITOPS_VALUES("twizz-sentinel"),
    status: "PLANNED",
    detect: { service: "twizz-sentinel", repo: "twizz-sentinel" },
  },
  {
    // External to the org "while the concept is proven" (twizz-gitops
    // bootstrap/twizz-support-repo-externalsecret.yaml); move to twizz-app later.
    name: "twizz-support",
    kind: "backend",
    repo: "xenosnikos/twizz-support",
    ecrRepo: "twizz-support",
    sourceSecret: "preview/twizz-support",
    valuesFile: GITOPS_VALUES("twizz-support"),
    status: "PLANNED",
    detect: { service: "twizz-support", repo: "twizz-support" },
  },
  // ── Frontends: verified via the GitHub API 2026-09-09 (docs/NEBULA.md §N3.3).
  // PLANNED until chunk 3 (build-on-provision) lands; listed so the wizard
  // and the Projects page can say so honestly instead of hiding them.
  {
    name: "frontend",
    kind: "frontend",
    repo: "twizz-app/frontend",
    ecrRepo: "twizz-frontend",
    valuesFile: GITOPS_VALUES("frontend"),
    status: "PLANNED",
    build: { workflow: "nebula-build.yml", framework: "cra", apiEnvVar: "REACT_APP_API_ENDPOINT", socketEnvVar: "REACT_APP_SOCKET_ENDPOINT", serve: "static", notes: "CRA 5 + craco" },
    detect: { service: "frontend", repo: "frontend" },
  },
  {
    name: "business",
    kind: "frontend",
    repo: "twizz-app/business",
    ecrRepo: "twizz-business",
    valuesFile: GITOPS_VALUES("business"),
    status: "PLANNED",
    build: { workflow: "nebula-build.yml", framework: "vite", apiEnvVar: "VITE_BACKEND_URL", serve: "static", notes: "Vite 6 + React 19" },
    detect: { service: "business", repo: "business" },
  },
  {
    name: "moly-admin",
    kind: "frontend",
    repo: "twizz-app/moly_admin",
    ecrRepo: "moly-admin",
    valuesFile: GITOPS_VALUES("moly-admin"),
    status: "PLANNED",
    build: { workflow: "nebula-build.yml", framework: "next", apiEnvVar: "NEXT_PUBLIC_API_ENDPOINT", serve: "node-server", notes: "Next 9.4.4 + custom server; server-side API_ENDPOINT too; no standalone output on Next 9" },
    detect: { service: "moly-admin", repo: "moly_admin" },
  },
  {
    name: "twizz-admin",
    kind: "frontend",
    repo: "twizz-app/twizz-admin",
    ecrRepo: "twizz-admin",
    valuesFile: GITOPS_VALUES("twizz-admin"),
    status: "PLANNED",
    build: { workflow: "nebula-build.yml", framework: "next", apiEnvVar: "NEXT_PUBLIC_API_URL", serve: "next-standalone", notes: "Next 15; already previewed per PR by the joint appset" },
    detect: { service: "twizz-admin", repo: "twizz-admin" },
  },
];

export function getService(name: string): ServiceEntry | undefined {
  return REGISTRY.find((s) => s.name === name);
}

/** Entries that can be provisioned today (SHIPPED backends, in Phase 0). */
export const PROVISIONABLE: readonly ServiceEntry[] = REGISTRY.filter((s) => s.status === "SHIPPED" && s.kind === "backend");

/** Find the registry entry a live Argo Application belongs to, from the
 * labels the ApplicationSets stamp (`twizz-idp/service`, `twizz-idp/repo`)
 * or, failing that, a source repo URL. */
export function serviceForApp(labels: Record<string, string>, sourceRepoUrls: string[] = []): ServiceEntry | undefined {
  const svc = labels["twizz-idp/service"];
  const repo = labels["twizz-idp/repo"];
  const byLabel = REGISTRY.find((s) => (svc && s.detect.service === svc) || (repo && s.detect.repo === repo));
  if (byLabel) return byLabel;
  const names = sourceRepoUrls.map(repoSlug).filter((x): x is string => !!x);
  return REGISTRY.find((s) => names.some((n) => n.toLowerCase() === s.repo.toLowerCase()));
}

/** `https://github.com/o/r(.git)` or `git@github.com:o/r.git` → `o/r`. */
export function repoSlug(url: string): string | undefined {
  const m = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : undefined;
}
