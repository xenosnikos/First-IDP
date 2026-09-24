import NextAuth from "next-auth";
import { prisma } from "@twizz-idp/db";
import { authConfig } from "./auth.config";
import { needsRefresh, refreshGithubToken, type GithubTokenState } from "./github-token";

// Orgs whose active members may sign in. Emergency/per-user fallback:
// ALLOWED_GITHUB_LOGINS="alice,bob" for collaborators outside both orgs.
const ALLOWED_ORGS = (process.env.ALLOWED_GITHUB_ORGS ?? "twizz-app")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const ALLOWED_LOGINS = (process.env.ALLOWED_GITHUB_LOGINS ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

async function isOrgMember(accessToken: string, org: string): Promise<boolean> {
  // Uses the user's own token: read:org lets them read their own membership.
  const res = await fetch(`https://api.github.com/user/memberships/orgs/${org}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) return false;
  const body = (await res.json()) as { state?: string };
  return body.state === "active";
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  callbacks: {
    ...authConfig.callbacks,
    async signIn({ user, account, profile }) {
      const login = (profile?.login as string | undefined)?.toLowerCase();
      const accessToken = account?.access_token;
      if (!login || !accessToken) return false;

      let allowed = ALLOWED_LOGINS.includes(login);
      if (!allowed) {
        for (const org of ALLOWED_ORGS) {
          if (await isOrgMember(accessToken, org)) {
            allowed = true;
            break;
          }
        }
      }

      const dbUser = await prisma.user
        .upsert({
          where: { githubLogin: login },
          create: {
            githubLogin: login,
            githubId: profile?.id != null ? String(profile.id) : null,
            name: user.name ?? null,
            email: user.email ?? null,
            avatarUrl: user.image ?? null,
            lastLoginAt: allowed ? new Date() : null,
          },
          update: allowed ? { lastLoginAt: new Date() } : {},
        })
        .catch(() => null); // DB down must not turn into an auth bypass or hard 500

      await prisma.auditLog
        .create({
          data: {
            userId: dbUser?.id,
            actor: login,
            action: "signin",
            allowed,
          },
        })
        .catch(() => {});

      return allowed;
    },
    async jwt({ token, account, profile }) {
      if (account) {
        // Sign-in: keep the whole grant. GitHub App user tokens expire in 8 h
        // and come with a refresh token; classic OAuth tokens have neither.
        token.accessToken = account.access_token;
        token.refreshToken = account.refresh_token;
        token.expiresAt = account.expires_at;
        delete token.tokenError;
      }
      if (profile?.login) {
        token.login = (profile.login as string).toLowerCase();
      }
      const state = token as GithubTokenState;
      if (needsRefresh(state)) {
        // Refresh in place. On failure the access token is dropped (never
        // kept dead) so readers fall back to the platform token honestly.
        const next = await refreshGithubToken(state, { clientId: process.env.GITHUB_CLIENT_ID ?? "", clientSecret: process.env.GITHUB_CLIENT_SECRET ?? "" });
        token.accessToken = next.accessToken;
        token.refreshToken = next.refreshToken;
        token.expiresAt = next.expiresAt;
        if (next.tokenError) token.tokenError = next.tokenError;
        else delete token.tokenError;
      }
      return token;
    },
    async session({ session, token }) {
      (session as any).accessToken = token.accessToken;
      (session as any).tokenError = token.tokenError;
      (session as any).login = token.login;
      return session;
    },
  },
});
