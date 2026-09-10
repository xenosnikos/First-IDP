import { describe, expect, it } from "vitest";
import {
  assignDisplayLevels,
  deploymentOf,
  detectLevel,
  embedText,
  groupLines,
  joinMultiline,
  normalizeLine,
  ORPHAN_HEAD,
  podShort,
  redact,
  renderCompact,
  signatureHash,
  signatureOf,
  stripAnsi,
  templatePath,
  timeline,
  type LogLine,
} from "../logs";

const POD = "email-service-deployment-984d98f7b-m5qts";
const OTHER_POD = "payment-serv-deployment-59d6764c8f-6674x";
const ESC = "\x1b";
const NEST_DEBUG = `${ESC}[95m[Nest] 29  - ${ESC}[39m09/10/2026, 7:45:00 AM ${ESC}[95m  DEBUG${ESC}[39m ${ESC}[38;5;3m[TasksService] ${ESC}[39m${ESC}[95mCron running every 15 mins${ESC}[39m`;
const NEST_ERROR = `[Nest] 29  - 09/10/2026, 7:40:00 AM   ERROR [TasksService] AxiosError: Request failed with status code 404`;
const FRAME = "    at TasksService.applePayRecurring (/var/www/html/loly/src/modules/payment/services/cron.service.ts:80:5)";
const DUMP = "      statusCode: 404,";
const DUMP_AUTH = "        'Authorization: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzZXJ2aWNlIjoiZjliM2UxYThkNGM5ZjciLCJpYXQiOjE3ODkwMjYwMDB9.xZCP2KmQw_96abcdefghij'";

const line = (message: string, ts: string, pod = POD): LogLine => ({ timestamp: ts, message, podName: pod, containerName: "email-service" });

describe("stripAnsi / detectLevel", () => {
  it("strips ANSI and parses the Nest prefix with context", () => {
    expect(stripAnsi(NEST_DEBUG)).toContain("[Nest] 29  - 09/10/2026, 7:45:00 AM   DEBUG [TasksService] Cron running every 15 mins");
    const l = detectLevel(NEST_DEBUG);
    expect(l).toMatchObject({ level: "DEBUG", context: "TasksService", continuation: false, body: "Cron running every 15 mins" });
    expect(detectLevel(NEST_ERROR).level).toBe("ERROR");
    expect(detectLevel("[Nest] 1  - 09/10/2026, 7:45:00 AM     LOG [Bootstrap] up").level).toBe("INFO");
  });

  it("detects pino, generic, and error-shaped lines", () => {
    expect(detectLevel('{"level":50,"msg":"boom"}').level).toBe("ERROR");
    expect(detectLevel('{"level":"warn","msg":"x"}').level).toBe("WARN");
    expect(detectLevel("2026-09-10 07:40:00 WARN something").level).toBe("WARN");
    expect(detectLevel("Traceback (most recent call last):").level).toBe("ERROR");
    expect(detectLevel("panic: runtime error: index out of range").level).toBe("FATAL");
    expect(detectLevel("just some text").level).toBe("UNKNOWN");
  });

  it("classifies frames and dump lines as continuation", () => {
    expect(detectLevel(FRAME).continuation).toBe(true);
    expect(detectLevel(DUMP).continuation).toBe(true);
    expect(detectLevel("}").continuation).toBe(true);
    expect(detectLevel("").continuation).toBe(true);
    expect(detectLevel(NEST_DEBUG).continuation).toBe(false);
  });

  it("caps very long lines before regex work", () => {
    const huge = "ERROR " + "a".repeat(200_000);
    const t0 = performance.now();
    const r = detectLevel(huge);
    signatureOf(r.body);
    redact(r.body);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(r.body.length).toBeLessThan(4100);
  });
});

describe("joinMultiline", () => {
  it("folds frames and dumps into the preceding record of the same pod only", () => {
    const lines = [
      line(NEST_ERROR, "2026-09-10T07:40:00.186Z"),
      line(FRAME, "2026-09-10T07:40:00.186Z"),
      line(DUMP, "2026-09-10T07:40:00.187Z"),
      line(DUMP, "2026-09-10T07:40:00.187Z", OTHER_POD),
      line(NEST_DEBUG, "2026-09-10T07:45:00.003Z"),
    ].map(normalizeLine);
    const recs = joinMultiline(lines);
    expect(recs).toHaveLength(3);
    expect(recs[0].continuationLines).toHaveLength(2);
    expect(recs[1].pod).toBe(OTHER_POD);
    expect(recs[1].level).toBe("UNKNOWN");
    expect(recs[1].text).toBe(ORPHAN_HEAD);
    expect(recs[1].continuationLines).toEqual([DUMP]);
    expect(recs[2].level).toBe("DEBUG");
  });

  it("caps folded lines and counts the rest", () => {
    const lines = [line(NEST_ERROR, "2026-09-10T07:40:00.000Z"), ...Array.from({ length: 70 }, (_, i) => line(DUMP + i, "2026-09-10T07:40:00.001Z"))].map(normalizeLine);
    const recs = joinMultiline(lines);
    expect(recs).toHaveLength(1);
    expect(recs[0].continuationLines).toHaveLength(60);
    expect(recs[0].omitted).toBe(10);
  });

  it("assigns display levels to continuation lines from their parent", () => {
    const out = assignDisplayLevels([line(NEST_ERROR, "t"), line(FRAME, "t")].map(normalizeLine));
    expect(out[1].effectiveLevel).toBe("ERROR");
  });
});

