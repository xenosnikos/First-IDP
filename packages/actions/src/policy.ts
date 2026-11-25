import { readFileSync } from "node:fs";
import { parse } from "yaml";

export type Policy = {
  global_deny?: string[];
  write_tools?: Record<
    string,
    {
      allow?: Record<string, string[]>;
      deny?: Record<string, string[]>;
      exempt_global_deny?: string[];
      /** Fields whose value is a SPACE-JOINED LIST: the allow and deny patterns are applied to
       * EACH item, never to the joined string. Without this a glob would match across items
       * (`plo-*` matches "plo-a anything-else", `*:nb-plo-*` matches "svc:latest x:nb-plo-y"). */
      each?: string[];
    }
  >;
};

export type PolicyDecision = { allowed: true } | { allowed: false; reason: string };

/** Load a policy.yaml (the MCP server's lives at apps/mcp/policy.yaml). */
export function loadPolicyFile(path: string): Policy {
  return parse(readFileSync(path, "utf8")) as Policy;
}

function globToRegExp(glob: string): RegExp {
  // `*` is the only wildcard; every other character is literal (a `?` must not become a regex quantifier)
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** Evaluate a write-tool call against a policy. Runs BEFORE any external call.
 * Order: global_deny over every field value → tool must have an entry (default
 * deny) → per-tool deny patterns → every allow-constrained field must match. */
export function evaluatePolicy(policy: Policy, tool: string, fields: Record<string, string>): PolicyDecision {
  // A tool may name fields that are exempt from global_deny (explicit, per
  // tool, in policy.yaml — e.g. apply_live_capacity's `tier: production`).
  // Every other field of that tool is still checked, and its allowlist applies.
  const exempt = new Set(policy.write_tools?.[tool]?.exempt_global_deny ?? []);
  for (const [field, value] of Object.entries(fields)) {
    if (exempt.has(field)) continue;
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

  // a list field is judged item by item (an empty list has no item to allow: it is refused)
  const each = new Set(rules.each ?? []);
  const itemsOf = (field: string, value: string): string[] => (each.has(field) ? value.split(" ") : [value]);

  for (const [field, patterns] of Object.entries(rules.deny ?? {})) {
    const value = fields[field];
    if (value === undefined) continue;
    for (const item of itemsOf(field, value)) {
      if (patterns.some((p) => globToRegExp(p).test(item))) {
        return { allowed: false, reason: `${field}="${item}" is denied for ${tool}` };
      }
    }
  }

  for (const [field, patterns] of Object.entries(rules.allow ?? {})) {
    const value = fields[field];
    if (value === undefined) {
      return { allowed: false, reason: `missing required field "${field}"` };
    }
    for (const item of itemsOf(field, value)) {
      if (!patterns.some((p) => globToRegExp(p).test(item))) {
        return {
          allowed: false,
          reason: `${field}="${item}" not in allowlist for ${tool} (${patterns.join(", ")})`,
        };
      }
    }
  }

  return { allowed: true };
}
