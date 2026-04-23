import { z } from "zod";
import { router, protectedProcedure } from "../trpc";
import { createProjectSchema, detectProjectSchema } from "@twizz-idp/shared";
import { GitHubService } from "../services/github";

const GITHUB_ORG = process.env.GITHUB_ORG ?? "Twizz";

export const projectRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    return ctx.prisma.project.findMany({
      orderBy: { updatedAt: "desc" },
      include: { _count: { select: { environments: true } } },
    });
  }),

  listGithubRepos: protectedProcedure.query(async ({ ctx }) => {
    const token = (ctx.session as any).accessToken as string;
    const github = new GitHubService(token);
    return github.listOrgRepos(GITHUB_ORG);
  }),

  listBranches: protectedProcedure
    .input(z.object({ owner: z.string(), repo: z.string() }))
    .query(async ({ ctx, input }) => {
      const token = (ctx.session as any).accessToken as string;
      const github = new GitHubService(token);
      return github.listBranches(input.owner, input.repo);
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
      const token = (ctx.session as any).accessToken as string;
      const github = new GitHubService(token);
      const [owner, repo] = input.repoUrl.replace("https://github.com/", "").split("/");
      return github.detectProjectType(owner, repo, input.branch);
    }),

  create: protectedProcedure
    .input(createProjectSchema)
    .mutation(async ({ ctx, input }) => {
      return ctx.prisma.project.create({ data: input });
    }),
});
