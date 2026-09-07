import { defineConfig } from "vitest/config";
import path from "node:path";

// Unit tests for the pure Nebula pieces only (status words, operator
// allowlist, policy wiring). No Next runtime, no network.
export default defineConfig({
  test: { include: ["src/**/__tests__/**/*.test.ts"], environment: "node" },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
});
