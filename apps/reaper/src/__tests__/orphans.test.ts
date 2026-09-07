import { describe, expect, it } from "vitest";
import { decideOrphan, decideOrphans, type ArgoAppInfo, type NamespaceInfo } from "../orphans";

const now = new Date("2026-09-07T12:00:00Z");
const hourAgo = new Date(now.getTime() - 3_600_000);
const ns = (name: string, labels: Record<string, string> = { "twizz-idp/preview": "true" }, createdAt: Date | null = hourAgo): NamespaceInfo => ({ name, labels, createdAt: createdAt ?? undefined });
const apps: ArgoAppInfo[] = [
  { name: "env-smoke", labels: { "twizz-idp/named-env": "true" } },
  { name: "twizz-admin-pr-139", labels: { "twizz-idp/repo": "twizz-admin", "twizz-idp/pr": "139" } },
  { name: "moly-backend-pr-7", labels: { "twizz-idp/pr": "7" } }, // older appset shape: no repo label
];

describe("decideOrphan", () => {
  it("keeps env-* namespaces whose Application exists, deletes those without", () => {
    expect(decideOrphan(ns("env-smoke"), apps, now)).toMatchObject({ action: "keep", reason: /env-smoke exists/ });
    expect(decideOrphan(ns("env-n1test"), apps, now)).toEqual({ namespace: "env-n1test", action: "delete", reason: "no Application env-n1test" });
  });
  it("matches pr-* namespaces on twizz-idp/pr (+ repo when the app has it)", () => {
    expect(decideOrphan(ns("pr-twizz-admin-139"), apps, now)).toMatchObject({ action: "keep" });
    expect(decideOrphan(ns("pr-twizz-admin-140"), apps, now)).toMatchObject({ action: "delete", reason: /twizz-idp\/pr=140 for twizz-admin/ });
    expect(decideOrphan(ns("pr-twizz-sentinel-139"), apps, now)).toMatchObject({ action: "delete" }); // same number, other repo
    expect(decideOrphan(ns("pr-moly-backend-7"), apps, now)).toMatchObject({ action: "keep" }); // repo-less app label still matches
  });
  it("never touches namespaces without the preview label, whatever their name", () => {
    expect(decideOrphan(ns("env-ghost", {}), apps, now)).toMatchObject({ action: "keep", reason: /label/ });
    expect(decideOrphan(ns("pr-x-1", { "twizz-idp/preview": "false" }), apps, now)).toMatchObject({ action: "keep" });
    expect(decideOrphan(ns("argocd", {}), apps, now)).toMatchObject({ action: "keep" });
  });
  it("respects the grace period and unknown creation times", () => {
    const young = new Date(now.getTime() - 5 * 60_000);
    expect(decideOrphan(ns("env-ghost", undefined, young), apps, now)).toMatchObject({ action: "keep", reason: /grace 10 min/ });
    expect(decideOrphan(ns("env-ghost", undefined, young), apps, now, 3)).toMatchObject({ action: "delete" });
    expect(decideOrphan(ns("env-ghost", undefined, null), apps, now)).toMatchObject({ action: "keep", reason: /creation time/ });
  });
  it("keeps labelled namespaces of an unknown shape (e.g. shared)", () => {
    expect(decideOrphan(ns("shared"), apps, now)).toMatchObject({ action: "keep", reason: /not an env-\* or pr-\*/ });
  });
  it("decideOrphans maps every namespace to exactly one decision", () => {
    const out = decideOrphans([ns("env-smoke"), ns("env-gone"), ns("shared")], apps, now);
    expect(out.map((d) => d.action)).toEqual(["keep", "delete", "keep"]);
  });
});
