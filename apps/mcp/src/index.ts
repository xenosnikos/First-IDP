#!/usr/bin/env tsx
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { activateReadonlyCreds } from "./auth.js";
import { registerReadTools } from "./tools/read.js";
import { registerWriteTools } from "./tools/write.js";

async function main() {
  // Swap ambient profile creds for the scoped readonly role BEFORE any AWS
  // client (including @twizz-idp/core singletons) is constructed.
  try {
    await activateReadonlyCreds();
  } catch (e) {
    console.error("[twizz-mcp] failed to assume twizz-mcp-readonly — AWS tools will fail:", e);
  }

  const server = new McpServer({ name: "twizz-platform", version: "0.1.0" });
  registerReadTools(server);
  registerWriteTools(server);

  await server.connect(new StdioServerTransport());
  console.error("[twizz-mcp] ready (stdio)");
}

main().catch((e) => {
  console.error("[twizz-mcp] fatal:", e);
  process.exit(1);
});
