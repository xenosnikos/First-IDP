import { TRPCError } from "@trpc/server";
import { GitHubService } from "@twizz-idp/core";

// Which GitHub token a read runs on. Reads prefer the SESSION token (the
// human's own GitHub App grant, so people only configure what they can see on
// github.com); the platform token (SM preview/github, org-scoped) is the
// fallback when the grant is gone — expired and not refreshable, revoked, or
// the App installation lost the repo. A 401 on the session token is retried
// ONCE on the platform token instead of surfacing "Bad credentials".
// Writes never come through here: they use the platform token via deps.ts.

export type TokenSource = "session" | "platform";

export function sessionToken(session: unknown): string | undefined {
  const s = session as { accessToken?: string; tokenError?: string } | null;
  return s?.accessToken || undefined;
}

export function platformToken(): string | undefined {
  return process.env.GITHUB_TOKEN || undefined;
}

export function isUnauthorized(e: unknown): boolean {
  const status = (e as { status?: number; response?: { status?: number } })?.status ?? (e as { response?: { status?: number } })?.response?.status;
  return status === 401;
}

/** Run `fn` with a GitHubService: session token first, platform token on a
 * 401 or when the session has none. Throws UNAUTHORIZED only when neither exists. */
export async function withGithub<T>(session: unknown, fn: (gh: GitHubService, source: TokenSource) => Promise<T>): Promise<T> {
  const own = sessionToken(session);
  const platform = platformToken();
  if (own) {
    try {
      return await fn(new GitHubService(own), "session");
    } catch (e) {
      if (!isUnauthorized(e) || !platform) throw e;
    }
  }
  if (!platform) {
    const why = (session as { tokenError?: string } | null)?.tokenError;
    throw new TRPCError({ code: "UNAUTHORIZED", message: why ? `GitHub grant unavailable (${why}) and no platform token — sign in again` : "no GitHub token on the session — sign in again" });
  }
  return fn(new GitHubService(platform), "platform");
}
