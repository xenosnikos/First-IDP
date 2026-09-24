import { describe, expect, it, vi } from "vitest";
import { GITHUB_TOKEN_URL, REFRESH_SKEW_S, needsRefresh, refreshGithubToken } from "@/lib/github-token";

const NOW = 1_800_000_000;

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })) as unknown as typeof fetch;
}

describe("needsRefresh", () => {
  it("never refreshes a token without an expiry or without a refresh token (classic OAuth app)", () => {
    expect(needsRefresh({}, NOW)).toBe(false);
    expect(needsRefresh({ expiresAt: NOW - 10 }, NOW)).toBe(false);
    expect(needsRefresh({ refreshToken: "r" }, NOW)).toBe(false);
  });
  it("refreshes inside the skew window and after expiry, not before", () => {
    expect(needsRefresh({ expiresAt: NOW + 3600, refreshToken: "r" }, NOW)).toBe(false);
    expect(needsRefresh({ expiresAt: NOW + REFRESH_SKEW_S - 1, refreshToken: "r" }, NOW)).toBe(true);
    expect(needsRefresh({ expiresAt: NOW - 1, refreshToken: "r" }, NOW)).toBe(true);
  });
});

describe("refreshGithubToken", () => {
  const opts = { clientId: "Iv23liTEST", clientSecret: "s3cret", nowS: NOW };

  it("posts the refresh grant and stores the rotated pair + new expiry", async () => {
    const fetchFn = fakeFetch(200, { access_token: "ghu_new", refresh_token: "ghr_new", expires_in: 28800 });
    const out = await refreshGithubToken({ accessToken: "ghu_old", refreshToken: "ghr_old", expiresAt: NOW - 1 }, { ...opts, fetchFn });
    expect(out).toEqual({ accessToken: "ghu_new", refreshToken: "ghr_new", expiresAt: NOW + 28800, tokenError: undefined });
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(GITHUB_TOKEN_URL);
    const body = new URLSearchParams(String(init.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("ghr_old");
    expect(body.get("client_id")).toBe("Iv23liTEST");
    expect((init.headers as Record<string, string>).Accept).toBe("application/json");
  });

  it("keeps the old refresh token when GitHub does not rotate it", async () => {
    const out = await refreshGithubToken({ refreshToken: "ghr_old", expiresAt: NOW }, { ...opts, fetchFn: fakeFetch(200, { access_token: "ghu_new", expires_in: 100 }) });
    expect(out.refreshToken).toBe("ghr_old");
    expect(out.accessToken).toBe("ghu_new");
  });

  it("DROPS the access token and records the reason when the refresh is rejected (200 with error body, or non-2xx)", async () => {
    const rejected = await refreshGithubToken({ accessToken: "dead", refreshToken: "ghr" }, { ...opts, fetchFn: fakeFetch(200, { error: "bad_refresh_token", error_description: "The refresh token passed is incorrect or expired." }) });
    expect(rejected.accessToken).toBeUndefined();
    expect(rejected.refreshToken).toBe("ghr");
    expect(rejected.tokenError).toContain("incorrect or expired");

    const down = await refreshGithubToken({ accessToken: "dead", refreshToken: "ghr" }, { ...opts, fetchFn: fakeFetch(503, {}) });
    expect(down.accessToken).toBeUndefined();
    expect(down.tokenError).toContain("503");
  });

  it("survives a network failure the same way (no throw, token dropped)", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const out = await refreshGithubToken({ accessToken: "dead", refreshToken: "ghr" }, { ...opts, fetchFn });
    expect(out.accessToken).toBeUndefined();
    expect(out.tokenError).toContain("ECONNRESET");
  });

  it("refuses to refresh without a refresh token", async () => {
    const out = await refreshGithubToken({ accessToken: "x" }, { ...opts, fetchFn: fakeFetch(200, {}) });
    expect(out).toEqual({ accessToken: undefined, tokenError: "no refresh token" });
  });
});
