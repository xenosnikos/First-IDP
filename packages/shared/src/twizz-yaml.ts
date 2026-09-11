// twizz.yaml v2 — the per-repo Nebula config (docs/NEBULA.md §N3.7). Pure zod,
// browser-safe: the dashboard validates the editable text live, the
// Configurator uses it as its output contract, packages/actions renders gitops
// values from it. Text (YAML) I/O lives in @twizz-idp/actions.
import { z } from "zod/v4";

export const TWIZZ_PLACEHOLDERS = ["${NEBULA_API_URL}", "${NEBULA_SOCKET_URL}", "${NEBULA_ENV_URL}"] as const;

/** Build args are baked into images and visible to anyone with the image:
 * only public-by-design prefixes are allowed. Secrets go in `secrets`. */
export const BUILD_ARG_KEY_RE = /^(REACT_APP_[A-Z0-9_]+|VITE_[A-Z0-9_]+|NEXT_PUBLIC_[A-Z0-9_]+|NODE_ENV|BUILD_[A-Z0-9_]+)$/;
export const ENV_KEY_RE = /^[A-Z][A-Z0-9_]*$/;
/** Values that look like credentials must not appear in `env` (non-secret). */
export const SECRET_SHAPE_RE = /(^|[^A-Za-z0-9])(eyJ[A-Za-z0-9_-]{10,}\.|AKIA[0-9A-Z]{16}|sk-ant-|sk_live_|sk_test_|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-|mongodb(\+srv)?:\/\/[^:\s]+:[^@\s]+@)/;

const kind = z.enum(["backend", "frontend", "worker"]);

export const TwizzYamlV2 = z
  .object({
    version: z.literal(2),
    name: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/).optional(),
    kind,
    port: z.number().int().min(1).max(65535),
    healthPath: z.string().startsWith("/").max(200),
    dockerfile: z.string().min(1).max(200).default("Dockerfile"),
    context: z.string().min(1).max(200).default("."),
    build: z.object({ args: z.record(z.string(), z.string().max(2000)).default({}) }).default({ args: {} }),
    env: z.record(z.string(), z.string().max(4000)).default({}),
    secrets: z.array(z.string().regex(ENV_KEY_RE)).max(50).default([]),
    needs: z.object({ mongo: z.boolean().default(false), redis: z.boolean().default(false) }).default({ mongo: false, redis: false }),
    frontend: z
      .object({
        framework: z.enum(["cra", "vite", "next", "other"]),
        apiEnvVar: z.string().regex(ENV_KEY_RE),
        socketEnvVar: z.string().regex(ENV_KEY_RE).optional(),
        serve: z.enum(["static", "next-standalone", "node-server"]),
      })
      .optional(),
    attach: z.object({ backendService: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/) }).optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    for (const k of Object.keys(c.build.args)) {
      if (!BUILD_ARG_KEY_RE.test(k)) ctx.addIssue({ code: "custom", path: ["build", "args", k], message: `build arg "${k}" is not an allowed public build-time key (REACT_APP_*, VITE_*, NEXT_PUBLIC_*, NODE_ENV, BUILD_*); secrets belong in "secrets"` });
    }
    for (const [k, v] of Object.entries(c.env)) {
      if (!ENV_KEY_RE.test(k)) ctx.addIssue({ code: "custom", path: ["env", k], message: `env key "${k}" must be UPPER_SNAKE_CASE` });
      if (SECRET_SHAPE_RE.test(v)) ctx.addIssue({ code: "custom", path: ["env", k], message: `env "${k}" looks like a credential; list its NAME under "secrets" and set the value in the dashboard` });
      if (c.secrets.includes(k)) ctx.addIssue({ code: "custom", path: ["env", k], message: `"${k}" is both an env default and a secret name` });
    }
    if (c.kind === "frontend") {
      if (!c.frontend) ctx.addIssue({ code: "custom", path: ["frontend"], message: 'kind "frontend" requires a "frontend" block (framework, apiEnvVar, serve)' });
      else {
        const v = c.build.args[c.frontend.apiEnvVar];
        if (v === undefined) ctx.addIssue({ code: "custom", path: ["build", "args"], message: `build.args must set ${c.frontend.apiEnvVar} (frontend.apiEnvVar), e.g. "\${NEBULA_API_URL}"` });
        else if (!v.includes("${NEBULA_API_URL}")) ctx.addIssue({ code: "custom", path: ["build", "args", c.frontend.apiEnvVar], message: `${c.frontend.apiEnvVar} should use the \${NEBULA_API_URL} placeholder so Nebula can point the build at the attached backend` });
      }
    } else if (c.frontend) {
      ctx.addIssue({ code: "custom", path: ["frontend"], message: `"frontend" block only applies to kind "frontend"` });
    }
  });

