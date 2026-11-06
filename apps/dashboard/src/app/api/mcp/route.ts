// Nebula's MCP endpoint (docs/NEBULA.md §N7): Streamable HTTP, stateless (one
// McpServer per request, JSON responses), Bearer = the person's own GitHub
// token. Reached on the VPN at https://nebula.prv.twizz.com/api/mcp through its
// own Ingress that skips the browser SSO gate (gitops apps/nebula/dashboard.yaml);
// auth here is the same allowlist as sign-in, and every tool runs the tRPC
// procedure as that person (server/mcp/tools.ts).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { prisma } from "@twizz-idp/db";
import { appRouter } from "@/server/routers/_app";
import { authenticateMcp } from "@/server/mcp/auth";
import { registerNebulaTools } from "@/server/mcp/tools";
import { sentinelGet } from "@/server/mcp/sentinel";
import { observerDeps } from "@/server/nebula/observer";
import { isOperator } from "@/lib/nebula/operators";
import type { Context } from "@/server/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const INSTRUCTIONS = [
  "Nebula: Twizz's internal developer platform. You act as the signed-in GitHub user; Nebula enforces who may do what.",
  "Reads cover EKS-Twizz-NonProd (previews, named envs), EKS-Moly-staging and EKS-Moly-Prod (logs, pods, nodes, monitor) plus twizz-sentinel alerts. Production is READ-ONLY: no tool changes it; writes are previews on NonProd and promotions to staging.",
  "Every write is two-step: the first call returns CONFIRMATION REQUIRED with a summary — show it to the user and only call again with confirm=<nonce> after they say yes. Never invent a nonce.",
  "Diagnosing: cluster_overview / list_pods → log_histogram to find the burst → fetch_logs (errorsOnly, filter) → get_group_samples. Builds: list_envs (build status) → ci_run / ci_job_logs in xenosnikos/First-IDP.",
].join("\n");

// Per-login scratch for Observer drill-down across stateless requests (bounded).
const notesByLogin = new Map<string, Record<string, unknown>>();
function notesFor(login: string): Record<string, unknown> {
  let n = notesByLogin.get(login);
  if (!n) {
    if (notesByLogin.size >= 200) notesByLogin.delete(notesByLogin.keys().next().value!);
    n = {};
    notesByLogin.set(login, n);
  }
  return n;
}

const jsonRpcError = (status: number, message: string) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: status === 401 ? -32001 : -32003, message }, id: null }), {
    status,
    headers: { "content-type": "application/json", ...(status === 401 ? { "www-authenticate": 'Bearer realm="nebula"' } : {}), ...(status === 503 ? { "retry-after": "5" } : {}) },
  });

export async function POST(req: Request): Promise<Response> {
  const auth = await authenticateMcp(
    { authorization: req.headers.get("authorization"), google: req.headers.get("x-nebula-google-token"), aws: req.headers.get("x-nebula-aws-sts") },
    { prisma },
  );
  if (!auth.ok) return jsonRpcError(auth.status, auth.reason);
  const { login, google, aws, scopes } = auth.session;
  // authority comes from the IDP, resolved here — never from anything the client sends
  const operator = isOperator(login);

  const ctx = { session: auth.session, prisma } as unknown as Context;
  const server = new McpServer({ name: "nebula", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  registerNebulaTools(server, {
    caller: appRouter.createCaller(ctx),
    login,
    operator,
    scopes,
    observer: observerDeps(),
    sentinel: sentinelGet(),
    notes: notesFor(login),
    audit: async (tool, args, ok, ms, error, intentId) => {
      await prisma.auditLog
        .create({ data: { actor: login, action: `mcp.tool.${tool}`, allowed: ok, resource: intentId, detail: JSON.parse(JSON.stringify({ google, aws, operator, scopes, args, ms, error, intentId })) } })
        .catch((e) => console.error(`[mcp] outcome audit failed for ${tool} intent=${intentId}:`, e));
    },
    // no .catch: a failure here must stop the write (tools.ts refuses it)
    intent: async (tool, args, intentId) => {
      await prisma.auditLog.create({ data: { actor: login, action: `mcp.intent.${tool}`, allowed: true, resource: intentId, detail: JSON.parse(JSON.stringify({ google, aws, operator, scopes, args, intentId })) } });
    },
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    // stateless: the response body is fully built (enableJsonResponse), so close now
    void server.close().catch(() => {});
  }
}

const notAllowed = () => new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless endpoint: POST only)" }, id: null }), { status: 405, headers: { allow: "POST", "content-type": "application/json" } });
export const GET = notAllowed;
export const DELETE = notAllowed;
