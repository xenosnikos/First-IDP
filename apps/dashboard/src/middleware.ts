export { auth as middleware } from "@/lib/auth";

export const config = {
  matcher: [
    "/projects/:path*",
    "/releases/:path*",
    "/pipelines/:path*",
  ],
};
