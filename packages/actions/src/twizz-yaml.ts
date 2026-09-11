// twizz.yaml text I/O (the schema itself lives in @twizz-idp/shared so the
// browser can validate without the yaml dependency).
import { Document as YamlDocument, parse as parseYaml } from "yaml";
import { parseTwizzObject, TwizzYamlV2, type TwizzYamlV2 as TwizzConfig } from "@twizz-idp/shared";

export type { TwizzConfig };

export type ParsedTwizz = { ok: true; config: TwizzConfig; legacy: boolean } | { ok: false; issues: string[] };

export function parseTwizzYaml(text: string): ParsedTwizz {
  let obj: unknown;
  try {
    obj = parseYaml(text);
  } catch (e) {
    return { ok: false, issues: [`YAML: ${String((e as Error).message ?? e).split("\n")[0]}`] };
  }
  return parseTwizzObject(obj);
}

const KEY_ORDER = ["version", "name", "kind", "port", "healthPath", "dockerfile", "context", "build", "env", "secrets", "needs", "frontend", "attach"] as const;

/** Stable key order, defaults omitted when they equal the schema default. */
export function stringifyTwizzYaml(config: TwizzConfig): string {
  const c = TwizzYamlV2.parse(config);
  const out: Record<string, unknown> = {};
  for (const k of KEY_ORDER) {
    const v = (c as Record<string, unknown>)[k];
    if (v === undefined) continue;
    if (k === "dockerfile" && v === "Dockerfile") continue;
    if (k === "context" && v === ".") continue;
    if (k === "build" && Object.keys(c.build.args).length === 0) continue;
    if (k === "env" && Object.keys(c.env).length === 0) continue;
    if (k === "secrets" && c.secrets.length === 0) continue;
    if (k === "needs" && !c.needs.mongo && !c.needs.redis) continue;
    out[k] = v;
  }
  const doc = new YamlDocument(out);
  doc.commentBefore = " Nebula per-repo config (docs/NEBULA.md §N3.7). Secrets are NAMES only; values live in the Nebula dashboard.";
  return doc.toString({ lineWidth: 0 });
}

/** Defaults for a repo with a Dockerfile but no twizz.yaml. */
export function defaultTwizzConfig(kind: TwizzConfig["kind"] = "backend"): TwizzConfig {
  return TwizzYamlV2.parse(kind === "frontend"
    ? { version: 2, kind, port: 80, healthPath: "/", build: { args: { REACT_APP_API_ENDPOINT: "${NEBULA_API_URL}" } }, frontend: { framework: "other", apiEnvVar: "REACT_APP_API_ENDPOINT", serve: "static" } }
    : { version: 2, kind, port: 8080, healthPath: "/health" });
}
