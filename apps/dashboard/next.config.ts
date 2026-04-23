import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@twizz-idp/db", "@twizz-idp/shared"],
};

export default nextConfig;
