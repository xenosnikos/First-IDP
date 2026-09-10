import { describe, expect, it } from "vitest";
import { PROVISIONABLE, REGISTRY, getService, repoSlug, serviceForApp } from "../registry";
import { SERVICES, SERVICE_NAMES } from "../named-envs";

describe("registry", () => {
  it("has unique names and every SHIPPED backend carries what provisioning needs", () => {
    const names = REGISTRY.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const s of REGISTRY.filter((x) => x.status === "SHIPPED" && x.kind === "backend")) {
      expect(s.sourceSecret, s.name).toMatch(/^preview\//);
      expect(s.ecrRepo, s.name).toBeTruthy();
      expect(s.valuesFile, s.name).toBe(`apps/${s.name}/values.yaml`);
      expect(s.repo, s.name).toMatch(/^twizz-app\//);
    }
  });
  it("frontends declare their build-time API env var and never a source secret", () => {
    for (const s of REGISTRY.filter((x) => x.kind === "frontend")) {
      expect(s.build?.apiEnvVar, s.name).toMatch(/^(REACT_APP_|VITE_|NEXT_PUBLIC_)/);
      expect(s.sourceSecret, s.name).toBeUndefined();
    }
  });
  it("only SHIPPED backends are provisionable today, and SERVICES mirrors them", () => {
    expect(PROVISIONABLE.map((s) => s.name)).toEqual(["moly-backend"]);
    expect(SERVICE_NAMES).toEqual(["moly-backend"]);
    expect(SERVICES["moly-backend"]).toEqual({ ecrRepo: "molybackend", sourceSecret: "preview/moly-backend" });
    expect(getService("business")?.status).toBe("PLANNED");
    expect(getService("twizz-sentinel")?.status).toBe("PLANNED");
    expect(getService("twizz-support")?.status).toBe("PLANNED");
  });
  it("maps live Argo apps back to entries by label, then by source repo", () => {
    expect(serviceForApp({ "twizz-idp/service": "moly-backend" })?.name).toBe("moly-backend");
    expect(serviceForApp({ "twizz-idp/repo": "twizz-admin", "twizz-idp/pr": "139" })?.name).toBe("twizz-admin");
    expect(serviceForApp({}, ["https://github.com/twizz-app/Moly-backend.git"])?.name).toBe("moly-backend");
    expect(serviceForApp({}, ["git@github.com:xenosnikos/twizz-support.git"])?.name).toBe("twizz-support");
    expect(serviceForApp({}, ["https://github.com/someone-else/random.git"])).toBeUndefined();
  });
  it("repoSlug handles https and ssh forms", () => {
    expect(repoSlug("https://github.com/TwizzyNicky/twizz-gitops")).toBe("TwizzyNicky/twizz-gitops");
    expect(repoSlug("git@github.com:xenosnikos/twizz-support.git")).toBe("xenosnikos/twizz-support");
    expect(repoSlug("https://gitlab.com/x/y")).toBeUndefined();
  });
});
