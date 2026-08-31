import type { NextAuthConfig } from "next-auth";
import GitHub from "next-auth/providers/github";

// Edge-safe config: imported by middleware. No Prisma / Node-only imports here.
export const authConfig = {
  providers: [
    GitHub({
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
      authorization: { params: { scope: "read:org repo read:user" } },
    }),
  ],
  pages: {
    signIn: "/",
  },
  callbacks: {
    authorized({ auth }) {
      return !!auth?.user;
    },
  },
} satisfies NextAuthConfig;
