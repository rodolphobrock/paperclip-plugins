import { describe, expect, it, vi } from "vitest";
import { buildDeepLink, PrefixCache } from "./links.js";

const BASE = "https://pc.example.com";

describe("buildDeepLink", () => {
  it("builds the issue, approval and run routes", () => {
    expect(buildDeepLink(BASE, "PAP", { kind: "issue", identifier: "PAP-12" })).toBe(
      "https://pc.example.com/PAP/issues/PAP-12",
    );
    expect(buildDeepLink(BASE, "PAP", { kind: "approval", approvalId: "ap-1" })).toBe(
      "https://pc.example.com/PAP/approvals/ap-1",
    );
    expect(buildDeepLink(BASE, "PAP", { kind: "run", agentId: "ag-1", runId: "run-1" })).toBe(
      "https://pc.example.com/PAP/agents/ag-1/runs/run-1",
    );
  });

  it("keeps a base path and drops trailing slashes", () => {
    const target = { kind: "issue", identifier: "PAP-1" } as const;
    expect(buildDeepLink("https://h/pc/", "PAP", target)).toBe("https://h/pc/PAP/issues/PAP-1");
    expect(buildDeepLink("https://h//", "PAP", target)).toBe("https://h/PAP/issues/PAP-1");
  });

  it("encodes path segments", () => {
    expect(buildDeepLink(BASE, "A B", { kind: "issue", identifier: "x/y?z" })).toBe(
      "https://pc.example.com/A%20B/issues/x%2Fy%3Fz",
    );
  });

  it("returns undefined without a base URL", () => {
    expect(buildDeepLink(undefined, "PAP", { kind: "issue", identifier: "PAP-1" })).toBeUndefined();
    expect(buildDeepLink("", "PAP", { kind: "issue", identifier: "PAP-1" })).toBeUndefined();
  });
});

describe("PrefixCache", () => {
  it("loads once per company within the TTL", async () => {
    let now = 0;
    const load = vi.fn(async (companyId: string) => `P-${companyId}`);
    const cache = new PrefixCache(load, () => now);

    expect(await cache.get("co-1")).toBe("P-co-1");
    now = 599_999;
    expect(await cache.get("co-1")).toBe("P-co-1");
    expect(load).toHaveBeenCalledTimes(1);

    expect(await cache.get("co-2")).toBe("P-co-2");
    expect(load).toHaveBeenCalledTimes(2);

    now = 600_000;
    await cache.get("co-1");
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("caches a missing company too", async () => {
    const load = vi.fn(async () => null);
    const cache = new PrefixCache(load, () => 0, 1000);
    expect(await cache.get("co-1")).toBeNull();
    expect(await cache.get("co-1")).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not cache failures", async () => {
    const load = vi
      .fn<(companyId: string) => Promise<string | null>>()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce("PAP");
    const cache = new PrefixCache(load, () => 0);
    await expect(cache.get("co-1")).rejects.toThrow("down");
    expect(await cache.get("co-1")).toBe("PAP");
  });
});

describe("inbox link", () => {
  it("points at the company inbox", () => {
    expect(buildDeepLink(BASE, "PAP", { kind: "inbox" })).toBe("https://pc.example.com/PAP/inbox");
  });
});
