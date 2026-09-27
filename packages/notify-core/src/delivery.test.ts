import { beforeEach, describe, expect, it, vi } from "vitest";
import { type BaseConfig, parseBaseConfig } from "./config.js";
import type { StatePort } from "./dedupe.js";
import { backoffMs, createDelivery, type DeliveryObserver } from "./delivery.js";
import { CompanyQueues, PendingIndex } from "./queues.js";
import { TokenBucket } from "./rate-limit.js";
import type { Notification, SendResult } from "./types.js";

const CO = "co-1";
const MIN = 60_000;

function memory(): StatePort & { value: unknown } {
  const port = {
    value: null as unknown,
    get: async () => port.value,
    set: async (value: unknown) => {
      port.value = value;
    },
  };
  return port;
}

const n = (key: string, overrides: Partial<Notification> = {}): Notification => ({
  key,
  companyId: CO,
  eventType: "agent.run.failed",
  severity: "high",
  tone: "failure",
  title: `T ${key}`,
  body: "",
  tags: [],
  occurredAt: "2026-09-27T12:00:00.000Z",
  ...overrides,
});

let now: number;
let results: SendResult[];
let sent: Notification[];
let config: BaseConfig | null;
let calls: string[];
let retryState: StatePort & { value: unknown };
let digestState: StatePort & { value: unknown };
let pendingState: StatePort & { value: unknown };

function setup() {
  const observer: DeliveryObserver = {
    sent: (x) => void calls.push(`sent ${x.key}`),
    failed: (x, e) => void calls.push(`failed ${x.key} ${e}`),
    queued: (x, r) => void calls.push(`queued ${x.key} ${r}`),
    retry: (x, a) => void calls.push(`retry ${x.key} ${a}`),
    dropped: (x, r) => void calls.push(`dropped ${x.key} ${r}`),
    digested: (s, count) => void calls.push(`digested ${s.companyId} ${count}`),
  };
  return createDelivery<BaseConfig>({
    clock: () => now,
    bucket: new TokenBucket(),
    send: async (x) => {
      sent.push(x);
      return results.shift() ?? { ok: true };
    },
    loadConfig: async () => config,
    queuesFor: () => new CompanyQueues({ retry: retryState, digest: digestState }),
    pending: new PendingIndex(pendingState),
    inboxUrl: async () => "https://pc/PAP/inbox",
    withLock: (_c, fn) => fn(),
    observer,
  });
}

beforeEach(() => {
  now = Date.parse("2026-09-27T12:00:00Z");
  results = [];
  sent = [];
  calls = [];
  config = parseBaseConfig({});
  retryState = memory();
  digestState = memory();
  pendingState = memory();
});

describe("backoffMs", () => {
  it("doubles from 30 seconds", () => {
    expect([1, 2, 3, 4].map(backoffMs)).toEqual([30_000, 60_000, 120_000, 240_000]);
  });
});

describe("deliver", () => {
  it("sends right away when allowed", async () => {
    const delivery = setup();
    await delivery.deliver(n("a"), parseBaseConfig({}));
    expect(calls).toEqual(["sent a"]);
  });

  it("reports permanent failures without queueing", async () => {
    results = [{ ok: false, retryable: false, error: "HTTP 401" }];
    await setup().deliver(n("a"), parseBaseConfig({}));
    expect(calls).toEqual(["failed a HTTP 401"]);
    expect(retryState.value).toBeNull();
  });

  it("queues retryable failures with backoff or Retry-After", async () => {
    const delivery = setup();
    results = [{ ok: false, retryable: true, error: "HTTP 503" }];
    await delivery.deliver(n("a"), parseBaseConfig({}));
    results = [{ ok: false, retryable: true, error: "HTTP 429", retryAfterMs: 5 * MIN }];
    await delivery.deliver(n("b"), parseBaseConfig({}));

    const items = await new CompanyQueues({ retry: retryState, digest: digestState }).readRetry();
    expect(items.map((i) => [i.notification.key, i.attempts, i.nextAt - now])).toEqual([
      ["a", 1, 30_000],
      ["b", 1, 5 * MIN],
    ]);
    expect(await new PendingIndex(pendingState).list()).toEqual([CO]);
    expect(calls).toEqual(["retry a 1", "retry b 1"]);
  });

  it("holds notifications during quiet hours, except urgent ones", async () => {
    const quiet = parseBaseConfig({ quietHours: { enabled: true, start: "11:00", end: "13:00" } });
    const delivery = setup();
    await delivery.deliver(n("a", { severity: "high" }), quiet);
    await delivery.deliver(n("u", { severity: "urgent" }), quiet);
    expect(calls).toEqual(["queued a quiet", "sent u"]);

    const strict = parseBaseConfig({
      quietHours: { enabled: true, start: "11:00", end: "13:00", allowUrgent: false },
    });
    await delivery.deliver(n("u2", { severity: "urgent" }), strict);
    expect(calls.at(-1)).toBe("queued u2 quiet");
  });

  it("holds notifications above the rate limit", async () => {
    const limited = parseBaseConfig({ rateLimit: { perMinute: 2 } });
    const delivery = setup();
    for (const key of ["a", "b", "c"]) await delivery.deliver(n(key), limited);
    expect(calls).toEqual(["sent a", "sent b", "queued c rate_limit"]);
    expect((digestState.value as { since: number }).since).toBe(now);
  });
});

