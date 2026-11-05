// Bearer auth for /api/mcp (docs/NEBULA.md §N7). The MCP client sends the
// person's OWN GitHub token (the plugin's headersHelper runs `gh auth token`);
// Nebula resolves it to a login and applies the exact sign-in rule of the
// browser (lib/github-access.ts). The result is a session of the same shape
// Auth.js produces, so every tRPC procedure — protected/operator/owner checks,
// the gate, AuditLog — runs unchanged. The token itself is never stored or
// logged; the cache is keyed by its SHA-256.
import { createHash } from "node:crypto";
import type { PrismaClient } from "@twizz-idp/db";
import { githubLoginOf, isAllowedGithubUser, type FetchLike } from "@/lib/github-access";
import { isMcpUser } from "@/lib/nebula/operators";

export type McpSession = {
  user: { name: string | null; email: null; image: null };
  login: string;
  accessToken: string;
  expires: string;
  via: "mcp";
};

export type McpAuthResult = { ok: true; session: McpSession } | { ok: false; status: 401 | 403; reason: string };

const TTL_MS = 5 * 60_000;
const DENY_TTL_MS = 60_000;
const MAX_ENTRIES = 500;

type Entry = { at: number; result: { ok: true; login: string; name: string | null } | { ok: false; status: 401 | 403; reason: string } };
const cache = new Map<string, Entry>();

export function bearerOf(header: string | null | undefined): string | null {
  const m = /^Bearer\s+([A-Za-z0-9_.-]{20,255})\s*$/.exec(header ?? "");
  return m ? m[1] : null;
}

const keyOf = (token: string) => createHash("sha256").update(token).digest("hex");

export function _resetMcpAuthCache() {
  cache.clear();
}

export async function authenticateMcp(
  authorization: string | null | undefined,
  deps: { prisma: Pick<PrismaClient, "auditLog">; fetch?: FetchLike; now?: () => number },
): Promise<McpAuthResult> {
  const token = bearerOf(authorization);
  if (!token) return { ok: false, status: 401, reason: "missing or malformed Authorization: Bearer <GitHub token>" };
  const now = deps.now?.() ?? Date.now();
  const key = keyOf(token);
  let entry = cache.get(key);
  if (!entry || now - entry.at > (entry.result.ok ? TTL_MS : DENY_TTL_MS)) {
    entry = { at: now, result: await verify(token, deps) };
    if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
    cache.set(key, entry);
  }
  const r = entry.result;
  if (!r.ok) return r;
  return {
    ok: true,
    session: {
      user: { name: r.name ?? r.login, email: null, image: null },
      login: r.login,
      accessToken: token,
      expires: new Date(entry.at + TTL_MS).toISOString(),
      via: "mcp",
    },
  };
}

async function verify(token: string, deps: { prisma: Pick<PrismaClient, "auditLog">; fetch?: FetchLike }): Promise<Entry["result"]> {
  const f = deps.fetch ?? fetch;
  const who = await githubLoginOf(token, f).catch(() => null);
  if (!who) return { ok: false, status: 401, reason: "GitHub rejected the token (expired or revoked?) — re-run `gh auth login`" };
  // two gates: allowed on Nebula at all (same rule as the browser), AND on the
  // explicit MCP list (NEBULA_MCP_USERS; unset = operators only)
  const nebula = await isAllowedGithubUser(who.login, token, f).catch(() => false);
  const mcp = nebula && isMcpUser(who.login);
  const reason = !nebula ? `${who.login} is not allowed on Nebula (ALLOWED_GITHUB_LOGINS / org membership)` : !mcp ? `${who.login} is not on the Nebula MCP list (NEBULA_MCP_USERS) — ask the platform owner` : undefined;
  // one row per fresh verification (≤ 1 per token per 5 min), like a browser sign-in
  await deps.prisma.auditLog.create({ data: { actor: who.login, action: "mcp.signin", allowed: mcp, detail: { via: "mcp", ...(reason ? { reason } : {}) } } }).catch(() => {});
  if (reason) return { ok: false, status: 403, reason };
  return { ok: true, login: who.login, name: who.name };
}
