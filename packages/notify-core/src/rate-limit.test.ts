import { describe, expect, it } from "vitest";
import { TokenBucket } from "./rate-limit.js";

describe("TokenBucket", () => {
  it("allows a burst up to the per-minute limit", () => {
    const bucket = new TokenBucket();
    const taken = Array.from({ length: 12 }, () => bucket.take("co", 10, 0));
    expect(taken.filter(Boolean)).toHaveLength(10);
  });

  it("refills in proportion to elapsed time", () => {
    const bucket = new TokenBucket();
    for (let i = 0; i < 10; i++) bucket.take("co", 10, 0);
    expect(bucket.take("co", 10, 5_999)).toBe(false);
    expect(bucket.take("co", 10, 6_000)).toBe(true);
    expect(bucket.take("co", 10, 6_000)).toBe(false);
    expect([...Array(10)].map(() => bucket.take("co", 10, 600_000)).every(Boolean)).toBe(true);
  });

  it("keeps companies independent", () => {
    const bucket = new TokenBucket();
    expect(bucket.take("a", 1, 0)).toBe(true);
    expect(bucket.take("a", 1, 0)).toBe(false);
    expect(bucket.take("b", 1, 0)).toBe(true);
  });

  it("follows a lowered limit", () => {
    const bucket = new TokenBucket();
    bucket.take("co", 60, 0);
    expect(bucket.take("co", 1, 0)).toBe(true);
    expect(bucket.take("co", 1, 0)).toBe(false);
  });
});
