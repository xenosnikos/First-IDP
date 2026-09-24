import { describe, expect, it } from "vitest";
import { IN_CLUSTER, buildAppViews, buildProjectViews, classifyApp, isPlatformApp, isProjectRepo, prLink, tierOf, type LiveApp } from "@/server/nebula/classify";
import { podWord } from "@/lib/nebula/status";

const GITOPS = "https://github.com/TwizzyNicky/twizz-gitops";
const app = (over: Partial<LiveApp>): LiveApp => ({ name: "x", namespace: "x", project: "previews", labels: {}, sourceRepoUrls: [GITOPS], sync: "Synced", health: "Healthy", ...over });

// Shapes taken from the live cluster on 2026-09-09.
const LIVE: LiveApp[] = [
  app({ name: "root", namespace: "argocd", project: "default" }),
  app({ name: "nebula", namespace: "nebula", project: "nebula" }),
  app({ name: "env-smoke", namespace: "env-smoke", labels: { "twizz-idp/named-env": "true", "twizz-idp/service": "moly-backend" }, ownerKind: "ApplicationSet", ownerName: "named-envs", sync: "OutOfSync" }),
  app({ name: "twizz-admin-pr-139", namespace: "pr-twizz-admin-139", labels: { "twizz-idp/repo": "twizz-admin", "twizz-idp/pr": "139" }, ownerKind: "ApplicationSet", ownerName: "twizz-admin-preview" }),
  app({ name: "shared-ffmpeg-service", namespace: "shared", health: "Degraded" }),
  app({ name: "twizz-support", namespace: "twizz-support", project: "twizz-support", sourceRepoUrls: ["git@github.com:xenosnikos/twizz-support.git"] }),
  app({ name: "shared-lolygram-discovery", namespace: "shared", health: "Degraded" }),
  app({ name: "shared-alertservice", namespace: "shared", health: "Degraded" }),
  app({ name: "some-external-thing", namespace: "ext", sourceRepoUrls: ["https://github.com/someone-else/random.git"] }),
];
const APPSETS = [{ name: "twizz-admin-preview", prOwner: "twizz-app", prRepo: "twizz-admin" }, { name: "moly-backend-preview", prOwner: "twizz-app", prRepo: "Moly-backend" }, { name: "named-envs" }];

describe("classifyApp / prLink", () => {
  it("named → NAMED, appset-owned with a pr label → PR PREVIEW, everything else → GITOPS APP", () => {
    expect(classifyApp(LIVE[2])).toBe("NAMED");
    expect(classifyApp(LIVE[3])).toBe("PR PREVIEW");
    expect(classifyApp(LIVE[4])).toBe("GITOPS APP");
    expect(classifyApp(LIVE[5])).toBe("GITOPS APP");
  });
  it("builds the PR link from the appset's generator repo", () => {
    expect(prLink(LIVE[3], APPSETS)).toEqual({ repo: "twizz-app/twizz-admin", number: "139", url: "https://github.com/twizz-app/twizz-admin/pull/139" });
    expect(prLink(LIVE[4], APPSETS)).toBeUndefined();
  });
});

describe("buildAppViews", () => {
  const views = buildAppViews(
    LIVE,
    [{ namespace: "env-smoke", name: "moly-backend", hosts: ["smoke.prv.twizz.com"] }, { namespace: "twizz-support", name: "workbench", hosts: ["support.prv.twizz.com"] }],
    [{ namespace: "env-smoke", name: "moly-backend", images: ["…/molybackend:build-75b9"], ready: 1, desired: 1 }, { namespace: "shared", name: "ffmpeg-service", images: ["…/molyffmpeg:dev"], ready: 0, desired: 1 }],
    APPSETS,
  );
  it("hides root/nebula and the shared-* singletons; joins hosts + images by namespace", () => {
    expect(views.map((v) => v.name)).toEqual(["some-external-thing", "twizz-support", "env-smoke", "twizz-admin-pr-139"]);
    expect(views.find((v) => v.name === "env-smoke")).toMatchObject({ origin: "NAMED", hosts: ["smoke.prv.twizz.com"], images: ["…/molybackend:build-75b9"], service: "moly-backend" });
    expect(views.find((v) => v.name === "twizz-support")).toMatchObject({ origin: "GITOPS APP", hosts: ["support.prv.twizz.com"], sourceRepos: ["xenosnikos/twizz-support"], service: "twizz-support" });
    expect(views.some((v) => v.name.startsWith("shared-"))).toBe(false);
  });
  it("isPlatformApp: root, nebula, shared-* by name or namespace", () => {
    expect(isPlatformApp({ name: "root", namespace: "argocd" })).toBe(true);
    expect(isPlatformApp({ name: "shared-alertservice", namespace: "shared" })).toBe(true);
    expect(isPlatformApp({ name: "anything", namespace: "shared" })).toBe(true);
    expect(isPlatformApp({ name: "sharedish-app", namespace: "x" })).toBe(false);
    expect(isPlatformApp({ name: "env-smoke", namespace: "env-smoke" })).toBe(false);
  });
});

