// Platform service layer, shared by the dashboard (read-only UI) and the MCP
// server. External API wrappers only — no Prisma, no Next.js.
export * from "./github";
export * from "./aws";
export * from "./insights-query";
export * from "./vercel";
export * from "./atlas";
export * from "./introspect";
