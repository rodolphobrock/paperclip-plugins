import { describe, expect, it } from "vitest";
import { buildDigest } from "./digest.js";
import type { Notification } from "./types.js";

const item = (i: number, overrides: Partial<Notification> = {}): Notification => ({
  key: `k${i}`,
  companyId: "co",
  eventType: "issue.created",
  severity: "low",
  tone: "info",
  title: `Issue ${i}`,
  body: "",
  tags: ["issue"],
  occurredAt: "2026-09-27T12:00:00.000Z",
  ...overrides,
});

describe("buildDigest", () => {
  it("summarizes up to ten items with the local start time", () => {
    const items = Array.from({ length: 12 }, (_, i) => item(i + 1));
    const digest = buildDigest(
      items,
      Date.parse("2026-09-27T01:30:00Z"),
      "America/Sao_Paulo",
      "co",
    );
    expect(digest.title).toBe("12 notifications since 22:30");
    const lines = digest.body.split("\n");
    expect(lines).toHaveLength(11);
    expect(lines[0]).toBe("• Issue 1");
    expect(lines[10]).toBe("…and 2 more");
    expect(digest).toMatchObject({
      companyId: "co",
      severity: "low",
      tone: "info",
      tags: ["digest"],
    });
    expect(digest.key).toBe(`digest:co:${Date.parse("2026-09-27T01:30:00Z")}`);
  });

  it("takes severity and tone from the most severe item", () => {
    const digest = buildDigest(
      [
        item(1),
        item(2, { severity: "high", tone: "failure" }),
        item(3, { severity: "normal", tone: "success" }),
      ],
      0,
      "UTC",
      "co",
    );
    expect(digest).toMatchObject({
      severity: "high",
      tone: "failure",
      title: "3 notifications since 00:00",
    });
  });

  it("uses the singular for one item", () => {
    expect(buildDigest([item(1)], 0, "UTC", "co").title).toBe("1 notification since 00:00");
  });
});
