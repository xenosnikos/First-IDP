// GitHub App user-to-server tokens (the in-cluster sign-in is the `twizz-nebula`
// App) expire after 8 hours and come with a 6-month refresh token. Auth.js
// stores what the token endpoint returned at sign-in and nothing else, while
// the session cookie lives for weeks — so every GitHub read on the session
// token started failing with "Bad credentials" a work-day after sign-in.
// This module is the pure half of the fix: decide when to refresh and do it.
// The jwt callback in lib/auth.ts calls it; readers fall back to the platform
// token when `accessToken` is gone (server/nebula/github-session.ts).

export type GithubTokenState = {
  accessToken?: string;
  refreshToken?: string;
  /** epoch SECONDS (what @auth/core puts in account.expires_at) */
  expiresAt?: number;
  /** set when a refresh failed; cleared on the next successful one */
  tokenError?: string;
};

/** Refresh this many seconds before the deadline so an in-flight request never straddles it. */
export const REFRESH_SKEW_S = 120;

export const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";

/** True when the token has a known expiry and it is (nearly) here. Tokens
 * without `expiresAt` (classic OAuth app, expiration disabled on the App) never refresh. */
export function needsRefresh(t: Pick<GithubTokenState, "expiresAt" | "refreshToken">, nowS = Math.floor(Date.now() / 1000)): boolean {
  if (!t.expiresAt || !t.refreshToken) return false;
  return nowS >= t.expiresAt - REFRESH_SKEW_S;
}

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };

/** Exchange the refresh token. On failure the access token is DROPPED (never
 * kept dead) and `tokenError` set, so callers fall back honestly. */
export async function refreshGithubToken(
  t: GithubTokenState,
  opts: { clientId: string; clientSecret: string; fetchFn?: typeof fetch; nowS?: number },
): Promise<GithubTokenState> {
  const fetchFn = opts.fetchFn ?? fetch;
  const nowS = opts.nowS ?? Math.floor(Date.now() / 1000);
  if (!t.refreshToken) return { ...t, accessToken: undefined, tokenError: "no refresh token" };
  try {
    const res = await fetchFn(GITHUB_TOKEN_URL, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        grant_type: "refresh_token",
        refresh_token: t.refreshToken,
      }).toString(),
    });
    const body = (await res.json().catch(() => ({}))) as TokenResponse;
    if (!res.ok || !body.access_token) {
      const why = body.error_description ?? body.error ?? `HTTP ${res.status}`;
      return { ...t, accessToken: undefined, tokenError: `refresh failed: ${why}` };
    }
    return {
      accessToken: body.access_token,
      // GitHub rotates the refresh token on every use; keep the old one only if none came back
      refreshToken: body.refresh_token ?? t.refreshToken,
      expiresAt: typeof body.expires_in === "number" ? nowS + body.expires_in : undefined,
      tokenError: undefined,
    };
  } catch (e) {
    return { ...t, accessToken: undefined, tokenError: `refresh failed: ${String((e as Error).message ?? e)}` };
  }
}
