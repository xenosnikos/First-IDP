import { describe, expect, it } from "vitest";
import { fromLegacy, parseTwizzObject, substituteBuildArgs, TwizzYamlV2 } from "../twizz-yaml";

const msgs = (input: unknown) => (TwizzYamlV2.safeParse(input).error?.issues ?? []).map((i) => i.message).join("\n");

const backend = { version: 2, kind: "backend", port: 8090, healthPath: "/health", secrets: ["ANTHROPIC_API_KEY"], env: { LOG_LEVEL: "info" }, needs: { mongo: true } };
const frontend = { version: 2, kind: "frontend", port: 80, healthPath: "/", build: { args: { VITE_BACKEND_URL: "${NEBULA_API_URL}" } }, frontend: { framework: "vite", apiEnvVar: "VITE_BACKEND_URL", serve: "static" } };

describe("TwizzYamlV2", () => {
  it("accepts a backend, a frontend and a worker with defaults filled", () => {
    const b = TwizzYamlV2.parse(backend);
    expect(b.dockerfile).toBe("Dockerfile");
    expect(b.context).toBe(".");
    expect(b.needs).toEqual({ mongo: true, redis: false });
    expect(TwizzYamlV2.parse(frontend).frontend?.serve).toBe("static");
    expect(TwizzYamlV2.parse({ version: 2, kind: "worker", port: 9000, healthPath: "/healthz" }).kind).toBe("worker");
  });
  it("rejects unknown keys, bad ports, non-public build args, secret-shaped env values, and env/secrets overlap", () => {
    expect(TwizzYamlV2.safeParse({ ...backend, extra: 1 }).success).toBe(false);
    expect(TwizzYamlV2.safeParse({ ...backend, port: 70000 }).success).toBe(false);
    expect(msgs({ ...backend, build: { args: { API_KEY: "x" } } })).toMatch(/not an allowed public build-time key/);
    expect(msgs({ ...backend, env: { MONGO_URI: "mongodb+srv://u:p@h/db" } })).toMatch(/looks like a credential/);
    expect(msgs({ ...backend, env: { ANTHROPIC_API_KEY: "x" } })).toMatch(/both an env default and a secret/);
    expect(msgs({ ...backend, env: { lower: "x" } })).toMatch(/UPPER_SNAKE_CASE/);
  });
  it("enforces the frontend block and the API placeholder", () => {
    expect(msgs({ ...frontend, frontend: undefined })).toMatch(/requires a "frontend" block/);
    expect(msgs({ ...frontend, build: { args: {} } })).toMatch(/must set VITE_BACKEND_URL/);
    expect(msgs({ ...frontend, build: { args: { VITE_BACKEND_URL: "https://api.twizz.com" } } })).toMatch(/placeholder/);
    expect(msgs({ ...backend, frontend: frontend.frontend })).toMatch(/only applies to kind/);
  });
  it("upgrades legacy v1 marker files", () => {
    expect(fromLegacy({ name: "Moly-Backend", kind: "backend-k8s", port: 8080, healthPath: "/health", secretName: "preview/moly-backend" })).toMatchObject({ version: 2, name: "moly-backend", kind: "backend", port: 8080 });
    const fe = fromLegacy({ name: "business", kind: "frontend-vercel" });
    expect(fe).toMatchObject({ kind: "frontend", port: 80, healthPath: "/" });
    expect(fe.build.args.REACT_APP_API_ENDPOINT).toBe("${NEBULA_API_URL}");
    expect(fromLegacy({ name: "svc", kind: "lambda-sam" }).kind).toBe("backend");
  });
  it("parseTwizzObject reports issues as readable paths and detects legacy", () => {
    expect(parseTwizzObject(backend)).toMatchObject({ ok: true, legacy: false });
    expect(parseTwizzObject({ name: "x", kind: "backend-k8s" })).toMatchObject({ ok: true, legacy: true });
    const bad = parseTwizzObject({ version: 2, kind: "backend" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues.join("\n")).toMatch(/^port:/m);
    expect(parseTwizzObject("nope").ok).toBe(false);
    expect(parseTwizzObject({ version: 3 }).ok).toBe(false);
  });
  it("substitutes placeholders and leaves unknown ones", () => {
    expect(substituteBuildArgs({ VITE_BACKEND_URL: "${NEBULA_API_URL}/v1", VITE_WS: "${NEBULA_SOCKET_URL}", VITE_X: "${NEBULA_OTHER}", VITE_SELF: "${NEBULA_ENV_URL}" }, { apiUrl: "https://api.prv", envUrl: "https://me.prv" })).toEqual({
      VITE_BACKEND_URL: "https://api.prv/v1",
      VITE_WS: "https://api.prv",
      VITE_X: "${NEBULA_OTHER}",
      VITE_SELF: "https://me.prv",
    });
  });
});