describe("drain", () => {
  async function failOnce(delivery: ReturnType<typeof setup>, key = "a") {
    results = [{ ok: false, retryable: true, error: "HTTP 503" }];
    await delivery.deliver(n(key), config ?? parseBaseConfig({}));
    calls = [];
  }

  it("retries due items and delivers when the server is back", async () => {
    const delivery = setup();
    await failOnce(delivery);

    now += 29_000;
    await delivery.drain();
    expect(sent).toHaveLength(1);

    now += 1_000;
    await delivery.drain();
    expect(calls).toEqual(["sent a"]);
    expect(retryState.value).toBeNull();
    expect(await new PendingIndex(pendingState).list()).toEqual([]);
  });

  it("drops after maxAttempts with the activity reason", async () => {
    config = parseBaseConfig({ retry: { maxAttempts: 3 } });
    const delivery = setup();
    await failOnce(delivery);
    for (let i = 0; i < 3; i++) {
      now += 10 * MIN;
      results = [{ ok: false, retryable: true, error: "HTTP 503" }];
      await delivery.drain();
    }
    expect(calls).toEqual(["retry a 2", "dropped a exhausted"]);
    expect(sent).toHaveLength(3);
  });

  it("drops items older than maxAgeMinutes without sending", async () => {
    config = parseBaseConfig({ retry: { maxAgeMinutes: 10 } });
    const delivery = setup();
    await failOnce(delivery);
    now += 11 * MIN;
    await delivery.drain();
    expect(calls).toEqual(["dropped a expired"]);
    expect(sent).toHaveLength(1);
  });

  it("drops on a permanent failure during retry", async () => {
    const delivery = setup();
    await failOnce(delivery);
    now += MIN;
    results = [{ ok: false, retryable: false, error: "HTTP 404" }];
    await delivery.drain();
    expect(calls).toEqual(["dropped a permanent"]);
  });

  it("sends the digest after the window and outside quiet hours", async () => {
    config = parseBaseConfig({
      quietHours: { enabled: true, start: "11:00", end: "13:00" },
      rateLimit: { digestWindowMinutes: 5 },
    });
    const delivery = setup();
    await delivery.deliver(n("a"), config);
    await delivery.deliver(n("b"), config);
    calls = [];

    now += 30 * MIN; // 12:30, still quiet
    await delivery.drain();
    expect(sent).toHaveLength(0);

    now = Date.parse("2026-09-27T13:00:00Z");
    await delivery.drain();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      title: "2 notifications since 12:00",
      url: "https://pc/PAP/inbox",
    });
    expect(calls).toEqual([
      "digested co-1 2",
      `sent digest:co-1:${Date.parse("2026-09-27T12:00:00Z")}`,
    ]);
    expect(digestState.value).toBeNull();
  });

  it("waits for the digest window", async () => {
    config = parseBaseConfig({ rateLimit: { perMinute: 1, digestWindowMinutes: 5 } });
    const delivery = setup();
    await delivery.deliver(n("a"), config);
    await delivery.deliver(n("b"), config);
    now += 4 * MIN;
    await delivery.drain();
    expect(sent.map((x) => x.key)).toEqual(["a"]);
    now += MIN;
    await delivery.drain();
    expect(sent).toHaveLength(2);
  });

  it("keeps the digest on a retryable failure and drops it on a permanent one", async () => {
    config = parseBaseConfig({ rateLimit: { perMinute: 1, digestWindowMinutes: 1 } });
    const delivery = setup();
    await delivery.deliver(n("a"), config);
    await delivery.deliver(n("b"), config);
    now += 2 * MIN;
    results = [{ ok: false, retryable: true, error: "HTTP 503" }];
    await delivery.drain();
    expect(digestState.value).not.toBeNull();

    now += 2 * MIN;
    results = [{ ok: false, retryable: false, error: "HTTP 400" }];
    await delivery.drain();
    expect(digestState.value).toBeNull();
    expect(calls.at(-1)).toBe("dropped b permanent");
  });

  it("clears queues of a company that was disabled", async () => {
    const delivery = setup();
    await failOnce(delivery);
    config = null;
    await delivery.drain();
    expect(calls).toEqual(["dropped a disabled"]);
    expect(retryState.value).toBeNull();
    expect(await new PendingIndex(pendingState).list()).toEqual([]);
  });

  it("drains every pending company under its lock", async () => {
    const withLock = vi.fn((_c: string, fn: () => Promise<void>) => fn());
    const delivery = createDelivery<BaseConfig>({
      clock: () => now,
      bucket: new TokenBucket(),
      send: async () => ({ ok: true }),
      loadConfig: async () => parseBaseConfig({}),
      queuesFor: () => new CompanyQueues({ retry: memory(), digest: memory() }),
      pending: new PendingIndex(pendingState),
      inboxUrl: async () => undefined,
      withLock,
      observer: { sent() {}, failed() {}, queued() {}, retry() {}, dropped() {}, digested() {} },
    });
    pendingState.value = ["a", "b"];
    await delivery.drain();
    expect(withLock.mock.calls.map((c) => c[0])).toEqual(["a", "b"]);
  });
});

