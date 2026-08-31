#!/usr/bin/env tsx
// Near-zero-touch repo onboarding:
//   pnpm --filter @twizz-idp/onboard onboard detect  <owner>/<repo>
//   pnpm --filter @twizz-idp/onboard onboard plan    <owner>/<repo>   (writes files to out/)
//   pnpm --filter @twizz-idp/onboard onboard pr      <owner>/<repo>   (opens the two PRs)
//   pnpm --filter @twizz-idp/onboard onboard protect <owner>/<repo>   (branch protection)
//
// Requires GITHUB_TOKEN with repo scope on the target org(s).
// Everything goes through the GitHub API — no local clones, no git commands.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Octokit } from "@octokit/rest";
import {
  twizzManifest,
  previewWorkflow,
  aiReviewWorkflow,
  gitopsValues,
  gitopsAppset,
  type ProjectKind,
} from "./templates.js";

const GITOPS = { owner: "twizz-app", repo: "gitops" };
const REQUIRED_CHECKS = ["build-and-label", "ai-review"]; // job names, extended per repo type

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function parseTarget(arg?: string): { owner: string; repo: string } {
  if (!arg || !arg.includes("/")) fail("usage: onboard <detect|plan|pr|protect> <owner>/<repo>");
  const [owner, repo] = arg.split("/");
  return { owner, repo };
}

function octo(): Octokit {
  const token = process.env.GITHUB_TOKEN;
  if (!token) fail("GITHUB_TOKEN not set");
  return new Octokit({ auth: token });
}

async function detectKind(gh: Octokit, owner: string, repo: string): Promise<ProjectKind> {
  const has = async (path: string) => {
    try {
      await gh.repos.getContent({ owner, repo, path });
      return true;
    } catch {
      return false;
    }
  };
  if (await has("template.yaml")) return "lambda-sam";
  if (await has("vercel.json")) return "frontend-vercel";
  if (await has("Dockerfile")) return "backend-k8s";
  // package.json heuristics
  try {
    const res = await gh.repos.getContent({ owner, repo, path: "package.json" });
    const content = Buffer.from((res.data as any).content, "base64").toString();
    const pkg = JSON.parse(content);
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps["next"] || deps["react-scripts"] || deps["@craco/craco"] || deps["react"]) return "frontend-vercel";
    if (deps["@nestjs/core"] || deps["express"] || deps["fastify"]) return "backend-k8s";
  } catch {
    /* no package.json */
  }
  return "backend-k8s";
}

type Plan = {
  kind: ProjectKind;
  name: string;
  repoFiles: Record<string, string>;
  gitopsFiles: Record<string, string>;
  notes: string[];
};

function buildPlan(kind: ProjectKind, owner: string, repo: string): Plan {
  const name = repo.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const ecrRepo = name.replace(/-/g, "");
  const notes: string[] = [];

  const repoFiles: Record<string, string> = {
    "twizz.yaml": twizzManifest({ name, kind }),
    ".github/workflows/ai-review.yml": aiReviewWorkflow(),
  };
  const gitopsFiles: Record<string, string> = {};

  if (kind === "backend-k8s") {
    repoFiles[".github/workflows/preview.yml"] = previewWorkflow({ name, ecrRepo });
    gitopsFiles[`apps/${name}/values.yaml`] = gitopsValues({
      name,
      ecrRepo,
      port: 8080,
      healthPath: "/health",
      secretName: `preview/${name}`,
    });
    gitopsFiles[`bootstrap/appset-${name}-preview.yaml`] = gitopsAppset({ name, owner, repo });
    notes.push(
      `ensure ECR repo '${ecrRepo}' exists (aws ecr create-repository --repository-name ${ecrRepo})`,
      `create Secrets Manager secret 'preview/${name}' before the first preview boots`,
      `repo needs a Dockerfile exposing port 8080 with GET /health`,
    );
  } else if (kind === "frontend-vercel") {
    notes.push(
      "connect the repo to its Vercel project (Settings → Git) — previews are then automatic",
      "add ANTHROPIC_API_KEY repo secret for ai-review",
    );
  } else {
    notes.push(
      "SAM repo: copy docs/enablement/image_conversion_service/preview.yml and adapt stack name",
      "grant the twizz-gha-sam-deploy role trust for this repo (infra/src/iam.ts StringLike sub)",
    );
  }
  notes.push("add ANTHROPIC_API_KEY secret to the repo for ai-review workflow");
  return { kind, name, repoFiles, gitopsFiles, notes };
}

