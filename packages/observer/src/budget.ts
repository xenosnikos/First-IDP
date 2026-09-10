export type Budget = { tryConsume(actor: string): Promise<boolean> };

export type BudgetVerdict = { word: "PASS" | "DENIED"; reason?: string };

export function budgetVerdict(i: { runsToday: number; actorRunsToday: number; dailyCap: number; perActorCap: number }): BudgetVerdict {
  if (i.actorRunsToday >= i.perActorCap) return { word: "DENIED", reason: `you have used ${i.actorRunsToday} of ${i.perActorCap} Observer runs today` };
  if (i.runsToday >= i.dailyCap) return { word: "DENIED", reason: `Nebula has used ${i.runsToday} of ${i.dailyCap} Observer runs today` };
  return { word: "PASS" };
}

/** Single-process counter (MCP server, tests). */
export class MemoryBudget implements Budget {
  private counts = new Map<string, number>();
  constructor(private readonly perActorCap: number, private readonly dailyCap: number) {}
  async tryConsume(actor: string): Promise<boolean> {
    const day = new Date().toISOString().slice(0, 10);
    const key = `${day}|${actor}`;
    const all = [...this.counts.entries()].filter(([k]) => k.startsWith(day)).reduce((a, [, v]) => a + v, 0);
    const mine = this.counts.get(key) ?? 0;
    if (budgetVerdict({ runsToday: all, actorRunsToday: mine, dailyCap: this.dailyCap, perActorCap: this.perActorCap }).word === "DENIED") return false;
    this.counts.set(key, mine + 1);
    return true;
  }
}
