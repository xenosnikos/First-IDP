// Read-only client for the twizz-sentinel API, per tier. Only GET, only the
// paths below, only with the READ key (SENTINEL_API_KEY tier — admin routes
// refuse it server-side too).
//   staging:     NEBULA_SENTINEL_STAGING_URL (default https://sentinel-stg.prv.twizz.com)
//                SENTINEL_STAGING_API_KEY  (scripts/nebula-set-sentinel-key.sh)
//   production:  SENTINEL_PROD_API_KEY (SM prod/twizz-sentinel SENTINEL_API_KEY, copied into
//                preview/nebula by scripts/nebula-set-sentinel-key.sh --prod). Prod sentinel has NO
//                ingress: Nebula reaches it through the EKS-Moly-Prod API server's service proxy
//                (dashboard IRSA → group nebula-capacity; RBAC infra/k8s/nebula-sentinel-proxy-rbac.yaml
//                = get services/proxy on ONE service, ns sentinel). NEBULA_SENTINEL_PROD_URL, when
//                set, overrides with a direct URL. Key unset = "not reachable" answer.

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

export const PROD_CLUSTER = "EKS-Moly-Prod";
export const PROD_SENTINEL_PROXY = "/api/v1/namespaces/sentinel/services/twizz-sentinel:http/proxy";

export type Endpoint = { base: string; key: string; via?: "kube-proxy" } | { missing: string };

export function sentinelEndpoint(tier: SentinelTier, env: NodeJS.ProcessEnv = process.env): Endpoint {
  if (tier === "staging") {
    const key = env.SENTINEL_STAGING_API_KEY;
    if (!key) return { missing: "staging sentinel is not configured on this Nebula (SENTINEL_STAGING_API_KEY)" };
    return { base: (env.NEBULA_SENTINEL_STAGING_URL || "https://sentinel-stg.prv.twizz.com").replace(/\/$/, ""), key };
  }
  const key = env.SENTINEL_PROD_API_KEY;
  if (!key) return { missing: "production twizz-sentinel is not configured on this Nebula (SENTINEL_PROD_API_KEY unset). Prod alerts go to Slack meanwhile." };
  const base = env.NEBULA_SENTINEL_PROD_URL;
  return base ? { base: base.replace(/\/$/, ""), key } : { base: PROD_SENTINEL_PROXY, key, via: "kube-proxy" };
}

/** GET through the prod API server's service proxy (TLS pinned to the cluster CA). */
export type KubeProxyGet = (path: string, headers: Record<string, string>) => Promise<{ status: number; text: string }>;

export function prodKubeProxyGet(): KubeProxyGet {
  return async (path, headers) => {
    const { eksAccess } = await import("@twizz-idp/core");
    const https = await import("node:https");
    const a = await eksAccess(PROD_CLUSTER);
    const url = new URL(path, a.server);
    const MAX_BYTES = 2_000_000;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (err: Error | null, v?: { status: number; text: string }) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (err) {
          req.destroy();
          reject(err);
        } else resolve(v!);
      };
      // absolute deadline (the socket timeout below only catches idleness)
      const timer = setTimeout(() => finish(new Error("prod sentinel proxy timed out after 20s")), 20_000);
      const req = https.request(url, { method: "GET", ca: Buffer.from(a.caData, "base64"), headers: { ...headers, authorization: `Bearer ${a.token}` }, timeout: 20_000 }, (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", (c: Buffer) => {
          bytes += c.length;
          if (bytes > MAX_BYTES) return finish(new Error(`prod sentinel response over ${MAX_BYTES} bytes — narrow the query`));
          chunks.push(c);
        });
        res.on("end", () => finish(null, { status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", (e) => finish(e));
        res.on("aborted", () => finish(new Error("prod sentinel response aborted")));
      });
      req.on("timeout", () => finish(new Error("prod sentinel proxy idle for 20s")));
      req.on("error", (e) => finish(e));
      req.end();
    });
  };
}

export function sentinelGet(f: typeof fetch = fetch, kube: KubeProxyGet = prodKubeProxyGet()): SentinelGet {
  return async (tier, path, query, actor) => {
    if (!isAllowedSentinelPath(path)) throw new Error(`sentinel path not allowed: ${path}`);
    const ep = sentinelEndpoint(tier);
    if ("missing" in ep) throw new Error(ep.missing);
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") qs.set(k, String(v));
    const url = `${ep.base}/api/v1/${path}${qs.size ? `?${qs}` : ""}`;
    const headers = { "x-api-key": ep.key, "x-actor": `nebula-mcp:${actor}`.slice(0, 80), accept: "application/json" };
    let status: number;
    let text: string;
    if ("via" in ep && ep.via === "kube-proxy") ({ status, text } = await kube(url, headers));
    else {
      const res = await f(url, { headers, signal: AbortSignal.timeout(20_000) });
      status = res.status;
      text = await res.text();
    }
    if (status < 200 || status >= 300) throw new Error(`${tier} sentinel ${status} on /${path}: ${text.slice(0, 300)}`);
    let body: { data?: unknown };
    try {
      body = JSON.parse(text) as { data?: unknown };
    } catch {
      throw new Error(`${tier} sentinel returned a non-JSON body on /${path} (${text.length} chars)`);
    }
    return body && typeof body === "object" && "data" in body ? body.data : body;
  };
}
