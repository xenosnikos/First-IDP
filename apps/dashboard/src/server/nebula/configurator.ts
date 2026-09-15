// Configurator wiring (docs/NEBULA.md §N3.7). Read-only by construction: the
// tools see one repo at one commit through the HUMAN's session token, and the
// proposal is data the drawer shows — committing it goes through the gate.
// Every run (allowed, denied, failed) writes one AuditLog row, which is also
// the budget ledger: the Configurator costs real money per run.
import type { PrismaClient } from "@twizz-idp/db";
import { GitHubService } from "@twizz-idp/core";
import { budgetVerdict, type RepoReader, type ToolCallRecord } from "@twizz-idp/observer";

export const CONFIGURATOR_ACTION = "nebula.configurator";

export function configuratorCaps(): { dailyCap: number; perActorCap: number } {
  const n = (v: string | undefined, d: number) => {
    const x = Number(v);
    return Number.isFinite(x) && x > 0 ? Math.floor(x) : d;
  };
  return { dailyCap: n(process.env.CONFIGURATOR_DAILY_RUNS, 20), perActorCap: n(process.env.CONFIGURATOR_DAILY_RUNS_PER_USER, 3) };
}

function startOfUtcDay(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export async function countConfiguratorRunsToday(prisma: PrismaClient, login: string): Promise<{ runsToday: number; actorRunsToday: number }> {
  const where = { action: CONFIGURATOR_ACTION, allowed: true, createdAt: { gte: startOfUtcDay() } };
  const [runsToday, actorRunsToday] = await Promise.all([prisma.auditLog.count({ where }), prisma.auditLog.count({ where: { ...where, actor: login } })]);
  return { runsToday, actorRunsToday };
}

export async function configuratorStatus(prisma: PrismaClient, login: string) {
  const caps = configuratorCaps();
  const counts = await countConfiguratorRunsToday(prisma, login);
  const configured = !!process.env.ANTHROPIC_API_KEY;
  const verdict = budgetVerdict({ ...counts, ...caps });
  const word: "STUB" | "DENIED" | "PASS" = !configured ? "STUB" : verdict.word;
  return { configured, ...counts, ...caps, word, reason: !configured ? "ANTHROPIC_API_KEY is not configured on this Nebula" : verdict.reason?.replace("Observer", "Configurator") };
}

/** The repo reader for one run: the human's token, one repo, one commit. */
export function repoReaderFor(token: string, owner: string, repo: string, sha: string): RepoReader {
  const gh = new GitHubService(token);
  return {
    listTree: () => gh.listTree(owner, repo, sha),
    getFile: (path) => gh.getFileContent(owner, repo, path, sha),
  };
}

export type ConfiguratorAuditDetail = {
  model?: string;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Names, paths and timings only — never file contents. */
  toolCalls?: Array<{ name: string; path?: string; ms?: number }>;
  iterations?: number;
  stopReason?: string;
  proposed?: boolean;
  confidence?: string;
  rejected?: number;
  redacted?: Record<string, number>;
  durationMs?: number;
  reason?: string;
  aborted?: boolean;
  error?: string;
};

export function auditToolCalls(calls: ToolCallRecord[]): ConfiguratorAuditDetail["toolCalls"] {
  return calls.map((c) => {
    const path = c.input && typeof c.input === "object" && typeof (c.input as { path?: unknown }).path === "string" ? (c.input as { path: string }).path : undefined;
    return { name: c.name, ...(path ? { path } : {}), ms: c.ms };
  });
}

export async function auditConfiguratorRun(prisma: PrismaClient, a: { login: string; repo: string; ref: string; sha: string; allowed: boolean; detail: ConfiguratorAuditDetail }): Promise<void> {
  await prisma.auditLog
    .create({ data: { actor: a.login, action: CONFIGURATOR_ACTION, resource: `${a.repo}@${a.ref}#${a.sha.slice(0, 12)}`, allowed: a.allowed, detail: { ref: a.ref, sha: a.sha, ...a.detail } as object } })
    .catch(() => {});
}
