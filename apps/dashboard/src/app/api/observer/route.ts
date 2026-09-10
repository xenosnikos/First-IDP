// POST /api/observer — the Observer run, streamed as server-sent events.
// The first streaming surface in Nebula: tRPC's batch link cannot stream
// tokens, so this Route Handler sits beside /api/trpc with the same auth().
// Read-only: scope is validated here and fixed for the run; tools cannot
// widen it. Every run writes an AuditLog row (see server/nebula/observer.ts).
import { z } from "zod";
import { auth } from "@/lib/auth";
import { prisma } from "@twizz-idp/db";
import { LOG_NAME_RE } from "@twizz-idp/core";
import { createObserverClient, runObserver, type ObserverEvent } from "@twizz-idp/observer";
import { CLUSTERS } from "@/server/routers/clusters";
import { auditObserverRun, observerConfigured, observerDeps, observerStatus } from "@/server/nebula/observer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const clusterNames = CLUSTERS.map((c) => c.name) as [string, ...string[]];
const k8s = (max: number) => z.string().min(1).max(max).regex(LOG_NAME_RE);

const bodySchema = z.object({
  scope: z.object({
    cluster: z.enum(clusterNames),
    namespace: k8s(63),
    pod: k8s(253).optional(),
    from: z.string().datetime(),
    to: z.string().datetime(),
  }),
  kind: z.enum(["summarize", "errors", "explain", "chat"]),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(8000) })).max(20).optional(),
  selection: z.string().max(20_000).optional(),
  userText: z.string().max(4000).optional(),
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function POST(req: Request): Promise<Response> {
  const session = await auth();
  const login = (session as { login?: string } | null)?.login;
  if (!session?.user || !login) return json(401, { word: "DENIED", message: "sign in first" });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json(400, { word: "FAIL", message: "invalid request", issues: parsed.error.issues.slice(0, 5) });
  const { scope, kind, history, selection, userText } = parsed.data;

  const from = Date.parse(scope.from);
  const to = Date.parse(scope.to);
  if (!(to > from) || to - from > 24 * 3600_000 || to > Date.now() + 60_000) return json(400, { word: "FAIL", message: "window must be within the last 24 h and end no later than now" });
  if (kind === "explain" && !selection) return json(400, { word: "FAIL", message: "explain needs a selection" });
  if (kind === "chat" && !userText?.trim()) return json(400, { word: "FAIL", message: "chat needs a question" });

  if (!observerConfigured()) return json(503, { word: "STUB", message: "ANTHROPIC_API_KEY is not configured on this Nebula" });

  const status = await observerStatus(prisma, login);
  if (status.word === "DENIED") {
    await auditObserverRun(prisma, { login, kind, scope, allowed: false, detail: { reason: status.reason } });
    return json(429, { word: "DENIED", message: status.reason });
  }

  const client = createObserverClient();
  if (!client) return json(503, { word: "STUB", message: "ANTHROPIC_API_KEY is not configured on this Nebula" });

  const encoder = new TextEncoder();
  const controllerRef: { c?: ReadableStreamDefaultController<Uint8Array> } = {};
  const abort = new AbortController();
  const onClientAbort = () => abort.abort();
  req.signal.addEventListener("abort", onClientAbort);

  const send = (e: ObserverEvent) => {
    try {
      controllerRef.c?.enqueue(encoder.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
    } catch {
      /* stream closed */
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controllerRef.c = c;
      const ping = setInterval(() => {
        try {
          c.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          clearInterval(ping);
        }
      }, 15_000);

      (async () => {
        const started = Date.now();
        try {
          const result = await runObserver({
            client,
            scope,
            deps: observerDeps(),
            kind,
            history,
            selection,
            userText,
            onEvent: send,
            signal: abort.signal,
            model: process.env.OBSERVER_MODEL || undefined,
          });
          await auditObserverRun(prisma, {
            login,
            kind,
            scope,
            allowed: true,
            detail: { model: result.model, usage: result.usage, toolCalls: result.toolCalls.map((t) => ({ name: t.name, input: t.input, ms: t.ms })), iterations: result.iterations, stopReason: result.stopReason, redacted: result.redactions, durationMs: result.durationMs },
          });
          send({ type: "done", word: "PASS", text: result.text });
        } catch (e) {
          const aborted = abort.signal.aborted;
          const message = aborted ? "stopped" : String((e as Error).message ?? e);
          await auditObserverRun(prisma, { login, kind, scope, allowed: true, detail: { error: message, aborted, durationMs: Date.now() - started } });
          send({ type: "error", word: "FAIL", message });
        } finally {
          clearInterval(ping);
          req.signal.removeEventListener("abort", onClientAbort);
          try {
            c.close();
          } catch {
            /* already closed */
          }
        }
      })();
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    },
  });
}
