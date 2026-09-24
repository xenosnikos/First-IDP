import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "../trpc";
import { createProjectSchema, detectProjectSchema, parseTwizzObject } from "@twizz-idp/shared";
import type { GitHubService } from "@twizz-idp/core";
import { withGithub } from "../nebula/github-session";
import { parse as parseYaml } from "yaml";

const GITHUB_ORG = process.env.GITHUB_ORG ?? "twizz-app";
const REPO_NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const BRANCH_RE = /^(?!\/)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]{1,120}(?<!\/)(?<!\.lock)$/;

/** GitHub reads use the SESSION token (the human's own GitHub App grant), so a
 * person only ever configures what they can already see on github.com; when
 * that grant is gone (expired/revoked) the org-scoped platform token steps in
 * (server/nebula/github-session.ts). */
export function githubFor(ctx: { session: unknown }): <T>(fn: (gh: GitHubService) => Promise<T>) => Promise<T> {
  return (fn) => withGithub(ctx.session, (gh) => fn(gh));
}

/** `owner/name` or bare `name` inside the org → { owner, repo }. Refuses
 * anything outside GITHUB_ORG (Nebula is confined to the org). */
export function orgRepo(input: string): { owner: string; repo: string; slug: string } {
  const [a, b] = input.includes("/") ? input.split("/") : [GITHUB_ORG, input];
  if (a.toLowerCase() !== GITHUB_ORG.toLowerCase() || !REPO_NAME_RE.test(b ?? "")) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `repo must be ${GITHUB_ORG}/<name>` });
  }
  return { owner: GITHUB_ORG, repo: b, slug: `${GITHUB_ORG}/${b}` };
}

// Small per-login caches: the repo list is ~1 s of paginated GitHub calls and
// the picker re-renders on every keystroke; twizz.yaml presence changes rarely.
type CacheEntry<T> = { at: number; value: Promise<T> };
const repoCache = new Map<string, CacheEntry<Awaited<ReturnType<GitHubService["listOrgRepos"]>>>>();
const configCache = new Map<string, CacheEntry<TwizzConfigSummary | null>>();
const REPO_TTL = 60_000;
const CONFIG_TTL = 10 * 60_000;

export type TwizzConfigSummary = { kind: "backend" | "frontend" | "worker"; version: 1 | 2; port: number; healthPath: string; hasDockerfile: boolean };

function cached<T>(map: Map<string, CacheEntry<T>>, key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const hit = map.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = load().catch((e) => {
    map.delete(key);
    throw e;
  });
  map.set(key, { at: Date.now(), value });
  return value;
}

async function readTwizzSummary(gh: GitHubService, owner: string, repo: string, ref: string): Promise<TwizzConfigSummary | null> {
  const [text, dockerfile] = await Promise.all([gh.getFileContent(owner, repo, "twizz.yaml", ref), gh.getFileContent(owner, repo, "Dockerfile", ref)]);
  const hasDockerfile = dockerfile !== null;
  if (text === null) return hasDockerfile ? { kind: "backend", version: 2, port: 8080, healthPath: "/health", hasDockerfile } : null;
  let obj: unknown;
  try {
    obj = parseYaml(text);
  } catch {
    return null;
  }
  const parsed = parseTwizzObject(obj);
  if (!parsed.ok) return null;
  return { kind: parsed.config.kind, version: parsed.legacy ? 1 : 2, port: parsed.config.port, healthPath: parsed.config.healthPath, hasDockerfile };
}

