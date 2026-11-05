// Who may use Nebula, decided from a GitHub login + that user's own token.
// Shared by the Auth.js signIn callback (lib/auth.ts) and the MCP endpoint
// (server/mcp/auth.ts) so the browser and an MCP client admit exactly the
// same people. No Prisma, no Next: plain fetch, injectable for tests.

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const TIMEOUT_MS = 10_000;

const list = (raw: string | undefined, fallback = "") =>
  (raw ?? fallback)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** Orgs whose active members may sign in (default twizz-app). */
export function allowedOrgs(raw: string | undefined = process.env.ALLOWED_GITHUB_ORGS): string[] {
  return list(raw, "twizz-app");
}

/** Per-user allowlist (what actually admits people in-cluster today). Lower-cased. */
export function allowedLogins(raw: string | undefined = process.env.ALLOWED_GITHUB_LOGINS): string[] {
  return list(raw).map((s) => s.toLowerCase());
}

const ghHeaders = (token: string) => ({ Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" });

export async function isOrgMember(accessToken: string, org: string, f: FetchLike = fetch): Promise<boolean> {
  // The user's own token: read:org lets them read their own membership.
  const res = await f(`https://api.github.com/user/memberships/orgs/${encodeURIComponent(org)}`, { headers: ghHeaders(accessToken), signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) return false;
  const body = (await res.json()) as { state?: string };
  return body.state === "active";
}

/** Allowlisted login, or an active member of one of the allowed orgs. */
export async function isAllowedGithubUser(login: string, accessToken: string, f: FetchLike = fetch, env: { orgs?: string; logins?: string } = {}): Promise<boolean> {
  if (allowedLogins(env.logins ?? process.env.ALLOWED_GITHUB_LOGINS).includes(login.toLowerCase())) return true;
  for (const org of allowedOrgs(env.orgs ?? process.env.ALLOWED_GITHUB_ORGS)) {
    if (await isOrgMember(accessToken, org, f)) return true;
  }
  return false;
}

/** The login a token belongs to, or null if GitHub refuses the token. */
export async function githubLoginOf(accessToken: string, f: FetchLike = fetch): Promise<{ login: string; name: string | null } | null> {
  const res = await f("https://api.github.com/user", { headers: ghHeaders(accessToken), signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) return null;
  const body = (await res.json()) as { login?: string; name?: string | null };
  return body.login ? { login: body.login.toLowerCase(), name: body.name ?? null } : null;
}
