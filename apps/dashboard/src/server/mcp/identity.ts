// The MCP identity gate (docs/NEBULA.md §N7.1). An MCP request must prove THREE
// identities of the same person, each with credentials the person set up
// themselves, and all three must match their binding in NEBULA_MCP_IDENTITIES:
//
//   GitHub  Authorization: Bearer <gh token>          → login (GET /user)
//   Google  x-nebula-google-token: <ID token>          → verified email (tokeninfo;
//           gcloud auth print-identity-token)           iss/aud/exp/email_verified/hd)
//   AWS     x-nebula-aws-sts: <base64url presigned     → caller ARN (Nebula executes the
//           sts:GetCallerIdentity URL>                  presign against STS itself)
//
// The AWS proof needs NO IAM permission (GetCallerIdentity can't be denied), so the
// IAM users behind it (path /nebula-mcp/, group nebula-mcp-users) hold nothing but
// the right to manage their own credentials: least privilege by construction. The
// presign must sign `x-nebula-audience`, so a URL minted for anything else is useless here.
// Pure except for the injected fetch.

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** Extra, per-person grants on top of Nebula's own RBAC (operator etc.). Only these exist. */
export const MCP_SCOPES = ["capacity:production", "capacity:staging"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

export type McpBinding = { google: string; aws: string; scopes: McpScope[] };
export type McpBindings = Record<string, McpBinding>;

export const ACCOUNT_ID = "848281935985";
/** gcloud CLI's OAuth client: the audience of `gcloud auth print-identity-token` for user accounts. */
export const GCLOUD_CLIENT_ID = "32555940559.apps.googleusercontent.com";

const list = (raw: string | undefined, d: string) =>
  (raw ?? d)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export type IdentityConfig = {
  bindings: McpBindings;
  googleAudiences: string[];
  googleDomains: string[];
  awsAccount: string;
  awsUserPath: string;
  audience: string;
};

export function identityConfig(env: NodeJS.ProcessEnv = process.env): IdentityConfig {
  return {
    bindings: parseBindings(env.NEBULA_MCP_IDENTITIES),
    googleAudiences: list(env.NEBULA_GOOGLE_AUDIENCES, GCLOUD_CLIENT_ID),
    googleDomains: list(env.NEBULA_GOOGLE_DOMAINS, "twizz.com").map((d) => d.toLowerCase()),
    awsAccount: env.NEBULA_MCP_AWS_ACCOUNT || ACCOUNT_ID,
    awsUserPath: env.NEBULA_MCP_AWS_PATH ?? "/nebula-mcp/",
    audience: env.NEBULA_MCP_AUDIENCE || "nebula.prv.twizz.com",
  };
}

/** `{"login":{"google":"a@twizz.com","aws":"arn:aws:iam::…:user/nebula-mcp/a","scopes":["capacity:production"]}}`;
 * bad JSON = no bindings (fail closed); unknown scopes are dropped. */
export function parseBindings(raw: string | undefined): McpBindings {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw) as Record<string, { google?: unknown; aws?: unknown; scopes?: unknown }>;
    const out: McpBindings = {};
    for (const [login, b] of Object.entries(obj ?? {})) {
      if (typeof b?.google === "string" && typeof b?.aws === "string" && b.google && b.aws) {
        const scopes = Array.isArray(b.scopes) ? (b.scopes.filter((s) => (MCP_SCOPES as readonly unknown[]).includes(s)) as McpScope[]) : [];
        out[login.toLowerCase()] = { google: b.google.toLowerCase(), aws: b.aws, scopes: [...new Set(scopes)] };
      }
    }
    return out;
  } catch {
    return {};
  }
}

type Ok<T> = { ok: true } & T;
type Bad = { ok: false; reason: string };

// ── Google ────────────────────────────────────────────────────────────
/** Shape-only check, no network: a JWT-looking token of sane size. */
export function googleTokenShapeOk(idToken: string | null | undefined): idToken is string {
  return !!idToken && idToken.length <= 4096 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(idToken);
}