describe("review fixes", () => {
  it("sends urgent notifications past an empty rate limit when urgent is allowed", async () => {
    const limited = parseBaseConfig({ rateLimit: { perMinute: 1 } });
    const delivery = setup();
    await delivery.deliver(n("a"), limited);
    await delivery.deliver(n("u", { severity: "urgent" }), limited);
    expect(calls).toEqual(["sent a", "sent u"]);
  });

  it("does not retry when maxAttempts is 1", async () => {
    results = [{ ok: false, retryable: true, error: "HTTP 503" }];
    await setup().deliver(n("a"), parseBaseConfig({ retry: { maxAttempts: 1 } }));
    expect(calls).toEqual(["dropped a exhausted"]);
    expect(retryState.value).toBeNull();
  });

  it("reports and eventually drops a digest that keeps failing", async () => {
    config = parseBaseConfig({
      rateLimit: { perMinute: 1, digestWindowMinutes: 1 },
      retry: { maxAgeMinutes: 10 },
    });
    const delivery = setup();
    await delivery.deliver(n("a"), config);
    await delivery.deliver(n("b"), config);
    calls = [];
    for (let i = 0; i < 12; i++) {
      now += MIN;
      results = [{ ok: false, retryable: true, error: "HTTP 503" }];
      await delivery.drain();
    }
    expect(calls.filter((c) => c.startsWith("retry digest"))).not.toHaveLength(0);
    expect(calls).toContain("dropped b expired");
    expect(digestState.value).toBeNull();
  });

  it("keeps draining other companies when one fails, and forgets out-of-scope ones", async () => {
    pendingState.value = ["gone", "broken", "ok"];
    const drained: string[] = [];
    const errors: string[] = [];
    const delivery = createDelivery<BaseConfig>({
      clock: () => now,
      bucket: new TokenBucket(),
      send: async () => ({ ok: true }),
      loadConfig: async (companyId) => {
        if (companyId === "gone") {
          throw Object.assign(new Error("scope denied"), { name: "InvocationScopeDeniedError" });
        }
        if (companyId === "broken") throw new Error("state RPC failed");
        drained.push(companyId);
        return parseBaseConfig({});
      },
      queuesFor: () => new CompanyQueues({ retry: memory(), digest: memory() }),
      pending: new PendingIndex(pendingState),
      inboxUrl: async () => undefined,
      withLock: (_c, fn) => fn(),
      onDrainError: (companyId, error) =>
        void errors.push(`${companyId}: ${(error as Error).message}`),
      observer: { sent() {}, failed() {}, queued() {}, retry() {}, dropped() {}, digested() {} },
    });
    await delivery.drain();
    expect(drained).toEqual(["ok"]);
    expect(errors).toEqual(["gone: scope denied", "broken: state RPC failed"]);
    expect(await new PendingIndex(pendingState).list()).toEqual(["broken"]);
  });
});

