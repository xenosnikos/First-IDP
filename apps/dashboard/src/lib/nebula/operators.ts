// Nebula operator allowlist (docs/NEBULA.md §4.6). Read access is every
// signed-in org member; WRITE access (spin up / extend / re-clone / tear down)
// is the operator set. Pure and unit-tested; the tRPC router and the page
// both call this.

export const DEFAULT_OPERATORS = ["nick", "igor"] as const;

export function parseOperators(raw: string | undefined): string[] {
  const list = (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.length ? list : [...DEFAULT_OPERATORS];
}

export function isOperator(login: string | null | undefined, raw: string | undefined = process.env.NEBULA_OPERATORS): boolean {
  if (!login) return false;
  return parseOperators(raw).includes(login.trim().toLowerCase());
}
