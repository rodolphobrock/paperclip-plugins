import { describe, expect, it } from "vitest";
import { isRecord, isSecretRef, readNumber, readString } from "./guards.js";

describe("isRecord", () => {
  it("accepts plain objects", () => {
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord({})).toBe(true);
  });

  it.each([[null], [undefined], [[1, 2]], ["x"], [3]])("rejects %j", (value) => {
    expect(isRecord(value)).toBe(false);
  });
});

describe("readString", () => {
  it("returns non-empty strings", () => {
    expect(readString({ a: "x" }, "a")).toBe("x");
  });

  it("returns undefined for missing, empty or non-string values", () => {
    expect(readString({}, "a")).toBeUndefined();
    expect(readString({ a: "" }, "a")).toBeUndefined();
    expect(readString({ a: 3 }, "a")).toBeUndefined();
    expect(readString(null, "a")).toBeUndefined();
    expect(readString("x", "a")).toBeUndefined();
  });
});

describe("readNumber", () => {
  it("returns finite numbers", () => {
    expect(readNumber({ a: 1.5 }, "a")).toBe(1.5);
    expect(readNumber({ a: 0 }, "a")).toBe(0);
  });

  it("returns undefined for missing, NaN or non-number values", () => {
    expect(readNumber({}, "a")).toBeUndefined();
    expect(readNumber({ a: Number.NaN }, "a")).toBeUndefined();
    expect(readNumber({ a: "1" }, "a")).toBeUndefined();
    expect(readNumber(undefined, "a")).toBeUndefined();
  });
});

describe("isSecretRef", () => {
  it("accepts the host's stored secret reference", () => {
    expect(isSecretRef({ type: "secret_ref", secretId: "s1" })).toBe(true);
    expect(isSecretRef({ type: "secret_ref", secretId: "s1", version: 2 })).toBe(true);
  });

  it.each([
    [{ type: "secret_ref" }],
    [{ type: "secret_ref", secretId: "" }],
    [{ type: "env", secretId: "s1" }],
    ["s1"],
    [null],
  ])("rejects %j", (value) => {
    expect(isSecretRef(value)).toBe(false);
  });
});
