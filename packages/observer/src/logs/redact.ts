// Secrets must never reach the model, a tool result, or a stored sample.
// Patterns are ordered from most to least specific; each replacement keeps the
// key (so the model can still reason about "an Authorization header") and
// masks the value. Counts are reported, originals never are.

export type Redaction = { text: string; counts: Record<string, number> };

type Rule = { kind: string; re: RegExp; replace: string };

const RULES: Rule[] = [
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, replace: "[REDACTED:jwt]" },
  { kind: "bearer", re: /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/g, replace: "$1 [REDACTED:bearer]" },
  { kind: "aws-key", re: /\bAKIA[0-9A-Z]{16}\b/g, replace: "[REDACTED:aws-key]" },
  { kind: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{10,}/g, replace: "[REDACTED:anthropic-key]" },
  { kind: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replace: "[REDACTED:github-token]" },
  { kind: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, replace: "[REDACTED:slack-token]" },
  { kind: "uri-credentials", re: /(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi, replace: "$1$2:[REDACTED:password]@" },
  {
    kind: "kv-secret",
    re: /\b(password|passwd|pwd|secret|token|api[_-]?key|apikey|authorization|x-api-key|private[_-]?key|client[_-]?secret|access[_-]?key)(\s*["']?\s*[:=]\s*["']?)(?!\[REDACTED)([^\s"',;}\]]{4,})/gi,
    replace: "$1$2[REDACTED:value]",
  },
  // Long opaque tokens: base64/hex ≥ 40 chars with mixed case+digits or padding.
  { kind: "opaque-token", re: /\b(?=[A-Za-z0-9+/=_-]{40,}\b)(?=[^\s]*[A-Z])(?=[^\s]*[a-z])(?=[^\s]*\d)[A-Za-z0-9+/=_-]{40,}\b/g, replace: "[REDACTED:token]" },
];

export function redact(text: string): Redaction {
  const counts: Record<string, number> = {};
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.re, (...m) => {
      counts[rule.kind] = (counts[rule.kind] ?? 0) + 1;
      // emulate $1/$2 substitution
      return rule.replace.replace(/\$(\d)/g, (_, i) => String(m[Number(i)] ?? ""));
    });
  }
  return { text: out, counts };
}

export function redactionTotal(counts: Record<string, number>): number {
  return Object.values(counts).reduce((a, b) => a + b, 0);
}

export function mergeCounts(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v;
  return out;
}
