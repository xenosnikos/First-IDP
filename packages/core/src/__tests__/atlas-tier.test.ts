import { describe, expect, it } from "vitest";
import { digestAuthorization, parseDigestChallenge, tierOf, tierPatch } from "../atlas";

// A 2023-11-15 cluster description, trimmed to what the tier code touches.
const CLUSTER = {
  name: "nonprod-twizz",
  stateName: "IDLE",
  replicationSpecs: [
    {
      id: "rs1",
      zoneName: "Zone 1",
      regionConfigs: [
        {
          providerName: "AWS",
          regionName: "EU_WEST_1",
          priority: 7,
          electableSpecs: { instanceSize: "M10", nodeCount: 3, diskIOPS: 3000 },
          readOnlySpecs: { instanceSize: "M10", nodeCount: 0 },
          autoScaling: { diskGB: { enabled: true }, compute: { enabled: false, scaleDownEnabled: false } },
        },
      ],
    },
  ],
};

describe("Atlas tier", () => {
  it("reads the tier", () => {
    expect(tierOf(CLUSTER)).toEqual({ name: "nonprod-twizz", state: "IDLE", instanceSize: "M10", autoScaling: undefined });
  });

  it("patches only instance size + compute auto-scaling", () => {
    const body = tierPatch(CLUSTER, { instanceSize: "M20", autoScaling: { min: "M10", max: "M30" } });
    const rc = body.replicationSpecs[0].regionConfigs[0];
    expect(body.replicationSpecs[0].id).toBe("rs1");
    expect(rc.electableSpecs).toEqual({ instanceSize: "M20", nodeCount: 3, diskIOPS: 3000 });
    expect(rc.readOnlySpecs).toEqual({ instanceSize: "M20", nodeCount: 0 });
    expect(rc.autoScaling).toEqual({ diskGB: { enabled: true }, compute: { enabled: true, scaleDownEnabled: true, minInstanceSize: "M10", maxInstanceSize: "M30" } });
    expect(tierOf({ ...CLUSTER, replicationSpecs: body.replicationSpecs })).toMatchObject({ instanceSize: "M20", autoScaling: { min: "M10", max: "M30" } });
  });
});

// Shape of the live NonProd-Twizz cluster (2026-10-14): M20, compute auto-scaling
// M10–M20 mirrored into analyticsAutoScaling, 0 analytics / 0 read-only nodes.
const LIVE = {
  name: "NonProd-Twizz",
  stateName: "IDLE",
  replicationSpecs: [
    {
      id: "rs1",
      regionConfigs: [
        {
          providerName: "AWS",
          regionName: "EU_WEST_1",
          priority: 7,
          electableSpecs: { instanceSize: "M20", diskIOPS: 3000, ebsVolumeType: "STANDARD", nodeCount: 3 },
          readOnlySpecs: { instanceSize: "M20", diskIOPS: 3000, ebsVolumeType: "STANDARD", nodeCount: 0 },
          analyticsSpecs: { instanceSize: "M10", diskIOPS: 3000, ebsVolumeType: "STANDARD", nodeCount: 0 },
          autoScaling: { compute: { enabled: true, scaleDownEnabled: true, minInstanceSize: "M10", maxInstanceSize: "M20" }, diskGB: { enabled: true } },
          analyticsAutoScaling: { compute: { enabled: true, scaleDownEnabled: true, minInstanceSize: "M10", maxInstanceSize: "M20" }, diskGB: { enabled: true } },
        },
      ],
    },
  ],
};

describe("Atlas tier on the live cluster shape", () => {
  it("reads M20 auto M10–M20", () => {
    expect(tierOf(LIVE)).toEqual({ name: "NonProd-Twizz", state: "IDLE", instanceSize: "M20", autoScaling: { min: "M10", max: "M20" } });
  });

  it("keeps analytics (0 nodes) in lockstep and touches nothing else", () => {
    const rc = tierPatch(LIVE, { instanceSize: "M30", autoScaling: { min: "M20", max: "M40" } }).replicationSpecs[0].regionConfigs[0];
    const compute = { enabled: true, scaleDownEnabled: true, minInstanceSize: "M20", maxInstanceSize: "M40" };
    expect(rc.autoScaling).toEqual({ compute, diskGB: { enabled: true } });
    expect(rc.analyticsAutoScaling).toEqual({ compute, diskGB: { enabled: true } });
    expect(rc.analyticsSpecs).toEqual({ instanceSize: "M30", diskIOPS: 3000, ebsVolumeType: "STANDARD", nodeCount: 0 });
    expect(rc.electableSpecs).toEqual({ instanceSize: "M30", diskIOPS: 3000, ebsVolumeType: "STANDARD", nodeCount: 3 });
    expect([rc.providerName, rc.regionName, rc.priority]).toEqual(["AWS", "EU_WEST_1", 7]);
  });

  it("leaves real analytics nodes alone", () => {
    const withAnalytics = structuredClone(LIVE);
    withAnalytics.replicationSpecs[0].regionConfigs[0].analyticsSpecs.nodeCount = 1;
    const rc = tierPatch(withAnalytics, { instanceSize: "M30" }).replicationSpecs[0].regionConfigs[0];
    expect(rc.analyticsSpecs.instanceSize).toBe("M10");
    expect(rc.analyticsAutoScaling.compute.maxInstanceSize).toBe("M20");
  });
});

describe("Digest auth", () => {
  it("matches the RFC 2617 §3.5 example", () => {
    const challenge = parseDigestChallenge('Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"');
    const h = digestAuthorization({ user: "Mufasa", pass: "Circle Of Life", method: "GET", uri: "/dir/index.html", challenge, cnonce: "0a4f113b" });
    expect(h).toContain('response="6629fae49393a05397450978507c4ef1"');
    expect(h).toContain("qop=auth, nc=00000001");
  });
});
