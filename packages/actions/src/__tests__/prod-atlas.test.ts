import { describe, expect, it } from "vitest";
import type { AtlasSize } from "@twizz-idp/shared";
import { planProdAtlas, prodAtlasOptions, setProdAtlasTier } from "../prod-atlas";
import type { AtlasClusters } from "../capacity";

const MOLY = { instanceSize: "M60", state: "IDLE" } as const; // no auto-scaling
const SHIFT4 = { instanceSize: "M20", autoScaling: { min: "M10", max: "M40" }, state: "IDLE" } as const;

function fakeAtlas(start: AtlasSize & { state: string }) {
  let cur = { ...start };
  const calls: AtlasSize[] = [];
  const expects: Array<AtlasSize | undefined> = [];
  const atlas: AtlasClusters = {
    getTier: async () => ({ ...cur }),
    setTier: async (_c, size, expect) => {
      calls.push(size);
      expects.push(expect);
      cur = { ...size, state: "UPDATING" };
      return { state: "UPDATING" };
    },
  };
  return { atlas, calls, expects, move: (s: AtlasSize & { state: string }) => (cur = s) };
}

describe("prodAtlasOptions", () => {
  it("allows +2 up and -1 down within the prod range", () => {
    expect(prodAtlasOptions("M60")).toEqual(["M50", "M80", "M140"]);
    expect(prodAtlasOptions("M10")).toEqual(["M20", "M30"]);
    expect(prodAtlasOptions("M200")).toEqual(["M140"]);
  });
});

describe("planProdAtlas", () => {
  it("plans a pre-campaign raise with the rolling-restart warning and cost", () => {
    const p = planProdAtlas("Moly-Prod", MOLY, { instanceSize: "M80" });
    expect(p.violations).toEqual([]);
    expect(p.changes).toEqual(["tier M60 → M80"]);
    expect(p.warnings.join(" ")).toMatch(/primary election/);
    expect(p.cost.after).toBeGreaterThan(p.cost.before);
  });

  it("refuses big jumps, big drops, unknown clusters and non-IDLE clusters", () => {
    expect(planProdAtlas("Moly-Prod", MOLY, { instanceSize: "M200" }).violations.join()).toMatch(/3 tiers up/);
    expect(planProdAtlas("Moly-Prod", MOLY, { instanceSize: "M40" }).violations.join()).toMatch(/2 tiers down/);
    expect(planProdAtlas("NonProd-Twizz", MOLY, { instanceSize: "M80" }).violations.join()).toMatch(/not a prod cluster/);
    expect(planProdAtlas("Moly-Prod", { ...MOLY, state: "UPDATING" }, { instanceSize: "M80" }).violations.join()).toMatch(/UPDATING/);
  });

  it("never toggles auto-scaling and keeps the tier inside its bounds", () => {
    expect(planProdAtlas("Moly-Prod", MOLY, { instanceSize: "M80", autoScaling: { min: "M60", max: "M80" } }).violations.join()).toMatch(/turning compute auto-scaling on/);
    expect(planProdAtlas("Prod-Shift4", SHIFT4, { instanceSize: "M30" }).violations.join()).toMatch(/turning compute auto-scaling off/);
    expect(planProdAtlas("Prod-Shift4", SHIFT4, { instanceSize: "M40", autoScaling: { min: "M10", max: "M30" } }).violations.join()).toMatch(/outside its auto-scaling bounds/);
  });

  it("warns that auto-scaling can undo a raise unless the floor moves too", () => {
    const loose = planProdAtlas("Prod-Shift4", SHIFT4, { instanceSize: "M30", autoScaling: { min: "M10", max: "M40" } });
    expect(loose.violations).toEqual([]);
    expect(loose.warnings.join(" ")).toMatch(/raise the floor/);
    const held = planProdAtlas("Prod-Shift4", SHIFT4, { instanceSize: "M30", autoScaling: { min: "M30", max: "M40" } });
    expect(held.changes).toEqual(["tier M20 → M30", "auto-scaling M10–M40 → M30–M40"]);
    expect(held.warnings.join(" ")).not.toMatch(/raise the floor/);
  });

  it("refuses a no-op and a ceiling cut of more than one tier", () => {
    expect(planProdAtlas("Moly-Prod", MOLY, { instanceSize: "M60" }).violations.join()).toMatch(/already M60/);
    expect(planProdAtlas("Prod-Shift4", SHIFT4, { instanceSize: "M20", autoScaling: { min: "M10", max: "M20" } }).violations.join()).toMatch(/ceiling M40 → M20/);
    expect(planProdAtlas("Prod-Shift4", SHIFT4, { instanceSize: "M20", autoScaling: { min: "M10", max: "M200" } }).violations.join()).toMatch(/ceiling M40 → M200 rises/);
  });
});

describe("AtlasTierAdapter", () => {
  it("refuses to read auto-scaling as OFF when its bounds are tiers Nebula does not model", async () => {
    const { AtlasTierAdapter } = await import("../adapters");
    const a = new AtlasTierAdapter({ getClusterTier: async () => ({ state: "IDLE", instanceSize: "M30", autoScaling: { min: "M10", max: "M300" } }), updateClusterTier: async () => ({ state: "UPDATING" }) });
    await expect(a.getTier("Prod-Shift4")).rejects.toThrow(/outside the tiers Nebula sizes/);
  });
});

describe("setProdAtlasTier", () => {
  it("resizes when the cluster is still what was reviewed", async () => {
    const f = fakeAtlas(MOLY);
    const r = await setProdAtlasTier({ atlas: f.atlas }, { cluster: "Moly-Prod", size: { instanceSize: "M80" }, from: "M60", actor: "ops" });
    expect(r).toMatchObject({ cluster: "Moly-Prod", from: "M60", to: "M80", state: "UPDATING" });
    expect(f.calls).toEqual([{ instanceSize: "M80" }]);
    // the final write is told what was checked, so a cluster that moved in between is refused
    expect(f.expects).toEqual([{ instanceSize: "M60", autoScaling: undefined }]);
  });

  it("refuses when the cluster moved after review, and never writes", async () => {
    const f = fakeAtlas(MOLY);
    f.move({ instanceSize: "M80", state: "IDLE" });
    await expect(setProdAtlasTier({ atlas: f.atlas }, { cluster: "Moly-Prod", size: { instanceSize: "M140" }, from: "M60", actor: "ops" })).rejects.toThrow(/now M80/);
    expect(f.calls).toEqual([]);
  });

  it("refuses clusters outside the allowlist before reading anything", async () => {
    const f = fakeAtlas(MOLY);
    await expect(setProdAtlasTier({ atlas: f.atlas }, { cluster: "Other", size: { instanceSize: "M80" }, from: "M60", actor: "ops" })).rejects.toThrow(/not a prod cluster/);
    expect(f.calls).toEqual([]);
  });
});
