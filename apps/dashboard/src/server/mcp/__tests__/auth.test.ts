import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetMcpAuthCache, authenticateMcp, bearerOf } from "../auth";

const TOKEN = "gho_" + "x".repeat(36);

function gh(login: string | null, orgState: "active" | "pending" | null) {
  return vi.fn(async (url: string) => {
    if (url.endsWith("/user")) return { ok: !!login, status: login ? 200 : 401, json: async () => ({ login, name: "N" }) };
    return { ok: !!orgState, status: orgState ? 200 : 404, json: async () => ({ state: orgState }) };
  });
}

const prisma = () => ({ auditLog: { create: vi.fn(async () => ({})) } });

describe("MCP bearer auth", () => {
  beforeEach(() => {
    _resetMcpAuthCache();
    process.env.ALLOWED_GITHUB_LOGINS = "";
    process.env.ALLOWED_GITHUB_ORGS = "twizz-app";
    process.env.NEBULA_MCP_USERS = "igor";
    process.env.NEBULA_OPERATORS = "nick";
  });

  it("parses only well-formed bearer tokens", () => {
    expect(bearerOf(`Bearer ${TOKEN}`)).toBe(TOKEN);
    expect(bearerOf(TOKEN)).toBeNull();
    expect(bearerOf("Bearer short")).toBeNull();
    expect(bearerOf(null)).toBeNull();
  });

  it("admits an active org member as a session the tRPC procedures accept", async () => {
    const p = prisma();
    const r = await authenticateMcp(`Bearer ${TOKEN}`, { prisma: p as never, fetch: gh("Nick", "active") as never });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.session.login).toBe("nick");
      expect(r.session.accessToken).toBe(TOKEN);
      expect(r.session.user).toBeTruthy();
    }
    expect(p.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ actor: "nick", action: "mcp.signin", allowed: true }) });
  });

  it("admits the ALLOWED_GITHUB_LOGINS allowlist without an org check", async () => {
    process.env.ALLOWED_GITHUB_LOGINS = "igor";
    const f = gh("igor", null);
    const r = await authenticateMcp(`Bearer ${TOKEN}`, { prisma: prisma() as never, fetch: f as never });
    expect(r.ok).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("refuses non-members with 403 and audits the denial", async () => {
    const p = prisma();
    const r = await authenticateMcp(`Bearer ${TOKEN}`, { prisma: p as never, fetch: gh("mallory", "pending") as never });
    expect(r).toMatchObject({ ok: false, status: 403 });
    expect(p.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ actor: "mallory", allowed: false }) });
  });

  it("refuses a Nebula user who is not on the MCP list, and audits why", async () => {
    const p = prisma();
    const r = await authenticateMcp(`Bearer ${TOKEN}`, { prisma: p as never, fetch: gh("dev1", "active") as never });
    expect(r).toMatchObject({ ok: false, status: 403, reason: expect.stringContaining("NEBULA_MCP_USERS") });
    expect(p.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ actor: "dev1", action: "mcp.signin", allowed: false }) });
  });

  it("operators always get MCP; with NEBULA_MCP_USERS unset, only operators do", async () => {
    process.env.NEBULA_MCP_USERS = "";
    expect((await authenticateMcp(`Bearer ${TOKEN}`, { prisma: prisma() as never, fetch: gh("nick", "active") as never })).ok).toBe(true);
    _resetMcpAuthCache();
    expect((await authenticateMcp(`Bearer ${TOKEN}`, { prisma: prisma() as never, fetch: gh("dev1", "active") as never })).ok).toBe(false);
  });

  it("the MCP list never bypasses the Nebula sign-in rule", async () => {
    process.env.NEBULA_MCP_USERS = "outsider";
    const r = await authenticateMcp(`Bearer ${TOKEN}`, { prisma: prisma() as never, fetch: gh("outsider", null) as never });
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it("refuses a token GitHub rejects with 401", async () => {
    const r = await authenticateMcp(`Bearer ${TOKEN}`, { prisma: prisma() as never, fetch: gh(null, null) as never });
    expect(r).toMatchObject({ ok: false, status: 401 });
  });

  it("caches a verified token for 5 minutes, then re-verifies", async () => {
    const f = gh("nick", "active");
    let now = 1_000_000;
    const deps = { prisma: prisma() as never, fetch: f as never, now: () => now };
    await authenticateMcp(`Bearer ${TOKEN}`, deps);
    await authenticateMcp(`Bearer ${TOKEN}`, deps);
    expect(f).toHaveBeenCalledTimes(2); // /user + membership, once
    now += 5 * 60_000 + 1;
    await authenticateMcp(`Bearer ${TOKEN}`, deps);
    expect(f).toHaveBeenCalledTimes(4);
  });
});
