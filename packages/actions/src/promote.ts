// The release train (docs/NEBULA.md §N4): promote an EXISTING immutable image
// from previews into a staging target by a gitops pull request, then merge
// that PR — two human gates, one git record, Argo CD does the rollout.
//
//   promote_release  → PR on TwizzyNicky/twizz-gitops bumping
//                      apps/<service>/values-staging.yaml `image.tag`
//   merge_promotion  → squash-merge that PR (sha-guarded), Argo syncs
//
// Nothing here touches a kube API or a secret. Prod is not a target and is
// globally denied by policy.yaml. Every input that changes the effect
// (service, target, imageTag, pr) is a gate field bound to the nonce.
import { parseDocument, isMap } from "yaml";
import { GITOPS, type ImageInfo, type ImageRegistry } from "./named-envs";
import { RELEASE_TARGETS, releaseTarget, type ReleaseTarget, type ReleaseTrainTarget } from "./registry";

/** Immutable tags the train accepts: the central builder's, a repo CI's
 * main-<sha> / pr-<n>-<sha>, or a moly-backend build-<uuid>. Never an alias. */
export const PROMOTABLE_TAG_RE = /^(build-[0-9a-f-]{36}|nb-[a-z][a-z0-9-]{2,23}-[0-9a-f]{12}|main-[0-9a-f]{40}|pr-\d+-[0-9a-f]{40})$/;
export const NON_PROMOTABLE_ALIASES = new Set(["latest", "main", "dev", "staging", "prod", "production"]);

export const PROMOTION_BRANCH_PREFIX = "promote/";

export function isPromotableTag(tag: string): boolean {
  return PROMOTABLE_TAG_RE.test(tag) && !NON_PROMOTABLE_ALIASES.has(tag);
}

export function isReleaseTarget(t: string): t is ReleaseTarget {
  return (RELEASE_TARGETS as readonly string[]).includes(t);
}

/** `promote/<service>/<target>/<tag>` — the tag is the full immutable tag so
 * the branch alone says exactly what the PR does (parsed back by listPromotions). */
export function promotionBranch(service: string, target: ReleaseTarget, tag: string): string {
  return `${PROMOTION_BRANCH_PREFIX}${service}/${target}/${tag}`;
}

export function parsePromotionBranch(branch: string): { service: string; target: ReleaseTarget; tag: string } | null {
  if (!branch.startsWith(PROMOTION_BRANCH_PREFIX)) return null;
  const parts = branch.slice(PROMOTION_BRANCH_PREFIX.length).split("/");
  if (parts.length !== 3) return null;
  const [service, target, tag] = parts;
  if (!isReleaseTarget(target) || !isPromotableTag(tag) || !/^[a-z][a-z0-9-]{1,39}$/.test(service)) return null;
  return { service, target, tag };
}

export function kindOfTag(tag: string): "main" | "pr" | "nebula" | "build" {
  if (tag.startsWith("main-")) return "main";
  if (tag.startsWith("pr-")) return "pr";
  if (tag.startsWith("nb-")) return "nebula";
  return "build";
}

// ── values file surgery (comments preserved) ───────────────────────────

export function readImageTag(valuesYaml: string): string | null {
  const doc = parseDocument(valuesYaml);
  const tag = doc.getIn(["image", "tag"]);
  return tag === undefined || tag === null ? null : String(tag);
}

/** Set `image.tag`, keeping every comment and every other key byte-for-byte
 * as the YAML library re-emits them. Refuses a file without an `image` map
 * (that would be the wrong file). */
export function bumpImageTag(valuesYaml: string, tag: string): string {
  const doc = parseDocument(valuesYaml);
  if (doc.errors.length) throw new Error(`values file is not valid YAML: ${doc.errors[0].message}`);
  const image = doc.get("image");
  if (!isMap(image)) throw new Error("values file has no `image:` map — refusing to bump the wrong file");
  doc.setIn(["image", "tag"], tag);
  return doc.toString();
}

// ── ports ──────────────────────────────────────────────────────────────

export type PromotionPr = {
  number: number;
  url: string;
  title: string;
  /** head branch */
  branch: string;
  headSha: string;
  author: string;
  createdAt: string;
  state: "open" | "closed" | "merged";
};

