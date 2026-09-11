import type { NamedEnvManifest } from "@twizz-idp/actions";
import { pendingKeepAlive } from "./builds";

export type ExpiryDecision =
  | { name: string; action: "teardown"; expiresAt: string; overdueHours: number }
  | { name: string; action: "keep"; reason: string };

/** Which named envs are past their `expiresAt`. Unparseable dates are kept
 * (and reported) — a broken manifest must never cause a teardown. */
export function selectExpired(envs: NamedEnvManifest[], now: Date, pending: NamedEnvManifest[] = []): ExpiryDecision[] {
  const all = [...envs, ...pending.map((p) => ({ ...p, __pending: true }))];
  return all.map((env) => {
    if ((env as { __pending?: boolean }).__pending && pendingKeepAlive(env, now)) return { name: env.name, action: "keep", reason: "build in flight" };
    const t = Date.parse(env.expiresAt);
    if (Number.isNaN(t)) return { name: env.name, action: "keep", reason: `unparseable expiresAt "${env.expiresAt}"` };
    if (t >= now.getTime()) return { name: env.name, action: "keep", reason: `expires ${env.expiresAt}` };
    return { name: env.name, action: "teardown", expiresAt: env.expiresAt, overdueHours: Math.round(((now.getTime() - t) / 3_600_000) * 10) / 10 };
  });
}
