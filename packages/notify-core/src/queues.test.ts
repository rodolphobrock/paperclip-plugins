import { describe, expect, it } from "vitest";
import type { StatePort } from "./dedupe.js";
import {
  CompanyQueues,
  DIGEST_CAP,
  PendingIndex,
  pushCapped,
  RETRY_CAP,
  type RetryItem,
} from "./queues.js";
import type { Notification } from "./types.js";

function memory(initial: unknown = null): StatePort & { value: unknown } {
  const port = {
    value: initial,
    get: async () => port.value,
    set: async (value: unknown) => {
      port.value = value;
    },
  };
  return port;
}

const n = (key: string): Notification => ({
  key,
  companyId: "co",
  eventType: "agent.run.failed",
  severity: "high",
  tone: "failure",
  title: `T ${key}`,
  body: "",
  tags: [],
  occurredAt: "2026-09-27T12:00:00.000Z",
});

const retryItem = (key: string): RetryItem => ({
  notification: n(key),
  attempts: 1,
  firstAt: 0,
  nextAt: 30_000,
  lastError: "HTTP 503",
});

describe("pushCapped", () => {
  it("appends and drops the oldest beyond the cap", () => {
    expect(pushCapped([1, 2], 3, 5)).toEqual({ list: [1, 2, 3], dropped: [] });
    expect(pushCapped([1, 2, 3], 4, 3)).toEqual({ list: [2, 3, 4], dropped: [1] });
  });

  it("uses caps from the plan", () => {
    expect(RETRY_CAP).toBe(500);
    expect(DIGEST_CAP).toBe(200);
  });
});

describe("CompanyQueues", () => {
  it("round-trips retry items and the digest", async () => {
    const queues = new CompanyQueues({ retry: memory(), digest: memory() });
    await queues.writeRetry([retryItem("a")]);
    expect(await queues.readRetry()).toEqual([retryItem("a")]);

    await queues.writeDigest({ since: 5, items: [n("b")] });
    expect(await queues.readDigest()).toEqual({ since: 5, items: [n("b")] });

    await queues.writeDigest(null);
    expect(await queues.readDigest()).toBeNull();
  });

  it("skips malformed entries instead of failing", async () => {
    const retry = memory([retryItem("ok"), { notification: { key: 1 } }, null, "x"]);
    const digest = memory({ since: "yesterday", items: [n("x")] });
    const queues = new CompanyQueues({ retry, digest });
    expect(await queues.readRetry()).toEqual([retryItem("ok")]);
    expect(await queues.readDigest()).toBeNull();

    const partial = new CompanyQueues({
      retry: memory("garbage"),
      digest: memory({ since: 1, items: [n("y"), { title: 3 }] }),
    });
    expect(await partial.readRetry()).toEqual([]);
    expect(await partial.readDigest()).toEqual({ since: 1, items: [n("y")] });
  });

  it("reports whether anything is pending", async () => {
    const queues = new CompanyQueues({ retry: memory(), digest: memory() });
    expect(await queues.isEmpty()).toBe(true);
    await queues.writeRetry([retryItem("a")]);
    expect(await queues.isEmpty()).toBe(false);
  });
});

describe("PendingIndex", () => {
  it("adds, lists and removes companies without duplicates", async () => {
    const state = memory();
    const index = new PendingIndex(state);
    await index.add("a");
    await index.add("b");
    await index.add("a");
    expect(await index.list()).toEqual(["a", "b"]);
    await index.remove("a");
    expect(await index.list()).toEqual(["b"]);
  });

  it("tolerates corrupted state", async () => {
    expect(await new PendingIndex(memory({ a: 1 })).list()).toEqual([]);
    expect(await new PendingIndex(memory(["a", 3, "b"])).list()).toEqual(["a", "b"]);
  });
});
