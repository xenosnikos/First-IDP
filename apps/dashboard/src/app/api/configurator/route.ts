// POST /api/configurator — one Configurator run, streamed as server-sent
// events (same shape as /api/observer). Read-only: it reads ONE repo at ONE
// pinned commit with the human's own GitHub token and returns a proposal the
// drawer shows; nothing is written anywhere. Every run writes an AuditLog row.
import { z } from "zod";
import { auth } from "@/lib/auth";
import { prisma } from "@twizz-idp/db";
import { createObserverClient, runConfigurator, type ConfiguratorEvent } from "@twizz-idp/observer";
import { auditConfiguratorRun, auditToolCalls, configuratorStatus, repoReaderFor } from "@/server/nebula/configurator";
import { githubFor, orgRepo } from "@/server/routers/project";
import { platformToken, sessionToken } from "@/server/nebula/github-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const bodySchema = z.object({
  repo: z.string().max(200),
  ref: z.string().max(120),
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  hints: z.string().max(2000).optional(),
  kindHint: z.enum(["backend", "frontend", "worker"]).optional(),
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function POST(req: Request): Promise<Response> {
  const session = await auth();
  const login = (session as { login?: string } | null)?.login;
  if (!session?.user || !login) return json(401, { word: "DENIED", message: "sign in first" });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json(400, { word: "FAIL", message: "invalid request", issues: parsed.error.issues.slice(0, 5) });
  const { ref, sha, hints, kindHint } = parsed.data;
  let target: ReturnType<typeof orgRepo>;
  try {
    target = orgRepo(parsed.data.repo);
  } catch (e) {
    return json(400, { word: "FAIL", message: String((e as Error).message ?? e) });
  }

  const status = await configuratorStatus(prisma, login);
  if (!status.configured) return json(503, { word: "STUB", message: status.reason });
  if (status.word === "DENIED") {
    await auditConfiguratorRun(prisma, { login, repo: target.slug, ref, sha, allowed: false, detail: { reason: status.reason } });
    return json(429, { word: "DENIED", message: status.reason });
  }

  // the branch must still point at the pinned commit — otherwise the proposal would describe a different tree
  let gh: ReturnType<typeof githubFor>;
  try {
    gh = githubFor({ session });
  } catch (e) {
    return json(401, { word: "DENIED", message: String((e as Error).message ?? e) });
  }
  const head = await gh((g) => g.getBranchHead(target.owner, target.repo, ref)).catch(() => null);
  if (!head) return json(404, { word: "FAIL", message: `branch "${ref}" not found in ${target.slug} (or not readable with your GitHub grant)` });
  if (head.sha !== sha) return json(409, { word: "FAIL", message: `${ref} moved since you pinned it (${sha.slice(0, 7)} → ${head.sha.slice(0, 7)}); reload the branch and run again` });

  const client = createObserverClient();
  if (!client) return json(503, { word: "STUB", message: "ANTHROPIC_API_KEY is not configured on this Nebula" });
  // the Configurator reads with the human's grant; the org-scoped platform token only when that grant is gone
  const token = sessionToken(session) ?? platformToken();
  if (!token) return json(401, { word: "DENIED", message: "no GitHub token on the session and none on the server — sign in again" });

  const encoder = new TextEncoder();
  const controllerRef: { c?: ReadableStreamDefaultController<Uint8Array> } = {};
  const abort = new AbortController();
  const onClientAbort = () => abort.abort();
  req.signal.addEventListener("abort", onClientAbort);
  const send = (e: ConfiguratorEvent) => {
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
          const result = await runConfigurator({
            client,
            repo: target.slug,
            ref,
            sha,
            reader: repoReaderFor(token, target.owner, target.repo, sha),
            hints,
            kindHint,
            onEvent: send,
            signal: abort.signal,
            model: process.env.CONFIGURATOR_MODEL || process.env.OBSERVER_MODEL || undefined,
          });
          await auditConfiguratorRun(prisma, {
            login,
            repo: target.slug,
            ref,
            sha,
            allowed: true,
            detail: { model: result.model, usage: result.usage, toolCalls: auditToolCalls(result.toolCalls), iterations: result.iterations, stopReason: result.stopReason, proposed: !!result.proposal, confidence: result.proposal?.confidence, rejected: result.rejected, redacted: result.redactions, durationMs: result.durationMs },
          });
          if (result.proposal) send({ type: "done", word: "PASS", text: result.text });
          else send({ type: "error", word: "FAIL", message: `no proposal after ${result.iterations} turns${result.rejected ? ` (${result.rejected} rejected)` : ""}: ${result.text.slice(0, 400) || "the model stopped without calling propose_config"}` });
        } catch (e) {
          const aborted = abort.signal.aborted;
          const message = aborted ? "stopped" : String((e as Error).message ?? e);
          await auditConfiguratorRun(prisma, { login, repo: target.slug, ref, sha, allowed: true, detail: { error: message, aborted, durationMs: Date.now() - started } });
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
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no", connection: "keep-alive" },
  });
}
