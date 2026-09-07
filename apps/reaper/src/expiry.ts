import type { NamedEnvManifest } from "@twizz-idp/actions";

export type ExpiryDecision =
  | { name: string; action: "teardown"; expiresAt: string; overdueHours: number }
  | { name: string; action: "keep"; reason: string };

/** Which named envs are past their `expiresAt`. Unparseable dates are kept
 * (and reported) — a broken manifest must never cause a teardown. */
export function selectExpired(envs: NamedEnvManifest[], now: Date): ExpiryDecision[] {
  return envs.map((env) => {
    const t = Date.parse(env.expiresAt);
    if (Number.isNaN(t)) return { name: env.name, action: "keep", reason: `unparseable expiresAt "${env.expiresAt}"` };
    if (t >= now.getTime()) return { name: env.name, action: "keep", reason: `expires ${env.expiresAt}` };
    return { name: env.name, action: "teardown", expiresAt: env.expiresAt, overdueHours: Math.round(((now.getTime() - t) / 3_600_000) * 10) / 10 };
  });
}
