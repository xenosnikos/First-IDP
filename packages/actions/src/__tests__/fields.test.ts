import { describe, expect, it } from "vitest";
import { hashFiles, hashVars, nameList } from "../fields";

describe("gate field hashes", () => {
  it("hashFiles is order-independent and byte-sensitive", () => {
    const a = [{ path: "twizz.yaml", content: "version: 2\n" }, { path: "Dockerfile", content: "FROM node\n" }];
    const b = [a[1], a[0]];
    expect(hashFiles(a)).toBe(hashFiles(b));
    expect(hashFiles(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashFiles([{ path: "twizz.yaml", content: "version: 2 \n" }, a[1]])).not.toBe(hashFiles(a));
    expect(hashFiles([{ path: "twizz.yml", content: "version: 2\n" }, a[1]])).not.toBe(hashFiles(a));
    expect(hashFiles([])).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashVars binds names and values; nameList is sorted and deduped", () => {
    expect(hashVars({ A: "1", B: "2" })).toBe(hashVars({ B: "2", A: "1" }));
    expect(hashVars({ A: "1", B: "2" })).not.toBe(hashVars({ A: "1", B: "3" }));
    // no ambiguity between K=V boundaries
    expect(hashVars({ A: "1=2", B: "" })).not.toBe(hashVars({ A: "1", B: "2" }));
    expect(nameList(["B", "A", "B"])).toBe("A B");
  });
});
