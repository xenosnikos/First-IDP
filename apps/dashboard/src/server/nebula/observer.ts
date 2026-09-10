// Observer wiring for the dashboard (docs/NEBULA.md §N3.4 → Observer phase 1).
// Read-only by construction: the tools only see @twizz-idp/core's CloudWatch
// readers, scope is fixed server-side from the human's selection, and every
// run — allowed, denied, or failed — writes one AuditLog row. That row is
// also the budget ledger, so there is no new table.
import { awsService } from "@twizz-idp/core";
import type { PrismaClient } from "@twizz-idp/db";
import { budgetVerdict, type ObserverDeps, type ObserverKind, type ObserverScope } from "@twizz-idp/observer";

export const OBSERVER_ACTION_PREFIX = "nebula.observer.";

export function observerCaps(): { dailyCap: number; perActorCap: number } {
  const n = (v: string | undefined, d: number) => {
    const x = Number(v);
    return Number.isFinite(x) && x > 0 ? Math.floor(x) : d;
  };
  return { dailyCap: n(process.env.OBSERVER_DAILY_RUNS, 40), perActorCap: n(process.env.OBSERVER_DAILY_RUNS_PER_USER, 15) };
}

export function observerConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

export function observerDeps(): ObserverDeps {
  return {
    getPodLogs: (p) => awsService.getPodLogs(p),
    getLogHistogram: (p) => awsService.getLogHistogram(p),
    getLivePods: (c) => awsService.getLivePods(c),
    getNodeMetrics: (c) => awsService.getNodeMetrics(c),
  };
}

function startOfUtcDay(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export async function countRunsToday(prisma: PrismaClient, login: string): Promise<{ runsToday: number; actorRunsToday: number }> {
  const where = { action: { startsWith: OBSERVER_ACTION_PREFIX }, allowed: true, createdAt: { gte: startOfUtcDay() } };
  const [runsToday, actorRunsToday] = await Promise.all([prisma.auditLog.count({ where }), prisma.auditLog.count({ where: { ...where, actor: login } })]);
  return { runsToday, actorRunsToday };
}

export async function observerStatus(prisma: PrismaClient, login: string) {
  const caps = observerCaps();
  const counts = await countRunsToday(prisma, login);
  const configured = observerConfigured();
  const verdict = budgetVerdict({ ...counts, ...caps });
  const word: "STUB" | "DENIED" | "PASS" = !configured ? "STUB" : verdict.word;
  return { configured, ...counts, ...caps, word, reason: !configured ? "ANTHROPIC_API_KEY is not configured on this Nebula" : verdict.reason };
}

export type ObserverAuditDetail = {
  model?: string;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  toolCalls?: Array<{ name: string; input: unknown; ms?: number }>;
  iterations?: number;
  stopReason?: string;
  redacted?: Record<string, number>;
  durationMs?: number;
  reason?: string;
  aborted?: boolean;
  error?: string;
};

export function resourceOf(scope: ObserverScope): string {
  return `${scope.cluster}/${scope.namespace}${scope.pod ? `/${scope.pod}` : ""}`;
}

export async function auditObserverRun(prisma: PrismaClient, a: { login: string; kind: ObserverKind; scope: ObserverScope; allowed: boolean; detail: ObserverAuditDetail }): Promise<void> {
  // Never store prompts, selections, or log text — only shapes and counts.
  await prisma.auditLog
    .create({
      data: {
        actor: a.login,
        action: `${OBSERVER_ACTION_PREFIX}${a.kind}`,
        resource: resourceOf(a.scope),
        allowed: a.allowed,
        detail: { window: { from: a.scope.from, to: a.scope.to }, ...a.detail } as object,
      },
    })
    .catch(() => {});
}