describe("signature", () => {
  it("masks identifiers so repeats share a signature", () => {
    const a = signatureOf("user 66f1a2b3c4d5e6f7a8b9c0d1 paid 12.50 at 2026-09-10T07:40:00Z from 10.0.1.7 id=3f2504e0-4f89-11d3-9a0c-0305e82c3301");
    const b = signatureOf("user 5e9f8a7b6c5d4e3f2a1b0c9d paid 3 at 2026-09-11T01:02:03Z from 10.0.9.9 id=9c858901-8a57-4791-81fe-4c455b099bc9");
    expect(a).toBe(b);
    expect(a).toBe("user :id paid :n at :ts from :ip id=:uuid");
  });

  it("keeps file paths but drops line:column, masks long quoted strings and emails", () => {
    expect(templatePath(FRAME)).toBe("at TasksService.applePayRecurring (/var/www/html/loly/src/modules/payment/services/cron.service.ts)");
    expect(templatePath(`token "${"x".repeat(40)}" for a@b.co`)).toBe('token ":str" for :email');
  });

  it("hashes stably and shortens pod names", () => {
    expect(signatureHash("a")).toBe(signatureHash("a"));
    expect(signatureHash("a")).not.toBe(signatureHash("b"));
    expect(podShort(POD)).toBe("email-service-deployment-…m5qts");
    expect(deploymentOf(POD)).toBe("email-service-deployment");
    expect(deploymentOf("fluent-bit-k7x2p")).toBe("fluent-bit");
    expect(deploymentOf("postgres-0")).toBe("postgres");
  });
});

describe("redact", () => {
  it("masks tokens and keeps keys, counting each kind", () => {
    const r = redact(`${DUMP_AUTH}\nBearer abcDEF123456789xyz\nAKIAIOSFODNN7EXAMPLE\npassword: "hunter22"\nmongodb+srv://u:p4ss@host/db\nsk-ant-api03-abcdefghijk`);
    expect(r.text).not.toMatch(/eyJ/);
    expect(r.text).toContain("Authorization: [REDACTED:jwt]");
    expect(r.text).toContain("Bearer [REDACTED:bearer]");
    expect(r.text).toContain("[REDACTED:aws-key]");
    expect(r.text).toContain('password: "[REDACTED:value]');
    expect(r.text).toContain("mongodb+srv://u:[REDACTED:password]@host/db");
    expect(r.text).toContain("[REDACTED:anthropic-key]");
    expect(r.counts.jwt).toBe(1);
    expect(r.counts.bearer).toBe(1);
  });

  it("leaves ordinary words and ObjectIds alone, and is idempotent", () => {
    const s = "token refresh scheduled for user 66f1a2b3c4d5e6f7a8b9c0d1 sha 3b1f0d9c8e7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c";
    const once = redact(s);
    expect(once.text).toBe(s);
    expect(redact(once.text).text).toBe(once.text);
  });
});

describe("groupLines / renderCompact", () => {
  const lines = [
    line(NEST_DEBUG, "2026-09-10T07:30:00.003Z"),
    line(NEST_ERROR, "2026-09-10T07:40:00.186Z"),
    line(FRAME, "2026-09-10T07:40:00.186Z"),
    line(DUMP_AUTH, "2026-09-10T07:40:00.187Z"),
    line(NEST_DEBUG, "2026-09-10T07:45:00.003Z"),
    line(NEST_DEBUG, "2026-09-10T07:45:00.976Z", OTHER_POD),
    line(NEST_ERROR, "2026-09-10T07:50:00.186Z"),
  ].map(normalizeLine);

  it("groups by signature with counts, ordering, pods, redacted samples", () => {
    const groups = groupLines(lines);
    expect(groups[0].level).toBe("ERROR");
    expect(groups[0].count).toBe(2);
    expect(groups[0].first).toBe("2026-09-10T07:40:00.186Z");
    expect(groups[0].last).toBe("2026-09-10T07:50:00.186Z");
    expect(groups[0].sample).toContain("[REDACTED:jwt]");
    expect(groups[0].sampleRedactions).toBe(1);
    expect(groups[0].context).toBe("TasksService");
    expect(groups[1].level).toBe("DEBUG");
    expect(groups[1].count).toBe(3);
    expect(Object.keys(groups[1].pods)).toEqual([POD, OTHER_POD]);
    expect(embedText(groups[0])).toMatch(/^ERROR \| AxiosError/);
  });

  it("respects the byte budget honestly and deterministically", () => {
    const groups = groupLines(lines);
    const full = renderCompact(groups, { maxChars: 10_000, totalLines: lines.length, status: "complete" });
    expect(full.text).toContain("[ERROR ×2 07:40:00→07:50:00 pods=email-service-deployment-…m5qts(2) [TasksService]]");
    expect(full.text).toContain("query status: complete");
    expect(full.text).toBe(renderCompact(groups, { maxChars: 10_000, totalLines: lines.length, status: "complete" }).text);
    const tight = renderCompact(groups, { maxChars: 420, totalLines: lines.length, status: "timeout" });
    expect(tight.chars).toBeLessThanOrEqual(420);
    expect(tight.text).toContain("query status: timeout");
    expect(tight.shownGroups + tight.truncatedGroups).toBe(groups.length);
    expect(tight.text).toContain("[ERROR ×2");
  });

  it("builds a timeline with error counts", () => {
    const tl = timeline(lines, 5);
    expect(tl.map((b) => b.count)).toEqual([1, 3, 2, 1]);
    expect(tl[1].errors).toBe(1);
  });
});
