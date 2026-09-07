import { readFileSync } from "node:fs";
import { parse } from "yaml";

export type Policy = {
  global_deny?: string[];
  write_tools?: Record<string, { allow?: Record<string, string[]>; deny?: Record<string, string[]> }>;
};

export type PolicyDecision = { allowed: true } | { allowed: false; reason: string };

/** Load a policy.yaml (the MCP server's lives at apps/mcp/policy.yaml). */
export function loadPolicyFile(path: string): Policy {
  return parse(readFileSync(path, "utf8")) as Policy;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** Evaluate a write-tool call against a policy. Runs BEFORE any external call.
 * Order: global_deny over every field value → tool must have an entry (default
 * deny) → per-tool deny patterns → every allow-constrained field must match. */
export function evaluatePolicy(policy: Policy, tool: string, fields: Record<string, string>): PolicyDecision {
  for (const value of Object.values(fields)) {
    for (const pattern of policy.global_deny ?? []) {
      if (globToRegExp(pattern).test(value)) {
        return { allowed: false, reason: `"${value}" matches global deny pattern "${pattern}"` };
      }
    }
  }

  const rules = policy.write_tools?.[tool];
  if (!rules) {
    return { allowed: false, reason: `tool "${tool}" has no policy entry — denied by default` };
  }

  for (const [field, patterns] of Object.entries(rules.deny ?? {})) {
    const value = fields[field];
    if (value !== undefined && patterns.some((p) => globToRegExp(p).test(value))) {
      return { allowed: false, reason: `${field}="${value}" is denied for ${tool}` };
    }
  }

  for (const [field, patterns] of Object.entries(rules.allow ?? {})) {
    const value = fields[field];
    if (value === undefined) {
      return { allowed: false, reason: `missing required field "${field}"` };
    }
    if (!patterns.some((p) => globToRegExp(p).test(value))) {
      return {
        allowed: false,
        reason: `${field}="${value}" not in allowlist for ${tool} (${patterns.join(", ")})`,
      };
    }
  }

  return { allowed: true };
}
