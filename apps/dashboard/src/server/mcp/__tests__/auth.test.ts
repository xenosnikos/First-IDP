import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetMcpAuthCache, authenticateMcp, bearerOf } from "../auth";
import { identityConfig } from "../identity";

const GH = "gho_" + "x".repeat(36);
const NOW = Date.parse("2026-11-05T19:00:00Z");
const amzDate = "20261105T185900Z";
const ARN = "arn:aws:iam::848281935985:user/nebula-mcp/nick";
const gtok = (tag = "a") => `eyJhbGciOiJSUzI1NiJ9.eyJ${tag}.sig`;
const stsUrl = (o: Partial<Record<string, string>> = {}) => {
  const q = new URLSearchParams({ Action: "GetCallerIdentity", Version: "2011-06-15", "X-Amz-Algorithm": "AWS4-HMAC-SHA256", "X-Amz-Date": amzDate, "X-Amz-Expires": "900", "X-Amz-SignedHeaders": "host;x-nebula-audience", "X-Amz-Signature": "abc", ...o } as Record<string, string>);
  return Buffer.from(`https://sts.eu-west-1.amazonaws.com/?${q}`).toString("base64url");
};

type World = { login?: string | null; org?: "active" | null; google?: Record<string, unknown> | null; arn?: string | null };
function fakeFetch(w: World) {
  return vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
    const res = (ok: boolean, body: unknown) => ({ ok, status: ok ? 200 : 403, text: async () => (typeof body === "string" ? body : JSON.stringify(body)), json: async () => body }) as unknown as Response;
    if (url === "https://api.github.com/user") return res(!!w.login, { login: w.login, name: "N" });
    if (url.startsWith("https://api.github.com/user/memberships/")) return res(!!w.org, { state: w.org });
    if (url.startsWith("https://oauth2.googleapis.com/tokeninfo")) return res(!!w.google, w.google ?? {});
    if (url.startsWith("https://sts.")) {
      if (init?.headers?.["x-nebula-audience"] !== "nebula.prv.twizz.com") return res(false, "SignatureDoesNotMatch");
      return res(!!w.arn, { GetCallerIdentityResponse: { GetCallerIdentityResult: { Arn: w.arn } } });
    }
    throw new Error(`unexpected ${url}`);
  });
}

const goodGoogle = { iss: "https://accounts.google.com", aud: "32555940559.apps.googleusercontent.com", email: "nick@twizz.com", email_verified: "true", hd: "twizz.com", exp: String(NOW / 1000 + 3000) };
const good: World = { login: "Nick", org: "active", google: goodGoogle, arn: ARN };
const cfg = (bindings = `{"nick":{"google":"nick@twizz.com","aws":"${ARN}"}}`) => identityConfig({ NEBULA_MCP_IDENTITIES: bindings } as unknown as NodeJS.ProcessEnv);
const prisma = () => ({ auditLog: { create: vi.fn(async () => ({})) } });
const headers = (o: Partial<{ authorization: string; google: string; aws: string }> = {}) => ({ authorization: `Bearer ${GH}`, google: gtok(), aws: stsUrl(), ...o });

async function auth(w: World, h = headers(), c = cfg(), p = prisma()) {
  const r = await authenticateMcp(h, { prisma: p as never, fetch: fakeFetch(w) as never, now: () => NOW, config: c });
  return { r, p };
}

