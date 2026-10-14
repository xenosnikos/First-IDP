// Rough list prices for the capacity planner's cost delta (eu-west-1, USD).
// Deliberately coarse — the plan shows "≈ $/month" to compare presets, not to
// bill anyone. Update by hand when AWS/Atlas pricing moves materially.
import type { AtlasTier } from "@twizz-idp/shared";

export const HOURS_PER_MONTH = 730;

/** $/hour per vCPU and per GiB, blended across m/c/t instance families. */
export const EC2_PRICE = {
  spot: { vcpu: 0.014, gib: 0.0019 },
  onDemand: { vcpu: 0.0431, gib: 0.0058 },
} as const;

/** Atlas dedicated cluster (3-node replica set, AWS eu-west-1), $/hour. */
export const ATLAS_PRICE: Record<AtlasTier, number> = {
  M10: 0.09,
  M20: 0.22,
  M30: 0.59,
  M40: 1.13,
  M50: 2.17,
  M60: 4.27,
  M80: 7.95,
  M140: 11.91,
  M200: 15.86,
};

/** Atlas limits used to pick a tier from an estimate. */
export const ATLAS_LIMITS: Record<AtlasTier, { ramGi: number; maxConns: number }> = {
  M10: { ramGi: 2, maxConns: 1500 },
  M20: { ramGi: 4, maxConns: 3000 },
  M30: { ramGi: 8, maxConns: 3000 },
  M40: { ramGi: 16, maxConns: 6000 },
  M50: { ramGi: 32, maxConns: 16000 },
  M60: { ramGi: 64, maxConns: 32000 },
  M80: { ramGi: 128, maxConns: 96000 },
  M140: { ramGi: 192, maxConns: 96000 },
  M200: { ramGi: 256, maxConns: 128000 },
};