describe("backlog fixes", () => {
  const retryItems = async () =>
    new CompanyQueues({ retry: retryState, digest: digestState }).readRetry();

  it("moves due retries into the digest during quiet hours, but retries urgent ones", async () => {
    const delivery = setup();
    results = [
      { ok: false, retryable: true, error: "HTTP 503" },
      { ok: false, retryable: true, error: "HTTP 503" },
    ];
    await delivery.deliver(n("a"), parseBaseConfig({}));
    await delivery.deliver(n("u", { severity: "urgent" }), parseBaseConfig({}));
    config = parseBaseConfig({ quietHours: { enabled: true, start: "12:00", end: "13:00" } });
    calls = [];
    now += MIN;
    await delivery.drain();
    expect(calls).toEqual(["queued a quiet", "sent u"]);
    expect(await retryItems()).toEqual([]);
  });

  it("keeps due retries without spending an attempt when the rate limit is empty", async () => {
    config = parseBaseConfig({ rateLimit: { perMinute: 1 } });
    const delivery = setup();
    results = [{ ok: false, retryable: true, error: "HTTP 503" }];
    await delivery.deliver(n("a"), config);
    now += 31_000;
    await delivery.drain();
    expect(sent).toHaveLength(1);
    expect((await retryItems())[0]?.attempts).toBe(1);
  });

  it("persists the retry queue after each item", async () => {
    const delivery = setup();
    results = [
      { ok: false, retryable: true, error: "HTTP 503" },
      { ok: false, retryable: true, error: "HTTP 503" },
    ];
    await delivery.deliver(n("a"), parseBaseConfig({}));
    await delivery.deliver(n("b"), parseBaseConfig({}));
    now += MIN;
    const keysWhenSendingB: string[] = [];
    results = [{ ok: true }, { ok: true }];
    const delivery2 = createDelivery<BaseConfig>({
      clock: () => now,
      bucket: new TokenBucket(),
      send: async (x) => {
        sent.push(x);
        if (x.key === "b") {
          const items = (retryState.value ?? []) as { notification: Notification }[];
          keysWhenSendingB.push(...items.map((i) => i.notification.key));
        }
        return { ok: true };
      },
      loadConfig: async () => config,
      queuesFor: () => new CompanyQueues({ retry: retryState, digest: digestState }),
      pending: new PendingIndex(pendingState),
      inboxUrl: async () => undefined,
      withLock: (_c, fn) => fn(),
      observer: { sent() {}, failed() {}, queued() {}, retry() {}, dropped() {}, digested() {} },
    });
    void delivery;
    await delivery2.drain();
    expect(keysWhenSendingB).toEqual(["b"]);
  });

  it("sends at most 20 items per company per drain", async () => {
    const delivery = setup();
    results = Array.from({ length: 25 }, () => ({ ok: false, retryable: true, error: "HTTP 503" }));
    config = parseBaseConfig({ rateLimit: { perMinute: 600 } });
    for (let i = 0; i < 25; i++) await delivery.deliver(n(`k${i}`), config);
    sent = [];
    now += MIN;
    await delivery.drain();
    expect(sent).toHaveLength(20);
    expect(await retryItems()).toHaveLength(5);
  });
});

describe("review of the backlog fixes", () => {
  it("sends directly when a token is available, even with a digest pending (spec: only the excess is held)", async () => {
    config = parseBaseConfig({ rateLimit: { perMinute: 1, digestWindowMinutes: 60 } });
    const delivery = setup();
    await delivery.deliver(n("a"), config);
    await delivery.deliver(n("b"), config);
    now += MIN;
    await delivery.deliver(n("c"), config);
    expect(calls).toEqual(["sent a", "queued b rate_limit", "sent c"]);
  });

  it("reserves one send of each drain for a due digest", async () => {
    config = parseBaseConfig({ rateLimit: { perMinute: 600, digestWindowMinutes: 1 } });
    const delivery = setup();
    results = Array.from({ length: 25 }, () => ({ ok: false, retryable: true, error: "HTTP 503" }));
    for (let i = 0; i < 25; i++) await delivery.deliver(n(`k${i}`), config);
    await new CompanyQueues({ retry: retryState, digest: digestState }).writeDigest({
      since: now,
      items: [n("held")],
    });
    sent = [];
    now += 2 * MIN;
    results = Array.from({ length: 25 }, () => ({ ok: false, retryable: true, error: "HTTP 503" }));
    await delivery.drain();
    expect(sent).toHaveLength(20);
    expect(sent.at(-1)?.title).toBe("1 notification since 12:00");
  });

  it("moves every non-urgent retry into the digest during quiet hours, due or not", async () => {
    const delivery = setup();
    results = [{ ok: false, retryable: true, error: "HTTP 503" }];
    await delivery.deliver(n("a"), parseBaseConfig({}));
    config = parseBaseConfig({ quietHours: { enabled: true, start: "12:00", end: "13:00" } });
    calls = [];
    now += 10_000; // not due yet (30 s backoff)
    await delivery.drain();
    expect(calls).toEqual(["queued a quiet"]);
    expect(retryState.value).toBeNull();
  });
});