export interface PromotionRepo {
  /** A file on the gitops default branch; null when absent. */
  readFile(path: string): Promise<{ content: string; sha: string } | null>;
  /** Commit `files` on `branch` (created off main, or moved if it exists) and open a PR into main. */
  openPr(input: { branch: string; files: Record<string, string>; title: string; body: string }): Promise<{ number: number; url: string; headSha: string }>;
  listOpenPrs(branchPrefix: string): Promise<PromotionPr[]>;
  getPr(number: number): Promise<PromotionPr | null>;
  /** Squash-merge, refused by GitHub if the head moved past `sha`. Deletes the branch afterwards. */
  mergePr(number: number, opts: { title: string; sha: string }): Promise<{ sha: string }>;
}

export type PromoteDeps = { images: ImageRegistry; promotions: PromotionRepo };

// ── candidates ─────────────────────────────────────────────────────────

export type ReleaseCandidate = { tag: string; kind: ReturnType<typeof kindOfTag>; aliases: string[]; pushedAt?: string; digest?: string };

/** Immutable images in the service's ECR repo, newest first. Aliases
 * (main/dev/latest) are shown on the row they point at, never offered. */
export async function listReleaseCandidates(deps: Pick<PromoteDeps, "images">, service: string, limit = 20): Promise<ReleaseCandidate[]> {
  const t = releaseTarget(service, "staging");
  if (!t) throw new Error(`"${service}" is not on the release train`);
  const images = await deps.images.listImages(t.service.ecrRepo);
  return images
    .map((i) => ({ i, tag: i.tags.filter(isPromotableTag).sort()[0] }))
    .filter((x): x is { i: ImageInfo; tag: string } => !!x.tag)
    .sort((a, b) => (b.i.pushedAt?.getTime() ?? 0) - (a.i.pushedAt?.getTime() ?? 0))
    .slice(0, limit)
    .map(({ i, tag }) => ({ tag, kind: kindOfTag(tag), aliases: i.tags.filter((x) => x !== tag), pushedAt: i.pushedAt?.toISOString(), digest: i.digest }));
}

// ── the two actions ────────────────────────────────────────────────────

export type PromoteInput = { service: string; target: ReleaseTarget; imageTag: string; actor: string };

export type PromoteResult = {
  service: string;
  target: ReleaseTarget;
  from: string | null;
  to: string;
  prNumber: number;
  prUrl: string;
  branch: string;
  /** true when an identical open PR already existed (nothing new written) */
  existing: boolean;
  image: { tag: string; aliases: string[]; pushedAt?: string };
  argoApp: string;
  host: string;
};

export function promotionPrBody(o: { service: string; target: ReleaseTarget; from: string | null; to: string; actor: string; t: ReleaseTrainTarget; image: ImageInfo }): string {
  const aliases = o.image.tags.filter((a) => a !== o.to);
  return [
    `Nebula release train: promote **${o.service}** to **${o.target}**.`,
    "",
    `- Image: \`${o.service}:${o.to}\`${aliases.length ? ` (also tagged ${aliases.join(", ")})` : ""}${o.image.pushedAt ? `, pushed ${o.image.pushedAt.toISOString()}` : ""}`,
    `- Replaces: \`${o.from ?? "(none)"}\``,
    `- File: \`${o.t.valuesFile}\` → Argo Application \`${o.t.argoApp}\` on ${o.t.cluster} / ns ${o.t.namespace}`,
    `- URL after sync: https://${o.t.host}`,
    `- Requested by: ${o.actor}`,
    "",
    "Merging is the second human gate (Nebula `merge_promotion`, or merge here). Argo CD syncs within ~3 minutes of the merge. To roll back, promote the previous tag.",
    "",
    "Nebula · docs/NEBULA.md §N4",
  ].join("\n");
}