describe("buildProjectViews", () => {
  const apps = buildAppViews(LIVE, [], [], APPSETS);
  const org = [
    { slug: "twizz-app/Moly-backend", name: "Moly-backend", url: "https://github.com/twizz-app/Moly-backend" },
    { slug: "twizz-app/frontend", name: "frontend", url: "https://github.com/twizz-app/frontend" },
    { slug: "twizz-app/twizz-admin", name: "twizz-admin", url: "https://github.com/twizz-app/twizz-admin" },
  ];
  const views = buildProjectViews(org, apps, APPSETS, [{ id: "p1", githubRepoUrl: "https://github.com/twizz-app/frontend" }]);
  const by = (slug: string) => views.find((v) => v.slug.toLowerCase() === slug.toLowerCase())!;
  it("confines projects to the org plus the explicit demo exception", () => {
    expect(views.map((v) => v.slug)).toContain("xenosnikos/twizz-support");
    expect(by("xenosnikos/twizz-support").words).toEqual(["DEPLOYED"]);
    expect(by("xenosnikos/twizz-support").registry).toEqual({ name: "twizz-support", kind: "backend", status: "PLANNED" });
    expect(views.some((v) => v.slug === "someone-else/random")).toBe(false);
    expect(isProjectRepo("Twizz-App/anything", "twizz-app")).toBe(true);
    expect(isProjectRepo("xenosnikos/other", "twizz-app")).toBe(false);
    expect(by("twizz-app/Moly-backend").words).toEqual(["DEPLOYED", "PREVIEWABLE"]);
    expect(by("twizz-app/Moly-backend").apps).toEqual(["env-smoke"]);
    expect(by("twizz-app/twizz-admin").words).toEqual(["DEPLOYED", "PREVIEWABLE"]);
    expect(by("twizz-app/frontend").words).toEqual(["REGISTERED"]);
    expect(by("twizz-app/frontend").registry).toEqual({ name: "frontend", kind: "frontend", status: "PLANNED" });
  });
  it("never lists the gitops repo as a project, and deployed sorts first", () => {
    expect(views.some((v) => v.slug.toLowerCase() === "twizzynicky/twizz-gitops")).toBe(false);
    expect(views[0].words).toContain("DEPLOYED");
  });
  it("marks a repo with no facts UNONBOARDED", () => {
    const v = buildProjectViews([{ slug: "twizz-app/nothing", name: "nothing", url: "" }], [], [], []);
    expect(v[0].words).toEqual(["UNONBOARDED"]);
  });
});

describe("podWord", () => {
  it("maps Container Insights pod_status honestly", () => {
    expect(podWord("Running").word).toBe("PASS");
    expect(podWord("Running", 617)).toEqual({ word: "FAIL", detail: "Running, 617 restarts" });
    expect(podWord("Pending").word).toBe("PENDING");
    expect(podWord("Failed").word).toBe("FAIL");
    expect(podWord(undefined).word).toBe("UNKNOWN");
  });
});

describe("tierOf (release train, §N4)", () => {
  it("in-cluster and unlabelled → nonprod; the staging label OR a foreign destination → staging", () => {
    expect(tierOf(app({}))).toBe("nonprod");
    expect(tierOf(app({ destination: IN_CLUSTER }))).toBe("nonprod");
    expect(tierOf(app({ labels: { "twizz-idp/tier": "staging" }, destination: IN_CLUSTER }))).toBe("staging");
    expect(tierOf(app({ destination: "https://2B5C374652A4DAE99EB938A93BABA3F2.sk1.eu-west-1.eks.amazonaws.com" }))).toBe("staging");
    expect(tierOf(app({ destination: "cluster:eks-moly-staging" }))).toBe("staging");
  });
  it("buildAppViews carries the tier so the Environments grid can keep non-prod only", () => {
    const staging = app({ name: "staging-twizz-sentinel", namespace: "sentinel", project: "staging", labels: { "twizz-idp/tier": "staging", "twizz-idp/service": "twizz-sentinel" }, destination: "https://staging.example" });
    const views = buildAppViews([staging, LIVE[3]], [], [], APPSETS);
    expect(views.find((v) => v.name === "staging-twizz-sentinel")).toMatchObject({ tier: "staging", origin: "GITOPS APP", service: "twizz-sentinel" });
    expect(views.find((v) => v.name === "twizz-admin-pr-139")?.tier).toBe("nonprod");
  });
});
