// Auth for /api/mcp (docs/NEBULA.md §N7.1): a HARD three-credential gate.
//   1. GitHub token → login; the browser's sign-in rule (lib/github-access.ts)
//   2. that login must have a binding in NEBULA_MCP_IDENTITIES (the MCP list)
//   3. Google ID token → verified @twizz.com email == binding.google
//   4. presigned STS GetCallerIdentity → IAM user ARN (/nebula-mcp/) == binding.aws
// Any miss = 401/403 with the reason, and an `mcp.signin` AuditLog row carrying all
// three identities (or what was presented). The result is a session of the shape
// Auth.js produces (+ google/aws), so every tRPC procedure runs unchanged and
// every audit row can be traced to the person's GitHub, Google and AWS identity.
// Tokens are never stored or logged; caches are keyed by SHA-256.
import { createHash } from "node:crypto";
import type { PrismaClient } from "@twizz-idp/db";
import { githubLoginOf, isAllowedGithubUser } from "@/lib/github-access";
import { identityConfig, verifyAws, verifyGoogle, type FetchLike as IdFetch, type IdentityConfig } from "./identity";

export type McpSession = {
  user: { name: string | null; email: string; image: null };
  login: string;
  accessToken: string;
  expires: string;
  via: "mcp";
  google: string;
  aws: string;
};

export type McpAuthResult = { ok: true; session: McpSession } | { ok: false; status: 401 | 403; reason: string };

export type McpAuthHeaders = { authorization?: string | null; google?: string | null; aws?: string | null };

type Fetch = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

const GH_TTL_MS = 5 * 60_000;
const ID_TTL_MS = 60 * 60_000;
const DENY_TTL_MS = 60_000;
const MAX = 500;

type GhEntry = { at: number; r: { ok: true; login: string; name: string | null } | { ok: false; status: 401 | 403; reason: string } };
type IdEntry = { until: number; value: string };
const ghCache = new Map<string, GhEntry>();
const googleCache = new Map<string, IdEntry>();
const awsCache = new Map<string, IdEntry>();
const denyCache = new Map<string, number>();

function put<V>(m: Map<string, V>, k: string, v: V) {
  if (m.size >= MAX) m.delete(m.keys().next().value!);
  m.set(k, v);
}

export function bearerOf(header: string | null | undefined): string | null {
  const m = /^Bearer\s+([A-Za-z0-9_.-]{20,255})\s*$/.exec(header ?? "");
  return m ? m[1] : null;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export function _resetMcpAuthCache() {
  ghCache.clear();
  googleCache.clear();
  awsCache.clear();
  denyCache.clear();
}

export async function authenticateMcp(
  h: McpAuthHeaders,
  deps: { prisma: Pick<PrismaClient, "auditLog">; fetch?: Fetch; now?: () => number; config?: IdentityConfig },
): Promise<McpAuthResult> {
  const now = deps.now?.() ?? Date.now();
  const f = (deps.fetch ?? fetch) as Fetch;
  const cfg = deps.config ?? identityConfig();
  const token = bearerOf(h.authorization);
  if (!token) return { ok: false, status: 401, reason: "missing or malformed Authorization: Bearer <GitHub token>" };

  const audit = async (actor: string, allowed: boolean, detail: Record<string, unknown>) => {
    await deps.prisma.auditLog.create({ data: { actor, action: "mcp.signin", allowed, detail: { via: "mcp", ...detail } } }).catch(() => {});
  };
  const deny = async (actor: string, status: 401 | 403, reason: string, detail: Record<string, unknown> = {}): Promise<McpAuthResult> => {
    // audit each distinct denial once a minute, not on every retry
    const key = sha(`${actor}|${reason}`);
    if ((denyCache.get(key) ?? 0) < now - DENY_TTL_MS) {
      put(denyCache, key, now);
      await audit(actor, false, { reason, ...detail });
    }
    return { ok: false, status, reason };
  };

  // 1. GitHub
  const gk = sha(token);
  let gh = ghCache.get(gk);
  if (!gh || now - gh.at > (gh.r.ok ? GH_TTL_MS : DENY_TTL_MS)) {
    const who = await githubLoginOf(token, f as never).catch(() => null);
    const r: GhEntry["r"] = !who
      ? { ok: false, status: 401, reason: "GitHub rejected the token (expired or revoked?) — re-run `gh auth login`" }
      : (await isAllowedGithubUser(who.login, token, f as never).catch(() => false))
        ? { ok: true, login: who.login, name: who.name }
        : { ok: false, status: 403, reason: `${who.login} is not allowed on Nebula (ALLOWED_GITHUB_LOGINS / org membership)` };
    gh = { at: now, r };
    put(ghCache, gk, gh);
    if (!r.ok) return deny(who?.login ?? "unknown", r.status, r.reason);
  }
  if (!gh.r.ok) return { ok: false, status: gh.r.status, reason: gh.r.reason };
  const login = gh.r.login;

  // 2. the MCP list = the identity bindings
  const binding = cfg.bindings[login];
  if (!binding) return deny(login, 403, `${login} has no Nebula MCP identity binding (NEBULA_MCP_IDENTITIES) — ask the platform owner`);

  // 3. Google
  let google: string | undefined;
  const gtk = h.google ? sha(h.google) : "";
  const gc = gtk ? googleCache.get(gtk) : undefined;
  if (gc && gc.until > now) google = gc.value;
  else {
    const v = await verifyGoogle(h.google, cfg, f as unknown as IdFetch, now).catch((e) => ({ ok: false as const, reason: `Google verification failed: ${String((e as Error).message ?? e)}` }));
    if (!v.ok) return deny(login, 401, v.reason, { stage: "google" });
    google = v.email;
    put(googleCache, gtk, { until: Math.min(v.exp, now + ID_TTL_MS), value: v.email });
  }
  if (google !== binding.google) return deny(login, 403, `Google identity ${google} is not the one bound to ${login}`, { google });

  // 4. AWS
  let aws: string | undefined;
  const ak = h.aws ? sha(h.aws) : "";
  const ac = ak ? awsCache.get(ak) : undefined;
  if (ac && ac.until > now) aws = ac.value;
  else {
    const v = await verifyAws(h.aws, cfg, f as unknown as IdFetch, now).catch((e) => ({ ok: false as const, reason: `AWS verification failed: ${String((e as Error).message ?? e)}` }));
    if (!v.ok) return deny(login, 401, v.reason, { stage: "aws", google });
    aws = v.arn;
    put(awsCache, ak, { until: now + ID_TTL_MS, value: v.arn });
  }
  if (aws !== binding.aws) return deny(login, 403, `AWS identity ${aws} is not the one bound to ${login}`, { google, aws });

  // first success for this credential triple → one signin row
  const tk = sha(`${gk}|${gtk}|${ak}`);
  if (!denyCache.has(`ok:${tk}`)) {
    put(denyCache, `ok:${tk}`, now);
    await audit(login, true, { google, aws });
  }
  return {
    ok: true,
    session: { user: { name: gh.r.name ?? login, email: google, image: null }, login, accessToken: token, expires: new Date(now + GH_TTL_MS).toISOString(), via: "mcp", google, aws },
  };
}
