// Lifecycle (docs/NEBULA.md §N9): wiring for the five gated operator writes.
// The logic and its ports live in @twizz-idp/actions (lifecycle.ts); this file
// hands them the real things — the preview state machine read FRESH (never the
// 20 s cache the page polls), the request queue in Postgres, GitHub on the
// platform token, and the same policy.yaml the gate enforces. No write happens
// here: routers/actions.ts calls these only from inside `gateFor(...)`.
import { GithubLifecycleRepos, type LifecycleDeps, type LifecycleQueue, type LifecycleSmokeEvidence, type LifecycleState } from "@twizz-idp/actions";
import type { PrismaClient } from "@twizz-idp/db";
import { LifecycleSmokeParams } from "@twizz-idp/shared";
import { namedEnvDeps, octokit, policy } from "./deps";
import { enqueueLifecycleRequest, lifecyclePreviewState } from "./lifecycle";
import type { PreviewInput, PreviewView, SmokeVerdict } from "./lifecycle-model";

/** A smoke verdict plus the targets its request was queued with, read back
 * from the request row (the dashboard built them; nobody else can). */
function evidence(v: SmokeVerdict, requests: PreviewInput["requests"]): LifecycleSmokeEvidence {
  const row = v.request ? requests.find((r) => r.id === v.request!.id) : undefined;
  const params = row ? LifecycleSmokeParams.safeParse(row.params) : null;
  return {
    verdict: v.verdict,
    detail: v.detail,
    request: v.request ? { id: v.request.id, createdAt: v.request.createdAt } : null,
    runId: v.runId,
    finishedAt: v.finishedAt,
    results: v.results.map((r) => ({ name: r.name, url: r.url, ok: r.ok })),
    targets: params?.success ? params.data.targets : [],
  };
}

/** The preview state machine → what the gated actions decide from. */
export function lifecycleStateFrom(view: PreviewView, input: Pick<PreviewInput, "requests">): LifecycleState {
  return {
    bundleKey: view.bundleKey,
    bundles: view.bundles.map((b) => ({
      github: b.github,
      branch: b.branch,
      headSha: b.headSha,
      included: b.included.map((p) => ({ repo: p.repo, number: p.number, url: p.url })),
      service: b.service,
      promotable: b.promotable,
      previewable: b.previewable,
      note: b.note,
      envName: b.envName,
      env: b.env ? { name: b.env.name, up: b.env.up } : null,
      staging: b.staging ? { deployed: b.staging.deployed, promotion: b.staging.promotion ? { number: b.staging.promotion.number, url: b.staging.promotion.url, imageTag: b.staging.promotion.imageTag } : null } : null,
    })),
    smoke: { preview: evidence(view.smoke.preview, input.requests), stg: evidence(view.smoke.stg, input.requests) },
    signoff: view.signoff,
    actions: view.actions,
  };
}

const ACTIVE = ["pending", "claimed"];

export function lifecycleQueue(prisma: PrismaClient): LifecycleQueue {
  return {
    async findActive(kind) {
      const row = await prisma.lifecycleRequest.findFirst({ where: { kind, status: { in: ACTIVE } }, orderBy: { createdAt: "asc" } });
      return row ? { id: row.id, status: row.status, requestedBy: row.requestedBy, createdAt: row.createdAt.toISOString() } : null;
    },
    enqueue: (input, requestedBy) =>
      input.kind === "smoke" ? enqueueLifecycleRequest(prisma, { kind: "smoke", params: input.params, requestedBy }) : enqueueLifecycleRequest(prisma, { kind: input.kind, params: {}, requestedBy }),
  };
}

/** Everything the Lifecycle writes need. `state()` re-reads snapshots,
 * requests, sign-offs, the named-env manifests, Argo and the promotion PRs
 * on every call — the actions call it again inside the gate. */
export function lifecycleDeps(prisma: PrismaClient): LifecycleDeps {
  return {
    ...namedEnvDeps(),
    state: async () => {
      const { view, input } = await lifecyclePreviewState(prisma, { fresh: true });
      return lifecycleStateFrom(view, input);
    },
    repos: new GithubLifecycleRepos(octokit()),
    queue: lifecycleQueue(prisma),
    policy: policy(),
    stagingApiUrl: process.env.NEBULA_STAGING_API_URL || null,
  };
}
