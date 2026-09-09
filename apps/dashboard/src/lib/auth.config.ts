import type { NextAuthConfig } from "next-auth";
import GitHub from "next-auth/providers/github";

// Edge-safe config: imported by middleware. No Prisma / Node-only imports here.
export const authConfig = {
  providers: [
    GitHub({
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
      // Sign-in is a GitHub App (twizz-nebula, Iv23li…), and GitHub App callbacks
      // carry `iss=https://github.com/login/oauth`. Without this, @auth/core 0.37
      // compares that against its placeholder issuer and rejects the callback
      // ("unexpected iss response parameter value").
      issuer: "https://github.com/login/oauth",
      authorization: { params: { scope: "read:org repo read:user" } },
    }),
  ],
  // In-cluster the app sits behind ingress-nginx (nebula.prv.twizz.com), so the
  // Host header is the ingress's; NEXTAUTH_URL is the public origin.
  trustHost: true,
  pages: {
    signIn: "/",
  },
  callbacks: {
    authorized({ auth }) {
      return !!auth?.user;
    },
  },
} satisfies NextAuthConfig;
