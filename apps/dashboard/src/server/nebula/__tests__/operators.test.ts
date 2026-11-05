import { describe, expect, it } from "vitest";
import { DEFAULT_OPERATORS, isOperator, parseOperators } from "@/lib/nebula/operators";

describe("operator allowlist (NEBULA_OPERATORS)", () => {
  it("defaults to nick + igor", () => {
    expect(parseOperators(undefined)).toEqual([...DEFAULT_OPERATORS]);
    expect(parseOperators("")).toEqual([...DEFAULT_OPERATORS]);
    expect(parseOperators(" , ")).toEqual([...DEFAULT_OPERATORS]);
  });
  it("parses, trims and lower-cases", () => {
    expect(parseOperators(" Nick, IGOR ,alice")).toEqual(["nick", "igor", "alice"]);
  });
  it("matches logins case-insensitively; never on empty", () => {
    expect(isOperator("Nick", undefined)).toBe(true);
    expect(isOperator("igor", "nick,igor")).toBe(true);
    expect(isOperator("mallory", "nick,igor")).toBe(false);
    expect(isOperator("", "nick")).toBe(false);
    expect(isOperator(null, "nick")).toBe(false);
    expect(isOperator(undefined, "nick")).toBe(false);
  });
  it("an explicit list replaces the default (does not union)", () => {
    expect(isOperator("nick", "alice")).toBe(false);
  });
});
