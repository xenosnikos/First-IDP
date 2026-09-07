import { evaluatePolicy, type Policy } from "./policy";
import type { NonceStore } from "./confirm";
import type { AuditFn } from "./audit";

export type GateResult =
  | { denied: true; reason: string }
  | { confirmationRequired: true; summary: string; instruction: string; confirm: string }
  | { done: true; result: unknown }
  | { error: string };

export type Gate = (
  tool: string,
  fields: Record<string, string>,
  confirm: string | undefined,
  summary: string,
  action: () => Promise<unknown>,
) => Promise<GateResult>;

export type GateDeps = { policy: Policy; nonces: NonceStore; audit: AuditFn; actionPrefix?: string };

/** The four gates, in order: policy → confirm nonce → action → audit row
 * (success, failure, and denial alike). `fields` are the policy-relevant
 * arguments; they are what the nonce is bound to, so anything that changes the
 * effect of the action must be in them. */
export function createGate({ policy, nonces, audit, actionPrefix = "mcp." }: GateDeps): Gate {
  return async (tool, fields, confirm, summary, action) => {
    const actionName = `${actionPrefix}${tool}`;
    const resource = JSON.stringify(fields);

    const decision = evaluatePolicy(policy, tool, fields);
    if (!decision.allowed) {
      await audit({ action: actionName, resource, allowed: false, detail: { reason: decision.reason } });
      return { denied: true, reason: decision.reason };
    }

    if (!confirm) {
      const nonce = await nonces.issue(tool, fields);
      return {
        confirmationRequired: true,
        summary,
        instruction: `Re-run ${tool} with the same arguments plus confirm: "${nonce}" within 5 minutes.`,
        confirm: nonce,
      };
    }

    const consumed = await nonces.consume(confirm, tool, fields);
    if (!consumed.ok) {
      await audit({ action: actionName, resource, allowed: false, detail: { reason: consumed.reason } });
      return { denied: true, reason: consumed.reason };
    }

    try {
      const result = await action();
      await audit({ action: actionName, resource, allowed: true, detail: { result: String(result).slice(0, 500) } });
      return { done: true, result };
    } catch (e) {
      await audit({ action: actionName, resource, allowed: true, detail: { error: String(e) } });
      return { error: String(e) };
    }
  };
}
