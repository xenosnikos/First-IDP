import { describe, expect, it } from "vitest";
import { CronError, DEFAULT_SCHEDULE, cronMatches, cronNext, describeCron, parseCron } from "../lifecycle-model";

// 2026-11-25 is a Wednesday.
const at = (s: string) => new Date(s);
const next = (cron: string, after: string) => cronNext(cron, at(after))?.toISOString() ?? null;
const on = (xs: boolean[]) => xs.flatMap((v, i) => (v ? [i] : []));

describe("parseCron", () => {
  it("expands stars, values, lists, ranges and steps", () => {
    const c = parseCron("15,45 9-17/4 1-3,10 */3 1-5");
    expect(on(c.minute)).toEqual([15, 45]);
    expect(on(c.hour)).toEqual([9, 13, 17]);
    expect(on(c.dom)).toEqual([1, 2, 3, 10]);
    expect(on(c.month)).toEqual([1, 4, 7, 10]);
    expect(on(c.dow)).toEqual([1, 2, 3, 4, 5]);
    expect(on(parseCron("* * * * *").minute)).toHaveLength(60);
    expect(on(parseCron("*/15 * * * *").minute)).toEqual([0, 15, 30, 45]);
  });

  it("reads `a/step` as a-max/step and a bare value as itself", () => {
    expect(on(parseCron("10/20 * * * *").minute)).toEqual([10, 30, 50]);
    expect(on(parseCron("7 * * * *").minute)).toEqual([7]);
  });

  it("accepts month and weekday names, and 7 as Sunday", () => {
    expect(on(parseCron("0 0 1 JAN,jul *").month)).toEqual([1, 7]);
    expect(on(parseCron("0 0 * * MON-FRI").dow)).toEqual([1, 2, 3, 4, 5]);
    expect(on(parseCron("0 0 * * 7").dow)).toEqual([0]);
    expect(on(parseCron("0 0 * * 5-7").dow)).toEqual([0, 5, 6]);
  });

  it("records whether the day fields began with a star", () => {
    expect(parseCron("0 0 * * *")).toMatchObject({ domStar: true, dowStar: true });
    expect(parseCron("0 0 */2 * 1")).toMatchObject({ domStar: true, dowStar: false });
    expect(parseCron("0 0 13 * 5")).toMatchObject({ domStar: false, dowStar: false });
  });

  it("tolerates surrounding and repeated whitespace", () => {
    expect(on(parseCron("  0   6 * *\t1 ").hour)).toEqual([6]);
  });

  it.each([
    ["* * * *", "expected 5 fields"],
    ["* * * * * *", "expected 5 fields"],
    ["", "expected 5 fields"],
    ["@daily", "expected 5 fields"],
    ["60 * * * *", "outside 0-59"],
    ["* 24 * * *", "outside 0-23"],
    ["0 0 0 * *", "outside 1-31"],
    ["0 0 32 * *", "outside 1-31"],
    ["0 0 * 13 *", "outside 1-12"],
    ["0 0 * 0 *", "outside 1-12"],
    ["0 0 * * 8", "outside 0-7"],
    ["*/0 * * * *", "positive integer"],
    ["*/x * * * *", "positive integer"],
    ["1/2/3 * * * *", "more than one step"],
    ["5-1 * * * *", "runs backwards"],
    ["1,,2 * * * *", "empty list item"],
    ["1- * * * *", "bad range"],
    ["1-2-3 * * * *", "bad range"],
    ["a * * * *", "not a number"],
    ["-1 * * * *", "bad range"],
    ["1.5 * * * *", "not a number"],
    ["0 0 ? * *", "not a number"],
    ["0 0 L * *", "not a number"],
    ["0 0 * FOO *", "not a number"],
  ])("rejects %j", (expr, message) => {
    expect(() => parseCron(expr)).toThrow(CronError);
    expect(() => parseCron(expr)).toThrow(message);
  });
});

