import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // The root Dockerfile's dashboard target copies .next/standalone + .next/static + public.
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, "../../"),
  // The write gate reads the same policy.yaml the MCP server enforces; make
  // sure it rides along into the standalone image (see src/server/nebula/deps.ts).
  // Also the generated Prisma client + query engine, which the bundler does
  // not trace out of the pnpm store (PrismaClientInitializationError otherwise).
  outputFileTracingIncludes: {
    "/**": ["../../node_modules/.pnpm/@prisma+client*/node_modules/.prisma/client/**"],
    "/api/trpc/[trpc]": ["../mcp/policy.yaml"],
    "/environments": ["../mcp/policy.yaml"],
  },
  transpilePackages: ["@twizz-idp/db", "@twizz-idp/shared", "@twizz-idp/actions", "@twizz-idp/core"],
  // Node-only client with dynamic requires; keep it out of the webpack bundle.
  serverExternalPackages: ["@kubernetes/client-node"],
};

export default nextConfig;
