import { z } from "zod";
import { router, protectedProcedure } from "../trpc";
import { awsService, LOG_NAME_RE } from "@twizz-idp/core";
import { podWord } from "@/lib/nebula/status";

// Clusters page (docs/NEBULA.md §N3.4). QUERIES ONLY, by construction: this
// router has no mutations, and the credentials behind it (IRSA
// twizz-nebula-dashboard) carry only CloudWatch/EKS read statements — there is
// no kube-API path to staging or prod anywhere in Nebula. Non-prod deploy
// actions live in the `actions` router behind the gate.

export const CLUSTERS = [
  { name: "EKS-Twizz-NonProd", role: "DEPLOYABLE", tier: "non-prod", note: "Nebula's only deploy target (named envs, PR previews, gitops apps)" },
  { name: "EKS-Moly-staging", role: "OBSERVE ONLY", tier: "staging / QA", note: "staging in default ns, dev in dev ns — observed via CloudWatch, never deployed to" },
  { name: "EKS-Moly-Prod", role: "OBSERVE ONLY", tier: "production", note: "observed via CloudWatch only; never a target, never an upstream" },
] as const;
export type ClusterName = (typeof CLUSTERS)[number]["name"];
const clusterName = z.enum(CLUSTERS.map((c) => c.name) as [ClusterName, ...ClusterName[]]);

const k8sName = (max: number) => z.string().min(1).max(max).regex(LOG_NAME_RE, "kubernetes name");
const logsInput = z.object({
  cluster: clusterName,
  namespace: k8sName(63),
  podName: k8sName(253).optional(),
  minutesBack: z.number().int().min(5).max(1440).default(30),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  filter: z.string().max(200).optional(),
});

/** Explicit `from`/`to` win; otherwise the trailing `minutesBack`. Windows are
 * capped at 24 h (Container Insights retention here is one day anyway). */
function windowOf(i: { minutesBack: number; from?: string; to?: string }): { start: number; end: number } {
  const now = Date.now();
  let end = i.to ? Math.min(Date.parse(i.to), now) : now;
  let start = i.from ? Date.parse(i.from) : end - i.minutesBack * 60_000;
  if (!(end > start)) end = start + 60_000;
  if (end - start > 24 * 3600_000) start = end - 24 * 3600_000;
  return { start, end };
}

export const clustersRouter = router({
  /** All three clusters, pods grouped by namespace. A cluster that cannot be
   * read comes back with `reachable: false` and a reason — shown as UNKNOWN. */
  overview: protectedProcedure.query(async () => {
    const clusters = await Promise.all(
      CLUSTERS.map(async (c) => {
        try {
          const pods = await awsService.getLivePods(c.name);
          const byNs = new Map<string, typeof pods>();
          for (const p of pods) byNs.set(p.namespace, [...(byNs.get(p.namespace) ?? []), p]);
          const namespaces = [...byNs.entries()]
            .map(([namespace, ps]) => ({
              namespace,
              pods: ps
                .map((p) => ({ ...p, ...podWord(p.status, p.restarts) }))
                .sort((a, b) => a.podName.localeCompare(b.podName)),
            }))
            .sort((a, b) => a.namespace.localeCompare(b.namespace));
          const words = namespaces.flatMap((n) => n.pods.map((p) => p.word));
          const counts = words.reduce<Record<string, number>>((acc, w) => ({ ...acc, [w]: (acc[w] ?? 0) + 1 }), {});
          return { ...c, reachable: true as const, reason: undefined, namespaces, podCount: pods.length, counts };
        } catch (e) {
          return { ...c, reachable: false as const, reason: String((e as { message?: string }).message ?? e), namespaces: [], podCount: 0, counts: {} };
        }
      }),
    );
    return { clusters, readAt: new Date().toISOString() };
  }),

  /** Aggregated Container Insights application logs for one namespace
   * (optionally one pod) over a window, newest last. `from`/`to` (ISO) win
   * over `minutesBack` so the client can page older with `to = oldest`.
   * `status` says how the query ended — a timeout is not "no logs". */
  logs: protectedProcedure
    .input(logsInput.extend({ limit: z.number().int().min(50).max(1000).default(300) }))
    .query(async ({ input }) => {
      const { start, end } = windowOf(input);
      const { status, lines } = await awsService.getPodLogs({
        clusterName: input.cluster,
        namespace: input.namespace,
        podName: input.podName || undefined,
        startTime: Math.floor(start / 1000),
        endTime: Math.floor(end / 1000),
        filterPattern: input.filter || undefined,
        limit: input.limit,
      });
      return {
        cluster: input.cluster,
        namespace: input.namespace,
        from: new Date(start).toISOString(),
        to: new Date(end).toISOString(),
        status,
        count: lines.length,
        oldest: lines[0]?.timestamp ?? null,
        lines,
      };
    }),

  /** Line counts per bin over the same scope — the burst finder. */
  logHistogram: protectedProcedure
    .input(logsInput.extend({ binMinutes: z.union([z.literal(5), z.literal(15), z.literal(60)]).default(15) }))
    .query(async ({ input }) => {
      const { start, end } = windowOf(input);
      const { status, bins, binMinutes } = await awsService.getLogHistogram({
        clusterName: input.cluster,
        namespace: input.namespace,
        podName: input.podName || undefined,
        filterPattern: input.filter || undefined,
        startTime: Math.floor(start / 1000),
        endTime: Math.floor(end / 1000),
        binMinutes: input.binMinutes,
      });
      return { status, binMinutes, from: new Date(start).toISOString(), to: new Date(end).toISOString(), bins };
    }),
});
