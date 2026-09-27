import { describe, expect, it } from "vitest";
import { compareSeverity, isSeverity, SEVERITIES, TONES } from "./severity.js";

describe("SEVERITIES", () => {
  it("lists severities from lowest to highest", () => {
    expect(SEVERITIES).toEqual(["low", "normal", "high", "urgent"]);
  });
});

describe("TONES", () => {
  it("lists the four tones", () => {
    expect(TONES).toEqual(["info", "success", "warning", "failure"]);
  });
});

describe("compareSeverity", () => {
  it("orders low < normal < high < urgent", () => {
    expect(compareSeverity("low", "normal")).toBeLessThan(0);
    expect(compareSeverity("normal", "high")).toBeLessThan(0);
    expect(compareSeverity("high", "urgent")).toBeLessThan(0);
    expect(compareSeverity("urgent", "low")).toBeGreaterThan(0);
  });

  it("returns 0 for equal severities", () => {
    expect(compareSeverity("high", "high")).toBe(0);
  });
});

describe("isSeverity", () => {
  it("accepts known severities", () => {
    for (const s of SEVERITIES) expect(isSeverity(s)).toBe(true);
  });

  it.each([["critical"], [""], [null], [undefined], [3], [{}]])("rejects %j", (value) => {
    expect(isSeverity(value)).toBe(false);
  });
});
