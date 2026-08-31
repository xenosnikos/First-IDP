import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

type Policy = {
  global_deny?: string[];
  write_tools?: Record<string, { allow?: Record<string, string[]>; deny?: Record<string, string[]> }>;
};

const policyPath = join(dirname(fileURLToPath(import.meta.url)), "..", "policy.yaml");
const policy: Policy = parse(readFileSync(policyPath, "utf8"));

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

export type PolicyDecision = { allowed: true } | { allowed: false; reason: string };

/** Evaluate a write-tool call against policy.yaml. Runs BEFORE any external call. */
export function evaluatePolicy(tool: string, fields: Record<string, string>): PolicyDecision {
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