export const projectRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    return ctx.prisma.project.findMany({
      orderBy: { updatedAt: "desc" },
      include: { _count: { select: { environments: true } } },
    });
  }),

  /** Every non-archived repo in the org, newest push first; `q` filters by
   * name substring server-side so the picker never ships > 100 rows. */
  listGithubRepos: protectedProcedure.input(z.object({ q: z.string().max(100).optional(), limit: z.number().int().min(1).max(500).default(100) }).optional()).query(async ({ ctx, input }) => {
    const login = ((ctx.session as { login?: string }).login ?? "anon").toLowerCase();
    const gh = githubFor(ctx);
    const repos = await cached(repoCache, login, REPO_TTL, () => gh((g) => g.listOrgRepos(GITHUB_ORG)));
    const q = input?.q?.trim().toLowerCase();
    const list = q ? repos.filter((r) => r.name.toLowerCase().includes(q)) : repos;
    return { org: GITHUB_ORG, total: repos.length, repos: list.slice(0, input?.limit ?? 100) };
  }),

  listBranches: protectedProcedure
    .input(z.object({ repo: z.string().max(200), q: z.string().max(120).optional(), limit: z.number().int().min(1).max(500).default(100) }))
    .query(async ({ ctx, input }) => {
      const { owner, repo } = orgRepo(input.repo);
      return githubFor(ctx)((g) => g.listBranches(owner, repo, { q: input.q, limit: input.limit }));
    }),

  /** The commit a branch points at right now. The spin-up flow pins it and
   * the gate binds the nonce to it, so a push mid-flow is refused honestly. */
  getBranchHead: protectedProcedure
    .input(z.object({ repo: z.string().max(200), branch: z.string().regex(BRANCH_RE) }))
    .query(async ({ ctx, input }) => {
      const { owner, repo } = orgRepo(input.repo);
      try {
        return await githubFor(ctx)((g) => g.getBranchHead(owner, repo, input.branch));
      } catch (e) {
        const status = (e as { status?: number }).status;
        throw new TRPCError({ code: status === 404 ? "NOT_FOUND" : "BAD_GATEWAY", message: status === 404 ? `branch "${input.branch}" not found` : String((e as Error).message ?? e) });
      }
    }),

  /** What the spin-up drawer needs at the pinned commit: the current
   * twizz.yaml text (if any) and whether the Dockerfile it points at exists. */
  repoConfig: protectedProcedure
    .input(z.object({ repo: z.string().max(200), sha: z.string().regex(/^[0-9a-f]{40}$/) }))
    .query(async ({ ctx, input }) => {
      const { owner, repo } = orgRepo(input.repo);
      const gh = githubFor(ctx);
      const twizzYaml = await gh((g) => g.getFileContent(owner, repo, "twizz.yaml", input.sha));
      let dockerfilePath = "Dockerfile";
      let parsed: ReturnType<typeof parseTwizzObject> | null = null;
      if (twizzYaml !== null) {
        try {
          parsed = parseTwizzObject(parseYaml(twizzYaml));
          if (parsed.ok) dockerfilePath = `${parsed.config.context === "." ? "" : parsed.config.context.replace(/\/$/, "") + "/"}${parsed.config.dockerfile}`;
        } catch {
          parsed = { ok: false, issues: ["twizz.yaml is not valid YAML"] };
        }
      }
      const hasDockerfile = (await gh((g) => g.getFileContent(owner, repo, dockerfilePath, input.sha))) !== null;
      return { twizzYaml, valid: parsed?.ok ?? false, legacy: parsed?.ok ? parsed.legacy : false, issues: parsed && !parsed.ok ? parsed.issues : [], dockerfilePath, hasDockerfile };
    }),

  /** twizz.yaml (and Dockerfile) presence on the default branch of up to 50
   * repos, for the Projects grid's kind column. Cached 10 min per repo. */
  twizzConfigs: protectedProcedure
    .input(z.object({ repos: z.array(z.object({ name: z.string().regex(REPO_NAME_RE), defaultBranch: z.string().regex(BRANCH_RE) })).max(50) }))
    .query(async ({ ctx, input }) => {
      const gh = githubFor(ctx);
      const out: Record<string, TwizzConfigSummary | null> = {};
      await Promise.all(
        input.repos.map(async (r) => {
          const key = `${GITHUB_ORG}/${r.name}@${r.defaultBranch}`;
          out[r.name] = await cached(configCache, key, CONFIG_TTL, () => gh((g) => readTwizzSummary(g, GITHUB_ORG, r.name, r.defaultBranch))).catch(() => null);
        }),
      );
      return out;
    }),

  get: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      return ctx.prisma.project.findUniqueOrThrow({
        where: { id: input.id },
        include: { environments: { orderBy: { createdAt: "desc" } } },
      });
    }),

  detectType: protectedProcedure
    .input(detectProjectSchema)
    .mutation(async ({ ctx, input }) => {
      const [owner, repo] = input.repoUrl.replace("https://github.com/", "").split("/");
      return githubFor(ctx)((g) => g.detectProjectType(owner, repo, input.branch));
    }),

  create: protectedProcedure
    .input(createProjectSchema)
    .mutation(async ({ ctx, input }) => {
      const project = await ctx.prisma.project.create({ data: input });
      const actor = ((ctx.session as { login?: string }).login as string | undefined) ?? "unknown";
      await ctx.prisma.auditLog.create({
        data: {
          actor,
          action: "project.create",
          resource: project.githubRepoUrl,
          detail: { projectId: project.id },
        },
      });
      return project;
    }),
});
