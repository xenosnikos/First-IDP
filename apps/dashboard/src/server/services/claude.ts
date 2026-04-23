import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? "",
});

export class ClaudeService {
  async generateChangeSummary(
    commits: Array<{ sha: string; message: string; author: string }>,
  ): Promise<string> {
    if (commits.length === 0) return "No changes in this release.";

    const commitList = commits
      .map((c) => `- ${c.sha.slice(0, 7)} (${c.author}): ${c.message}`)
      .join("\n");

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6-20250514",
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content: `Summarize these git commits into a structured changelog for a release document. Group by: Features, Fixes, Improvements, Chores. Use bullet points. Be concise but informative. If a commit uses conventional commit format, use the type to categorize it.\n\nCommits:\n${commitList}`,
        },
      ],
    });

    const block = response.content[0];
    return block.type === "text" ? block.text : "Failed to generate summary.";
  }

  async detectRiskyOperations(
    diff: string,
  ): Promise<Array<{ file: string; line: number; risk: string; severity: "high" | "medium" | "low" }>> {
    if (!diff.trim()) return [];

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6-20250514",
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content: `Analyze this code diff for risky operations. Look for:\n- Bulk deletes or drops\n- Unguarded database writes (no transaction, no validation)\n- Missing authentication/authorization checks\n- Missing rate limiting on public endpoints\n- Hardcoded secrets or credentials\n- SQL injection or NoSQL injection vectors\n- Unbounded queries (no limit/pagination)\n\nReturn a JSON array of findings: [{"file": "path", "line": number, "risk": "description", "severity": "high"|"medium"|"low"}]\n\nIf no risks found, return []\n\nDiff:\n${diff.slice(0, 15000)}`,
        },
      ],
    });

    const block = response.content[0];
    if (block.type !== "text") return [];

    try {
      const jsonMatch = block.text.match(/\[[\s\S]*\]/);
      return jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    } catch {
      return [];
    }
  }

  async generateBreakingChangeReport(
    commits: Array<{ sha: string; message: string }>,
  ): Promise<string[]> {
    return commits
      .filter(
        (c) =>
          c.message.includes("BREAKING CHANGE") ||
          /^[a-z]+(\(.+\))?!:/.test(c.message),
      )
      .map((c) => `${c.sha.slice(0, 7)}: ${c.message.split("\n")[0]}`);
  }
}

export const claudeService = new ClaudeService();
