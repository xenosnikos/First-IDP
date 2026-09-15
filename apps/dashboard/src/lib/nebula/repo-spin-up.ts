// Pure helpers for the "spin up from a repo" drawer. Client-safe (no yaml
// dependency here — the drawer parses YAML itself and hands objects in).
import { parseTwizzObject, type TwizzYamlV2 } from "@twizz-idp/shared";

export const ENV_NAME_RE = /^[a-z][a-z0-9-]{2,23}$/;
export const BRANCH_RE = /^(?!\/)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]{1,120}(?<!\/)(?<!\.lock)$/;
export const TTL = { min: 1, max: 336, default: 168 } as const;
/** Mirrors policy.yaml: names the gate would refuse, shown BEFORE the gate. */
export const DENIED_NAME_RE = /prod|staging|^(shared|dev|nebula|argocd)$/i;
export const DENIED_BRANCH_RE = /prod|staging|^(main|master)$/i;

/** `<repo>-<branch>` squeezed into a DNS label ≤ 24 chars, letter-first. */
export function slugEnvName(repo: string, branch: string): string {
  const clean = (s: string) => s.toLowerCase().replace(/^twizz-/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const r = clean(repo.split("/").pop() ?? repo);
  const b = clean(branch.replace(/^(feature|feat|fix|bugfix|hotfix|release|nebula)\//, ""));
  let out = b && b !== r ? `${r}-${b}` : r;
  out = out.replace(/-+/g, "-").replace(/^[^a-z]+/, "");
  if (out.length > 24) out = out.slice(0, 24).replace(/-+$/, "");
  while (out.length < 3) out += "x";
  return out;
}

export function isValidBranchName(name: string): boolean {
  return BRANCH_RE.test(name);
}

export type ProposalLike = { twizzYaml: TwizzYamlV2; dockerfile?: { path: string; content: string; reason: string } };

/** The files the gate commits: twizz.yaml text (as edited) + the proposed
 * Dockerfile when the human kept it. */
export function proposalToFiles(twizzYamlText: string, proposal: ProposalLike | null, useDockerfile: boolean): Array<{ path: string; content: string }> {
  const files = [{ path: "twizz.yaml", content: twizzYamlText }];
  if (useDockerfile && proposal?.dockerfile) files.push({ path: proposal.dockerfile.path, content: proposal.dockerfile.content });
  return files;
}

export type ParsedYamlObject = { ok: true; value: unknown } | { ok: false; error: string };

/** Validate an already-parsed YAML object as twizz.yaml v2 (live, in the browser). */
export function validateTwizzObject(parsed: ParsedYamlObject): { ok: true; config: TwizzYamlV2; legacy: boolean } | { ok: false; issues: string[] } {
  if (!parsed.ok) return { ok: false, issues: [`YAML: ${parsed.error}`] };
  return parseTwizzObject(parsed.value);
}

/** What the builder will bake into the image, with placeholders resolved. */
export function buildArgPreview(config: TwizzYamlV2 | null, o: { envName: string; attachUrl?: string }): Array<{ key: string; value: string }> {
  if (!config) return [];
  const envUrl = `https://${o.envName || "<name>"}.prv.twizz.com`;
  const api = o.attachUrl ?? "<attach a backend>";
  return Object.entries(config.build.args).map(([key, value]) => ({
    key,
    value: value.replace(/\$\{NEBULA_API_URL\}/g, api).replace(/\$\{NEBULA_SOCKET_URL\}/g, api).replace(/\$\{NEBULA_ENV_URL\}/g, envUrl),
  }));
}

export type SpinUpState = {
  repo: string | null;
  branchMode: "existing" | "new";
  branch: string;
  newBranchFrom: string;
  headSha: string | null;
  envName: string;
  ttlHours: number;
  config: TwizzYamlV2 | null;
  configIssues: string[];
  attach: { env: string } | { url: string } | null;
  db: "isolated" | "clone" | "none";
};

/** Everything that blocks "Review with the gate", in the order the drawer shows it. */
export function problemsFor(s: SpinUpState): string[] {
  const p: string[] = [];
  if (!s.repo) p.push("pick a repository");
  if (s.branchMode === "existing" && !s.branch) p.push("pick a branch");
  if (s.branchMode === "new") {
    if (!s.branch) p.push("name the new branch");
    else if (!isValidBranchName(s.branch)) p.push("new branch name is not a valid git ref");
    else if (DENIED_BRANCH_RE.test(s.branch)) p.push(`DENIED: branch "${s.branch}" would be refused by policy (main/master/*prod*/*staging*)`);
    if (!s.newBranchFrom) p.push("pick the branch to create it from");
    if (s.branch && s.branch === s.newBranchFrom) p.push("the new branch needs a different name from its base");
  }
  if (!s.headSha) p.push("waiting for the branch head");
  if (!s.config) p.push(s.configIssues.length ? `twizz.yaml has ${s.configIssues.length} issue${s.configIssues.length === 1 ? "" : "s"}` : "configure the repo (let Nebula configure it, or by hand)");
  if (!s.envName) p.push("name the environment");
  else if (!ENV_NAME_RE.test(s.envName)) p.push("env name must match ^[a-z][a-z0-9-]{2,23}$ (it becomes <name>.prv.twizz.com)");
  else if (DENIED_NAME_RE.test(s.envName)) p.push(`DENIED: env name "${s.envName}" would be refused by policy (*prod*, *staging*, shared, dev, nebula, argocd)`);
  if (s.repo && /prod/i.test(s.repo)) p.push(`DENIED: repo "${s.repo}" matches the global *prod* deny`);
  if (s.branchMode === "existing" && s.branch && /prod|staging/i.test(s.branch)) p.push(`DENIED: branch "${s.branch}" matches the *prod*/*staging* deny`);
  if (!Number.isInteger(s.ttlHours) || s.ttlHours < TTL.min || s.ttlHours > TTL.max) p.push(`TTL must be ${TTL.min}..${TTL.max} hours`);
  if (s.config?.kind === "frontend" && !s.attach) p.push("frontends must attach to a backend env (or an API URL)");
  if (s.db === "clone" && s.config && !/moly/i.test(s.repo ?? "")) p.push("clone staging is only available for moly-backend");
  return p;
}
