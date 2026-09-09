import NextAuth from "next-auth";
import { authConfig } from "@/lib/auth.config";

// Edge middleware uses the edge-safe config only (no Prisma).
export const { auth: middleware } = NextAuth(authConfig);

export const config = {
  matcher: ["/projects/:path*", "/environments/:path*", "/pipelines/:path*", "/clusters/:path*"],
};
