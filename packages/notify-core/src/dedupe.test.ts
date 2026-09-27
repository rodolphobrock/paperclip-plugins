import { describe, expect, it, vi } from "vitest";
import { DedupeStore, type StatePort, semanticKey } from "./dedupe.js";

function memoryState(initial: unknown = null): StatePort & { value: unknown } {
  const port = {
    value: initial,
    async get() {
      return port.value;
    },
    async set(value: unknown) {
      port.value = value;
    },
  };
  return port;
}

describe("semanticKey", () => {
  it("combines event type, entity and fact state", () => {
    expect(semanticKey("approval.decided", "ap-1", "approved")).toBe(
      "approval.decided:ap-1:approved",
    );
    expect(semanticKey("budget.incident.opened", undefined, "hard")).toBe(
      "budget.incident.opened:-:hard",
    );
  });
});

describe("DedupeStore", () => {
  it("sees a remembered key within the TTL", async () => {
    const store = new DedupeStore(memoryState());
    await store.remember(["a", "b"], 1000);
    expect(await store.seen(["b"], 2000)).toBe(true);
    expect(await store.seen(["x", "a"], 2000)).toBe(true);
    expect(await store.seen(["x"], 2000)).toBe(false);
  });

  it("forgets keys after the TTL", async () => {
    const store = new DedupeStore(memoryState(), { ttlMs: 10_000 });
    await store.remember(["a"], 0);
    expect(await store.seen(["a"], 9_999)).toBe(true);
    expect(await store.seen(["a"], 10_000)).toBe(false);
  });

  it("defaults to a 10 minute TTL and 500 entries", async () => {
    const state = memoryState();
    const store = new DedupeStore(state);
    await store.remember(["a"], 0);
    expect(await store.seen(["a"], 599_999)).toBe(true);
    expect(await store.seen(["a"], 600_000)).toBe(false);

    for (let i = 0; i < 510; i++) await store.remember([`k${i}`], 1);
    expect(state.value).toHaveLength(500);
  });

  it("drops the oldest entries when the ring is full", async () => {
    const store = new DedupeStore(memoryState(), { capacity: 3 });
    await store.remember(["a"], 1);
    await store.remember(["b"], 2);
    await store.remember(["c", "d"], 3);
    expect(await store.seen(["a"], 4)).toBe(false);
    expect(await store.seen(["b"], 4)).toBe(true);
    expect(await store.seen(["d"], 4)).toBe(true);
  });

  it("prunes expired entries and refreshes repeated keys on write", async () => {
    const state = memoryState();
    const store = new DedupeStore(state, { ttlMs: 100 });
    await store.remember(["a", "b"], 0);
    await store.remember(["b"], 150);
    expect(state.value).toEqual([{ k: "b", t: 150 }]);
  });

  it.each([["garbage"], [{ k: "a" }], [[{ k: 1, t: "x" }, null, { k: "a", t: 5 }]]])(
    "tolerates corrupted state %j",
    async (initial) => {
      const store = new DedupeStore(memoryState(initial));
      expect(await store.seen(["zzz"], 10)).toBe(false);
      await store.remember(["zzz"], 10);
      expect(await store.seen(["zzz"], 11)).toBe(true);
    },
  );
});

describe("checkAndRemember", () => {
  it("reads state once and writes only for new keys", async () => {
    const state = memoryState();
    const get = vi.spyOn(state, "get");
    const set = vi.spyOn(state, "set");
    const store = new DedupeStore(state);
    expect(await store.checkAndRemember(["a"], 1)).toBe(false);
    expect(await store.checkAndRemember(["a"], 2)).toBe(true);
    expect(get).toHaveBeenCalledTimes(2);
    expect(set).toHaveBeenCalledTimes(1);
  });
});