export type TwizzYamlV2 = z.infer<typeof TwizzYamlV2>;
export type TwizzYamlV2Input = z.input<typeof TwizzYamlV2>;

/** The v1 marker file the onboarding CLI wrote: {name, kind, port?, healthPath?, secretName?}. */
export const TwizzYamlV1 = z
  .object({
    name: z.string(),
    kind: z.enum(["backend-k8s", "frontend-vercel", "lambda-sam", "backend", "frontend"]),
    port: z.number().int().optional(),
    healthPath: z.string().optional(),
    secretName: z.string().optional(),
  })
  .loose();
export type TwizzYamlV1 = z.infer<typeof TwizzYamlV1>;

export function fromLegacy(v1: TwizzYamlV1): TwizzYamlV2 {
  const k: TwizzYamlV2["kind"] = v1.kind === "frontend-vercel" || v1.kind === "frontend" ? "frontend" : "backend";
  const slug = v1.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").replace(/^[^a-z]+/, "").slice(0, 40);
  const base: TwizzYamlV2Input = {
    version: 2,
    ...(slug ? { name: slug } : {}),
    kind: k,
    port: v1.port ?? (k === "frontend" ? 80 : 8080),
    healthPath: v1.healthPath ?? (k === "frontend" ? "/" : "/health"),
  };
  if (k === "frontend") base.frontend = { framework: "other", apiEnvVar: "REACT_APP_API_ENDPOINT", serve: "static" };
  if (k === "frontend") base.build = { args: { REACT_APP_API_ENDPOINT: "${NEBULA_API_URL}" } };
  return TwizzYamlV2.parse(base);
}

/** Parse a decoded YAML/JSON object as v2, or upgrade a v1 object. */
export function parseTwizzObject(obj: unknown): { ok: true; config: TwizzYamlV2; legacy: boolean } | { ok: false; issues: string[] } {
  if (!obj || typeof obj !== "object") return { ok: false, issues: ["twizz.yaml is not a mapping"] };
  const o = obj as Record<string, unknown>;
  if (o.version === 2) {
    const r = TwizzYamlV2.safeParse(obj);
    if (r.success) return { ok: true, config: r.data, legacy: false };
    return { ok: false, issues: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  }
  const r1 = TwizzYamlV1.safeParse(obj);
  if (r1.success) {
    try {
      return { ok: true, config: fromLegacy(r1.data), legacy: true };
    } catch (e) {
      return { ok: false, issues: [`legacy twizz.yaml could not be upgraded: ${String((e as Error).message ?? e)}`] };
    }
  }
  return { ok: false, issues: ['twizz.yaml needs "version: 2" (or the legacy {name, kind} shape)'] };
}

/** Substitute Nebula placeholders in build args. Unknown `${...}` are left as-is. */
export function substituteBuildArgs(args: Record<string, string>, v: { apiUrl: string; socketUrl?: string; envUrl: string }): Record<string, string> {
  const map: Record<string, string> = { "${NEBULA_API_URL}": v.apiUrl, "${NEBULA_SOCKET_URL}": v.socketUrl ?? v.apiUrl, "${NEBULA_ENV_URL}": v.envUrl };
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(args)) out[k] = val.replace(/\$\{NEBULA_[A-Z_]+\}/g, (m) => map[m] ?? m);
  return out;
}