describe("cronNext (UTC)", () => {
  it("evaluates the six schedules of the design contract", () => {
    const now = "2026-11-25T12:00:00Z";
    expect(next("0 6 * * 1", now)).toBe("2026-11-30T06:00:00.000Z"); // plan: Mondays
    expect(next("30 5 * * *", now)).toBe("2026-11-26T05:30:00.000Z"); // cve: daily
    expect(next("0 7 2 * *", now)).toBe("2026-12-02T07:00:00.000Z"); // source: the 2nd
    expect(next("*/5 * * * *", "2026-11-25T12:03:10Z")).toBe("2026-11-25T12:05:00.000Z"); // dispatch
    expect(next("0 7 * * 2", now)).toBe("2026-12-01T07:00:00.000Z"); // promote-prod: Tuesdays
    for (const e of DEFAULT_SCHEDULE) expect(cronNext(e.cron, at(now))).not.toBeNull();
  });

  it("is strictly after the given instant", () => {
    expect(next("30 5 * * *", "2026-11-25T05:29:59.999Z")).toBe("2026-11-25T05:30:00.000Z");
    expect(next("30 5 * * *", "2026-11-25T05:30:00.000Z")).toBe("2026-11-26T05:30:00.000Z");
    expect(next("30 5 * * *", "2026-11-25T05:30:30.000Z")).toBe("2026-11-26T05:30:00.000Z");
    expect(next("* * * * *", "2026-11-25T05:30:00.000Z")).toBe("2026-11-25T05:31:00.000Z");
  });

  it("uses lists, ranges and steps together", () => {
    // 09:15, 09:45, 13:15, 13:45, 17:15, 17:45 on weekdays
    expect(next("15,45 9-17/4 * * 1-5", "2026-11-27T09:15:00Z")).toBe("2026-11-27T09:45:00.000Z");
    expect(next("15,45 9-17/4 * * 1-5", "2026-11-27T09:45:00Z")).toBe("2026-11-27T13:15:00.000Z");
    // Friday evening → Monday morning
    expect(next("15,45 9-17/4 * * 1-5", "2026-11-27T17:45:00Z")).toBe("2026-11-30T09:15:00.000Z");
  });

  it("applies the day rule: both day fields restricted → EITHER matches", () => {
    // the 13th OR any Friday
    expect(next("0 0 13 * 5", "2026-11-25T12:00:00Z")).toBe("2026-11-27T00:00:00.000Z"); // a Friday
    expect(next("0 0 13 * 5", "2026-12-04T00:00:00Z")).toBe("2026-12-11T00:00:00.000Z"); // a Friday
    expect(next("0 0 13 * 5", "2026-12-11T00:00:00Z")).toBe("2026-12-13T00:00:00.000Z"); // Sunday the 13th
    expect(cronMatches("0 0 13 * 5", at("2026-12-13T00:00:00Z"))).toBe(true);
    expect(cronMatches("0 0 13 * 5", at("2026-12-12T00:00:00Z"))).toBe(false);
  });

  it("applies the day rule: a starred day field leaves the other one to decide", () => {
    // every Friday, whatever the date
    expect(next("0 0 * * 5", "2026-12-11T00:00:00Z")).toBe("2026-12-18T00:00:00.000Z");
    // the 13th, whatever the weekday
    expect(next("0 0 13 * *", "2026-11-25T00:00:00Z")).toBe("2026-12-13T00:00:00.000Z");
    // a STEPPED star still counts as a star: odd days that are ALSO Fridays
    expect(next("0 0 */2 * 5", "2026-11-25T00:00:00Z")).toBe("2026-11-27T00:00:00.000Z");
    expect(next("0 0 */2 * 5", "2026-11-27T00:00:00Z")).toBe("2026-12-11T00:00:00.000Z"); // Dec 4 is even
  });

  it("rolls over months and years, and knows month lengths", () => {
    expect(next("59 23 31 12 *", "2026-12-31T23:59:00Z")).toBe("2027-12-31T23:59:00.000Z");
    expect(next("0 0 1 1 *", "2026-11-25T00:00:00Z")).toBe("2027-01-01T00:00:00.000Z");
    expect(next("0 0 31 * *", "2026-11-25T00:00:00Z")).toBe("2026-12-31T00:00:00.000Z"); // November has 30 days
    expect(next("0 0 30 * *", "2027-01-30T00:00:00Z")).toBe("2027-03-30T00:00:00.000Z"); // February has no 30th
    expect(next("0 0 1 JAN,JUL *", "2026-11-25T00:00:00Z")).toBe("2027-01-01T00:00:00.000Z");
    expect(next("0 0 * * 7", "2026-11-25T00:00:00Z")).toBe("2026-11-29T00:00:00.000Z"); // 7 = Sunday
  });

  it("finds a leap day and gives up on a date that never comes", () => {
    expect(next("0 0 29 2 *", "2026-11-25T00:00:00Z")).toBe("2028-02-29T00:00:00.000Z");
    expect(next("0 0 29 2 *", "2096-03-01T00:00:00Z")).toBe("2104-02-29T00:00:00.000Z"); // 2100 is not a leap year
    expect(next("0 0 31 2 *", "2026-11-25T00:00:00Z")).toBeNull();
    expect(next("0 0 30 2 *", "2026-11-25T00:00:00Z")).toBeNull();
    expect(next("0 0 31 4,6,9,11 *", "2026-11-25T00:00:00Z")).toBeNull();
  });

  it("does not depend on the machine's time zone or DST (pure UTC arithmetic)", () => {
    // across the EU and US DST changes of spring 2027: always exactly 24 h apart
    let t = at("2027-03-10T05:30:00Z");
    for (let i = 0; i < 25; i++) {
      const n = cronNext("30 5 * * *", t)!;
      expect(n.getTime() - t.getTime()).toBe(24 * 3_600_000);
      t = n;
    }
  });

  it("throws on an invalid expression instead of inventing a time", () => {
    expect(() => cronNext("nope", at("2026-11-25T00:00:00Z"))).toThrow(CronError);
  });

  it("every returned instant matches its own expression", () => {
    for (const cron of ["15,45 9-17/4 * * 1-5", "0 0 13 * 5", "*/7 */5 */3 * *", "0 22 * 1-6 SUN", "5 4 1,15 * 3"]) {
      let t = at("2026-11-25T12:00:00Z");
      for (let i = 0; i < 40; i++) {
        const n = cronNext(cron, t)!;
        expect(n.getTime()).toBeGreaterThan(t.getTime());
        expect(cronMatches(cron, n)).toBe(true);
        expect(n.getUTCSeconds() + n.getUTCMilliseconds()).toBe(0);
        t = n;
      }
    }
  });

  it("never skips a matching minute (checked against a brute-force scan)", () => {
    for (const cron of ["0 0 13 * 5", "15,45 9-17/4 * * 1-5", "0 0 */2 * 5", "30 5 * * *", "0 7 2 * *"]) {
      const start = at("2026-11-25T12:00:00Z");
      const spec = parseCron(cron);
      const expected: number[] = [];
      for (let t = start.getTime() + 60_000; expected.length < 6; t += 60_000) if (cronMatches(spec, new Date(t))) expected.push(t);
      const got: number[] = [];
      let t = start;
      for (let i = 0; i < 6; i++) {
        t = cronNext(cron, t)!;
        got.push(t.getTime());
      }
      expect(got).toEqual(expected);
    }
  });
});

