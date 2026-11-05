// Read-only client for the twizz-sentinel API, per tier. Only GET, only the
// paths below, only with the READ key (SENTINEL_API_KEY tier — admin routes
// refuse it server-side too).
//   staging:     NEBULA_SENTINEL_STAGING_URL (default https://sentinel-stg.prv.twizz.com)
//                SENTINEL_STAGING_API_KEY  (scripts/nebula-set-sentinel-key.sh)
//   production:  NEBULA_SENTINEL_PROD_URL  (no default: prod sentinel has no ingress yet,
//                gitops apps/twizz-sentinel/values-prod.yaml) + SENTINEL_PROD_API_KEY
//                (scripts/nebula-set-sentinel-key.sh --prod). Unset = "not reachable" answer.

export const SENTINEL_TIERS = ["staging", "production"] as const;
export type SentinelTier = (typeof SENTINEL_TIERS)[number];

export type SentinelGet = (tier: SentinelTier, path: SentinelPath, query: Record<string, string | number | undefined>, actor: string) => Promise<unknown>;

export type SentinelPath = "alerts" | "alerts/stats" | `alerts/${string}` | `alerts/${string}/cases` | `alerts/${string}/similar` | "events" | "status";

const OBJECT_ID = /^[0-9a-f]{24}$/;
const ALLOWED = [/^alerts$/, /^alerts\/stats$/, /^alerts\/[0-9a-f]{24}$/, /^alerts\/[0-9a-f]{24}\/(cases|similar)$/, /^events$/, /^status$/];

export function isAllowedSentinelPath(path: string): boolean {
  return ALLOWED.some((re) => re.test(path));
}

export const isObjectId = (s: string) => OBJECT_ID.test(s);

export function sentinelEndpoint(tier: SentinelTier, env: NodeJS.ProcessEnv = process.env): { base: string; key: string } | { missing: string } {
  if (tier === "staging") {
    const key = env.SENTINEL_STAGING_API_KEY;
    if (!key) return { missing: "staging sentinel is not configured on this Nebula (SENTINEL_STAGING_API_KEY)" };
    return { base: (env.NEBULA_SENTINEL_STAGING_URL || "https://sentinel-stg.prv.twizz.com").replace(/\/$/, ""), key };
  }
  const base = env.NEBULA_SENTINEL_PROD_URL;
  const key = env.SENTINEL_PROD_API_KEY;
  if (!base || !key) return { missing: "production twizz-sentinel is not reachable from Nebula yet (not installed on EKS-Moly-Prod, or no endpoint: NEBULA_SENTINEL_PROD_URL / SENTINEL_PROD_API_KEY unset). Prod alerts go to Slack meanwhile." };
  return { base: base.replace(/\/$/, ""), key };
}

export function sentinelGet(f: typeof fetch = fetch): SentinelGet {
  return async (tier, path, query, actor) => {
    if (!isAllowedSentinelPath(path)) throw new Error(`sentinel path not allowed: ${path}`);
    const ep = sentinelEndpoint(tier);
    if ("missing" in ep) throw new Error(ep.missing);
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") qs.set(k, String(v));
    const url = `${ep.base}/api/v1/${path}${qs.size ? `?${qs}` : ""}`;
    const res = await f(url, { headers: { "x-api-key": ep.key, "x-actor": `nebula-mcp:${actor}`.slice(0, 80), accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${tier} sentinel ${res.status} on /${path}: ${text.slice(0, 300)}`);
    try {
      const body = JSON.parse(text) as { data?: unknown };
      return body && typeof body === "object" && "data" in body ? body.data : body;
    } catch {
      return text;
    }
  };
}