/** Create a branch on a repo, commit files via the Git Data API, open a PR. */
async function openPr(
  gh: Octokit,
  target: { owner: string; repo: string },
  branch: string,
  files: Record<string, string>,
  title: string,
  body: string,
): Promise<string> {
  const { data: repoData } = await gh.repos.get(target);
  const base = repoData.default_branch;
  const { data: ref } = await gh.git.getRef({ ...target, ref: `heads/${base}` });
  const baseSha = ref.object.sha;

  const blobs = await Promise.all(
    Object.entries(files).map(async ([path, content]) => ({
      path,
      mode: "100644" as const,
      type: "blob" as const,
      sha: (await gh.git.createBlob({ ...target, content, encoding: "utf-8" })).data.sha,
    })),
  );
  const { data: tree } = await gh.git.createTree({ ...target, base_tree: baseSha, tree: blobs });
  const { data: commit } = await gh.git.createCommit({
    ...target,
    message: title,
    tree: tree.sha,
    parents: [baseSha],
  });
  await gh.git.createRef({ ...target, ref: `refs/heads/${branch}`, sha: commit.sha }).catch(async () => {
    await gh.git.updateRef({ ...target, ref: `heads/${branch}`, sha: commit.sha, force: true });
  });
  const { data: pr } = await gh.pulls.create({ ...target, title, head: branch, base, body });
  return pr.html_url;
}

async function main() {
  const [cmd, targetArg] = process.argv.slice(2);
  const { owner, repo } = parseTarget(targetArg);
  const gh = octo();

  const kind = await detectKind(gh, owner, repo);
  const plan = buildPlan(kind, owner, repo);

  if (cmd === "detect") {
    console.log(JSON.stringify({ owner, repo, kind, name: plan.name }, null, 2));
    return;
  }

  if (cmd === "plan") {
    const outDir = join(process.cwd(), "out", plan.name);
    for (const [rel, content] of Object.entries({ ...plan.repoFiles, ...plan.gitopsFiles })) {
      const dest = join(outDir, rel);
      mkdirSync(join(dest, ".."), { recursive: true });
      writeFileSync(dest, content);
    }
    console.log(`kind: ${kind}`);
    console.log(`files written under ${outDir}:`);
    for (const f of [...Object.keys(plan.repoFiles), ...Object.keys(plan.gitopsFiles)]) console.log(`  ${f}`);
    console.log("notes:");
    for (const n of plan.notes) console.log(`  - ${n}`);
    return;
  }

  if (cmd === "pr") {
    const branch = `twizz-idp/onboard-${plan.name}`;
    const url1 = await openPr(
      gh,
      { owner, repo },
      branch,
      plan.repoFiles,
      `chore: onboard ${plan.name} onto the Twizz IDP (${kind})`,
      ["Adds the IDP manifest + CI workflows.", "", "Notes:", ...plan.notes.map((n) => `- [ ] ${n}`)].join("\n"),
    );
    console.log(`repo PR: ${url1}`);

    if (Object.keys(plan.gitopsFiles).length > 0) {
      const url2 = await openPr(
        gh,
        GITOPS,
        branch,
        plan.gitopsFiles,
        `feat: preview environments for ${owner}/${repo}`,
        `Adds values + ApplicationSet for \`${plan.name}\`. Merges after the repo-side PR.`,
      );
      console.log(`gitops PR: ${url2}`);
    }
    return;
  }

  if (cmd === "protect") {
    const { data: repoData } = await gh.repos.get({ owner, repo });
    await gh.repos.updateBranchProtection({
      owner,
      repo,
      branch: repoData.default_branch,
      required_status_checks: { strict: true, contexts: REQUIRED_CHECKS },
      enforce_admins: false,
      required_pull_request_reviews: { required_approving_review_count: 1 },
      restrictions: null,
      allow_force_pushes: false,
    });
    console.log(`branch protection applied to ${owner}/${repo}@${repoData.default_branch} (checks: ${REQUIRED_CHECKS.join(", ")})`);
    return;
  }

  fail(`unknown command "${cmd}" — use detect | plan | pr | protect`);
}

main().catch((e) => fail(String(e)));