describe("describeCron", () => {
  it("puts the contract's schedules into words", () => {
    expect(describeCron("0 6 * * 1")).toBe("weekly on Monday at 06:00 UTC");
    expect(describeCron("30 5 * * *")).toBe("daily at 05:30 UTC");
    expect(describeCron("0 7 2 * *")).toBe("monthly on the 2nd at 07:00 UTC");
    expect(describeCron("*/5 * * * *")).toBe("every 5 minutes");
    expect(describeCron("0 7 * * 2")).toBe("weekly on Tuesday at 07:00 UTC");
  });

  it("handles a few more common shapes", () => {
    expect(describeCron("17 * * * *")).toBe("hourly at :17");
    expect(describeCron("*/1 * * * *")).toBe("every minute");
    expect(describeCron("0 9 * * 1,3")).toBe("weekly on Monday, Wednesday at 09:00 UTC");
    expect(describeCron("0 9 1,11,21,22,23 * *")).toBe("monthly on the 1st, 11th, 21st, 22nd, 23rd at 09:00 UTC");
  });

  it("returns the expression itself rather than guess", () => {
    for (const expr of ["15,45 9-17/4 * * 1-5", "0 0 13 * 5", "0 0 1 1 *", "0 6,18 * * *", "not a cron", "*/5 9 * * *"]) expect(describeCron(expr)).toBe(expr);
  });
});