/** Open the promotion PR. Idempotent: an identical open PR is returned as-is. */
export async function promoteRelease(deps: PromoteDeps, input: PromoteInput): Promise<PromoteResult> {
  const { service, target, imageTag, actor } = input;
  const t = releaseTarget(service, target);
  if (!t) throw new Error(`"${service}" has no ${target} target on the release train`);
  if (!isPromotableTag(imageTag)) throw new Error(`"${imageTag}" is not an immutable image tag (build-*/nb-*/main-<sha>/pr-<n>-<sha>); aliases are never promoted`);

  const image = await deps.images.describeTag(t.service.ecrRepo, imageTag);
  if (!image) throw new Error(`ECR ${t.service.ecrRepo}:${imageTag} does not exist — only images that are already built can be promoted`);

  const values = await deps.promotions.readFile(t.valuesFile);
  if (!values) throw new Error(`${GITOPS.owner}/${GITOPS.repo}:${t.valuesFile} does not exist — the ${target} target is not bootstrapped in gitops`);
  const from = readImageTag(values.content);
  if (from === imageTag) throw new Error(`${service} ${target} is already on ${imageTag}`);

  const branch = promotionBranch(service, target, imageTag);
  const open = (await deps.promotions.listOpenPrs(branch)).find((p) => p.branch === branch);
  const base = { service, target, from, to: imageTag, branch, image: { tag: imageTag, aliases: image.tags.filter((x) => x !== imageTag), pushedAt: image.pushedAt?.toISOString() }, argoApp: t.argoApp, host: t.host };
  if (open) return { ...base, prNumber: open.number, prUrl: open.url, existing: true };

  const content = bumpImageTag(values.content, imageTag);
  const pr = await deps.promotions.openPr({
    branch,
    files: { [t.valuesFile]: content },
    title: `promote(${service}): ${target} → ${imageTag}`,
    body: promotionPrBody({ service, target, from, to: imageTag, actor, t, image }),
  });
  return { ...base, prNumber: pr.number, prUrl: pr.url, existing: false };
}

export type PromotionView = PromotionPr & { service: string; target: ReleaseTarget; imageTag: string; argoApp?: string; host?: string };

/** Open promotion PRs, parsed from their branch names. PRs whose branch does
 * not parse are not promotions and are skipped (never guessed). */
export async function listPromotions(deps: Pick<PromoteDeps, "promotions">): Promise<PromotionView[]> {
  const prs = await deps.promotions.listOpenPrs(PROMOTION_BRANCH_PREFIX);
  const out: PromotionView[] = [];
  for (const pr of prs) {
    const parsed = parsePromotionBranch(pr.branch);
    if (!parsed) continue;
    const t = releaseTarget(parsed.service, parsed.target);
    out.push({ ...pr, service: parsed.service, target: parsed.target, imageTag: parsed.tag, argoApp: t?.argoApp, host: t?.host });
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export type MergeInput = { prNumber: number; service: string; target: ReleaseTarget; imageTag: string; actor: string };

/** Merge a promotion PR. The (service, target, imageTag) the human confirmed
 * must equal what the PR's branch says, and the merge is pinned to the head
 * sha read here — a PR edited or swapped between confirm and merge is refused. */
export async function mergePromotion(deps: Pick<PromoteDeps, "promotions">, input: MergeInput): Promise<{ prNumber: number; mergedSha: string; service: string; target: ReleaseTarget; imageTag: string; argoApp: string; host: string }> {
  const t = releaseTarget(input.service, input.target);
  if (!t) throw new Error(`"${input.service}" has no ${input.target} target on the release train`);
  const pr = await deps.promotions.getPr(input.prNumber);
  if (!pr) throw new Error(`PR #${input.prNumber} does not exist in ${GITOPS.owner}/${GITOPS.repo}`);
  if (pr.state !== "open") throw new Error(`PR #${input.prNumber} is ${pr.state}`);
  const parsed = parsePromotionBranch(pr.branch);
  if (!parsed) throw new Error(`PR #${input.prNumber} (${pr.branch}) is not a promotion PR`);
  if (parsed.service !== input.service || parsed.target !== input.target || parsed.tag !== input.imageTag) {
    throw new Error(`PR #${input.prNumber} promotes ${parsed.service} ${parsed.target} → ${parsed.tag}, not ${input.service} ${input.target} → ${input.imageTag}`);
  }
  const merged = await deps.promotions.mergePr(pr.number, { title: `${pr.title} (#${pr.number})`, sha: pr.headSha });
  return { prNumber: pr.number, mergedSha: merged.sha, service: parsed.service, target: parsed.target, imageTag: parsed.tag, argoApp: t.argoApp, host: t.host };
}

/** What the staging target currently points at, from gitops (the source of truth). */
export async function readTargetState(deps: Pick<PromoteDeps, "promotions">, service: string, target: ReleaseTarget): Promise<{ imageTag: string | null; valuesFile: string; present: boolean }> {
  const t = releaseTarget(service, target);
  if (!t) throw new Error(`"${service}" has no ${target} target on the release train`);
  const values = await deps.promotions.readFile(t.valuesFile);
  return { imageTag: values ? readImageTag(values.content) : null, valuesFile: t.valuesFile, present: !!values };
}