export async function verifyGoogle(idToken: string | null | undefined, cfg: IdentityConfig, f: FetchLike, now = Date.now()): Promise<Ok<{ email: string; exp: number }> | Bad> {
  if (!googleTokenShapeOk(idToken)) return { ok: false, reason: "missing Google identity (x-nebula-google-token) — `gcloud auth login <you>@twizz.com`" };
  const res = await f(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return { ok: false, reason: "Google rejected the identity token (expired?) — reconnect the MCP server" };
  const c = JSON.parse(await res.text()) as { iss?: string; aud?: string; email?: string; email_verified?: string | boolean; hd?: string; exp?: string };
  const exp = Number(c.exp) * 1000;
  if (c.iss !== "accounts.google.com" && c.iss !== "https://accounts.google.com") return { ok: false, reason: "Google token: wrong issuer" };
  if (!c.aud || !cfg.googleAudiences.includes(c.aud)) return { ok: false, reason: "Google token: not minted by gcloud (audience)" };
  if (!(exp > now)) return { ok: false, reason: "Google token expired — reconnect the MCP server" };
  if (!(c.email_verified === true || c.email_verified === "true") || !c.email) return { ok: false, reason: "Google token: email not verified" };
  const email = c.email.toLowerCase();
  const domain = email.split("@")[1] ?? "";
  if (!cfg.googleDomains.includes(domain) || (c.hd && !cfg.googleDomains.includes(c.hd.toLowerCase()))) return { ok: false, reason: `Google account ${email} is not a ${cfg.googleDomains.join("/")} account` };
  return { ok: true, email, exp };
}

// ── AWS ───────────────────────────────────────────────────────────────
const STS_HOST = /^sts(\.[a-z]{2}(-gov)?-[a-z]+-\d)?\.amazonaws\.com$/;

export function decodeStsProof(b64: string | null | undefined): URL | null {
  if (!b64 || b64.length > 4096 || !/^[A-Za-z0-9_-]+={0,2}$/.test(b64)) return null;
  try {
    const u = new URL(Buffer.from(b64, "base64url").toString("utf8"));
    return u;
  } catch {
    return null;
  }
}

/** When a vetted presign stops being valid (ms epoch), or null if the URL does not parse. */
export function stsProofExpiry(u: URL): number | null {
  const d = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(u.searchParams.get("X-Amz-Date") ?? "");
  const expires = Number(u.searchParams.get("X-Amz-Expires"));
  if (!d || !(expires > 0)) return null;
  return Date.UTC(+d[1], +d[2] - 1, +d[3], +d[4], +d[5], +d[6]) + expires * 1000;
}

/** Shape checks before Nebula sends anything to the URL (it must be STS, GetCallerIdentity, short-lived, audience-bound). */
export function checkStsUrl(u: URL, now = Date.now()): string | null {
  // exactly one of each query parameter: no duplicates for STS and this check to read differently
  const keys = [...u.searchParams.keys()];
  if (new Set(keys).size !== keys.length) return "AWS proof has duplicate query parameters";
  if (u.username || u.password || u.hash) return "AWS proof is not an STS URL";
  const q = u.searchParams;
  if (u.protocol !== "https:" || !STS_HOST.test(u.hostname) || u.port || (u.pathname !== "/" && u.pathname !== "")) return "AWS proof is not an STS URL";
  if (q.get("Action") !== "GetCallerIdentity" || q.get("Version") !== "2011-06-15") return "AWS proof must be sts:GetCallerIdentity";
  if (q.get("X-Amz-Algorithm") !== "AWS4-HMAC-SHA256") return "AWS proof must be SigV4-presigned";
  const signed = (q.get("X-Amz-SignedHeaders") ?? "").split(";");
  if (!signed.includes("x-nebula-audience")) return "AWS proof does not sign x-nebula-audience (not minted for Nebula)";
  const expires = Number(q.get("X-Amz-Expires"));
  if (!(expires > 0 && expires <= 900)) return "AWS proof must expire within 15 minutes";
  const d = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(q.get("X-Amz-Date") ?? "");
  if (!d) return "AWS proof has no X-Amz-Date";
  const at = Date.UTC(+d[1], +d[2] - 1, +d[3], +d[4], +d[5], +d[6]);
  if (at > now + 5 * 60_000 || at + expires * 1000 < now) return "AWS proof expired — reconnect the MCP server";
  return null;
}

export function arnFromSts(body: string): string | null {
  try {
    const j = JSON.parse(body) as { GetCallerIdentityResponse?: { GetCallerIdentityResult?: { Arn?: string } } };
    const a = j.GetCallerIdentityResponse?.GetCallerIdentityResult?.Arn;
    if (a) return a;
  } catch {
    /* XML */
  }
  return /<Arn>([^<]+)<\/Arn>/.exec(body)?.[1] ?? null;
}

export async function verifyAws(proof: string | null | undefined, cfg: IdentityConfig, f: FetchLike, now = Date.now()): Promise<Ok<{ arn: string; exp: number }> | Bad> {
  const u = decodeStsProof(proof);
  if (!u) return { ok: false, reason: "missing AWS identity (x-nebula-aws-sts) — configure the AWS profile in the plugin settings" };
  const bad = checkStsUrl(u, now);
  if (bad) return { ok: false, reason: bad };
  // redirect: "error" — STS never redirects; following one would send the request elsewhere
  const res = await f(u.toString(), { headers: { "x-nebula-audience": cfg.audience, accept: "application/json" }, signal: AbortSignal.timeout(10_000), redirect: "error" } as never);
  const body = await res.text();
  if (!res.ok) return { ok: false, reason: `AWS rejected the identity proof (${res.status}) — expired key, wrong clock, or minted for another audience` };
  const arn = arnFromSts(body);
  if (!arn) return { ok: false, reason: "AWS identity proof returned no ARN" };
  const want = `arn:aws:iam::${cfg.awsAccount}:user${cfg.awsUserPath}`;
  if (!arn.startsWith(want)) return { ok: false, reason: `AWS identity ${arn} is not a Nebula MCP user (expected ${want}<name>: an IAM user with no permissions)` };
  return { ok: true, arn, exp: stsProofExpiry(u)! };
}
