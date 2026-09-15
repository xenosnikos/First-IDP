// The Configurator's output contract. The tool INPUT schema is loose (every
// defaulted field optional, so the JSON schema the model sees is small); the
// accepted proposal is the strict TwizzYamlV2 after parseTwizzObject.
import { z } from "zod/v4";
import { parseTwizzObject, type TwizzYamlV2 } from "@twizz-idp/shared";
import type { Proposal } from "./types";

export const DOCKERFILE_CAP = 12_000;

const kind = z.enum(["backend", "frontend", "worker"]);

export const TwizzYamlInput = z
  .object({
    version: z.literal(2),
    name: z.string().optional().describe("Service slug; defaults to the repo name"),
    kind,
    port: z.number().int().describe("The port the container listens on (cite where you saw it)"),
    healthPath: z.string().describe("HTTP path that returns 2xx when the process is ready, e.g. /health or /"),
    dockerfile: z.string().optional().describe("Path relative to context; default Dockerfile"),
    context: z.string().optional().describe("Build context; default ."),
    build: z.object({ args: z.record(z.string(), z.string()).optional().describe("PUBLIC build-time args only (REACT_APP_*, VITE_*, NEXT_PUBLIC_*, NODE_ENV, BUILD_*)") }).optional(),
    env: z.record(z.string(), z.string()).optional().describe("Non-secret runtime defaults"),
    secrets: z.array(z.string()).optional().describe("NAMES of runtime env vars the human must provide (never values)"),
    needs: z.object({ mongo: z.boolean().optional(), redis: z.boolean().optional() }).optional(),
    frontend: z
      .object({
        framework: z.enum(["cra", "vite", "next", "other"]),
        apiEnvVar: z.string().describe("The build arg that carries the API base URL"),
        socketEnvVar: z.string().optional(),
        serve: z.enum(["static", "next-standalone", "node-server"]),
      })
      .optional(),
    attach: z.object({ backendService: z.string() }).optional(),
  })
  .strict();

export const ProposalInput = z
  .object({
    twizzYaml: TwizzYamlInput,
    dockerfile: z
      .object({
        path: z.string().describe("Relative to the repo root, e.g. Dockerfile"),
        content: z.string().max(DOCKERFILE_CAP),
        reason: z.string().max(500).describe("Why the repo needs this file (missing, or why the existing one cannot be used)"),
      })
      .optional()
      .describe("Only when the repo has no usable Dockerfile"),
    notes: z.array(z.string().max(300)).max(10).optional().describe("Short facts the human should know"),
    basedOn: z.array(z.string().max(200)).max(20).optional().describe("Files/lines the proposal is derived from, e.g. package.json scripts.start, src/main.ts:12"),
    confidence: z.enum(["high", "medium", "low"]),
    needsHuman: z.array(z.string().max(300)).max(10).optional().describe("Decisions you could not make from the code (values, ports you guessed, …)"),
  })
  .strict();

export type ProposalInput = z.infer<typeof ProposalInput>;

export type ProposalCheck = { ok: true; proposal: Proposal } | { ok: false; issues: string[] };

/** Strict validation of a tool call: schema, then the twizz.yaml refinements,
 * then the cross-checks a Dockerfile proposal must pass. */
export function checkProposal(raw: unknown): ProposalCheck {
  const r = ProposalInput.safeParse(raw);
  if (!r.success) return { ok: false, issues: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).slice(0, 12) };
  const p = r.data;
  const cfg = parseTwizzObject(p.twizzYaml);
  if (!cfg.ok) return { ok: false, issues: cfg.issues.map((i) => `twizzYaml.${i}`) };
  const twizzYaml: TwizzYamlV2 = cfg.config;
  const issues: string[] = [];
  if (p.dockerfile) {
    const expected = `${twizzYaml.context === "." ? "" : twizzYaml.context.replace(/\/$/, "") + "/"}${twizzYaml.dockerfile}`;
    if (p.dockerfile.path !== expected) issues.push(`dockerfile.path "${p.dockerfile.path}" must equal context + dockerfile from twizzYaml ("${expected}")`);
    if (!/^\s*FROM\s/m.test(p.dockerfile.content)) issues.push("dockerfile.content has no FROM instruction");
    if (/^\s*(ENV|ARG)\s+\w*(SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE)/im.test(p.dockerfile.content)) issues.push("dockerfile.content bakes a credential-looking ENV/ARG; secrets are runtime env vars set by Nebula");
    for (const k of Object.keys(twizzYaml.build.args)) if (!new RegExp(`^\\s*ARG\\s+${k}\\b`, "m").test(p.dockerfile.content)) issues.push(`build arg ${k} is declared in twizzYaml but the Dockerfile never declares "ARG ${k}"`);
  }
  if (twizzYaml.kind === "frontend" && !twizzYaml.frontend) issues.push("frontend kind needs the frontend block");
  if (issues.length) return { ok: false, issues };
  return {
    ok: true,
    proposal: { twizzYaml, dockerfile: p.dockerfile, notes: p.notes ?? [], basedOn: p.basedOn ?? [], confidence: p.confidence, needsHuman: p.needsHuman ?? [] },
  };
}