describe("MCP three-credential gate", () => {
  beforeEach(() => {
    _resetMcpAuthCache();
    process.env.ALLOWED_GITHUB_LOGINS = "";
    process.env.ALLOWED_GITHUB_ORGS = "twizz-app";
  });

  it("parses only well-formed bearer tokens", () => {
    expect(bearerOf(`Bearer ${GH}`)).toBe(GH);
    expect(bearerOf(GH)).toBeNull();
    expect(bearerOf(null)).toBeNull();
  });

  it("admits a person whose GitHub, Google and AWS identities all match their binding, and audits all three", async () => {
    const { r, p } = await auth(good);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.session).toMatchObject({ login: "nick", google: "nick@twizz.com", aws: ARN, accessToken: GH, user: { email: "nick@twizz.com" } });
    expect(p.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ actor: "nick", action: "mcp.signin", allowed: true, detail: expect.objectContaining({ google: "nick@twizz.com", aws: ARN }) }) });
  });

  it("refuses a Nebula user with no MCP binding (operators included)", async () => {
    const { r, p } = await auth(good, headers(), cfg("{}"));
    expect(r).toMatchObject({ ok: false, status: 403, reason: expect.stringContaining("NEBULA_MCP_IDENTITIES") });
    expect(p.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ actor: "nick", allowed: false }) });
  });

  it("refuses when GitHub is not allowed on Nebula at all", async () => {
    expect((await auth({ ...good, org: null })).r).toMatchObject({ ok: false, status: 403 });
    _resetMcpAuthCache();
    expect((await auth({ ...good, login: null })).r).toMatchObject({ ok: false, status: 401 });
  });

  it("Google: missing, wrong domain, wrong audience, unverified, expired, or someone else's → refused", async () => {
    const cases: Array<[World["google"], RegExp, string?]> = [
      [goodGoogle, /missing Google/, ""],
      [{ ...goodGoogle, email: "nick@gmail.com", hd: undefined }, /not a twizz.com account/],
      [{ ...goodGoogle, aud: "someone-else.apps.googleusercontent.com" }, /audience/],
      [{ ...goodGoogle, email_verified: "false" }, /not verified/],
      [{ ...goodGoogle, exp: String(NOW / 1000 - 10) }, /expired/],
      [{ ...goodGoogle, email: "igor@twizz.com" }, /not the one bound/],
    ];
    for (const [g, re, tok] of cases) {
      _resetMcpAuthCache();
      const { r } = await auth({ ...good, google: g }, headers({ google: tok ?? gtok() }));
      expect(r.ok, String(re)).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(re);
    }
  });

  it("AWS: the proof must be an audience-bound, short-lived STS GetCallerIdentity of the bound /nebula-mcp/ user", async () => {
    const cases: Array<[string, World["arn"], RegExp]> = [
      ["", ARN, /missing AWS/],
      [Buffer.from("https://evil.example.com/?Action=GetCallerIdentity").toString("base64url"), ARN, /not an STS URL/],
      [stsUrl({ Action: "AssumeRole" }), ARN, /GetCallerIdentity/],
      [stsUrl({ "X-Amz-SignedHeaders": "host" }), ARN, /x-nebula-audience/],
      [stsUrl({ "X-Amz-Expires": "3600" }), ARN, /15 minutes/],
      [stsUrl({ "X-Amz-Date": "20261105T170000Z" }), ARN, /expired/],
      [stsUrl(), "arn:aws:iam::848281935985:user/Nick", /not a Nebula MCP user/],
      [stsUrl(), "arn:aws:iam::848281935985:user/nebula-mcp/igor", /not the one bound/],
    ];
    for (const [proof, arn, re] of cases) {
      _resetMcpAuthCache();
      const { r } = await auth({ ...good, arn }, headers({ aws: proof }));
      expect(r.ok, String(re)).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(re);
    }
  });

  it("never sends an unvetted URL anywhere", async () => {
    const f = fakeFetch(good);
    await authenticateMcp(headers({ aws: Buffer.from("https://169.254.169.254/latest/meta-data/").toString("base64url") }), { prisma: prisma() as never, fetch: f as never, now: () => NOW, config: cfg() });
    expect(f.mock.calls.map((c) => c[0] as string).some((u) => u.includes("169.254"))).toBe(false);
  });

  it("caches verified identities (one Google + one STS call), but re-checks GitHub after 5 minutes", async () => {
    const f = fakeFetch(good);
    let now = NOW;
    const deps = { prisma: prisma() as never, fetch: f as never, now: () => now, config: cfg() };
    await authenticateMcp(headers(), deps);
    await authenticateMcp(headers(), deps);
    const count = (p: string) => f.mock.calls.filter((c) => (c[0] as string).startsWith(p)).length;
    expect([count("https://api.github.com/user"), count("https://oauth2"), count("https://sts.")]).toEqual([2, 1, 1]);
    now += 5 * 60_000 + 1;
    await authenticateMcp(headers(), deps);
    expect([count("https://oauth2"), count("https://sts.")]).toEqual([1, 1]);
    expect(count("https://api.github.com/user")).toBe(4);
  });
});
