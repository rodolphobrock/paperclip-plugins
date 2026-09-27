import type { BaseConfig } from "./config.js";
import { buildDigest } from "./digest.js";
import {
  type CompanyQueues,
  DIGEST_CAP,
  type PendingStore,
  pushCapped,
  RETRY_CAP,
  type RetryItem,
} from "./queues.js";
import { isQuiet } from "./quiet-hours.js";
import type { TokenBucket } from "./rate-limit.js";
import type { Notification, SendResult } from "./types.js";

const MINUTE_MS = 60_000;
const FIRST_BACKOFF_MS = 30_000;

export type HoldReason = "quiet" | "rate_limit";
export type DropReason = "exhausted" | "expired" | "permanent" | "disabled" | "queue_full";

/** Side effects of delivery (logs, metrics, status, activity log), implemented by the notifier. */
export interface DeliveryObserver {
  sent(n: Notification): void | Promise<void>;
  failed(n: Notification, error: string): void | Promise<void>;
  queued(n: Notification, reason: HoldReason): void | Promise<void>;
  retry(n: Notification, attempt: number, error: string): void | Promise<void>;
  dropped(n: Notification, reason: DropReason, error?: string): void | Promise<void>;
  digested(companyId: string, count: number): void | Promise<void>;
}

export interface DeliveryDeps<C extends BaseConfig> {
  clock(): number;
  bucket: TokenBucket;
  /** One send attempt; must not throw (classify errors into a SendResult). */
  send(n: Notification, config: C): Promise<SendResult>;
  /** The company's current config, or null when it is missing, invalid or disabled. */
  loadConfig(companyId: string): Promise<C | null>;
  queuesFor(companyId: string): CompanyQueues;
  pending: PendingStore;
  inboxUrl(companyId: string, config: C): Promise<string | undefined>;
  /** Runs `fn` exclusively for the company (events and the drain job share the queues). */
  withLock(companyId: string, fn: () => Promise<void>): Promise<void>;
  observer: DeliveryObserver;
  /** A company's drain failed; the job carries on with the next company. */
  onDrainError?(companyId: string, error: unknown): void;
}

/** 30 s, 1 min, 2 min, 4 min… before attempt `attempt + 1`. */
export function backoffMs(attempt: number): number {
  return FIRST_BACKOFF_MS * 2 ** (attempt - 1);
}

/** Quiet hours, rate limit, digest and retry around a sender (spec decision 6). */
export function createDelivery<C extends BaseConfig>(deps: DeliveryDeps<C>) {
  const { observer } = deps;

  const hold = async (n: Notification, reason: HoldReason, now: number) => {
    const queues = deps.queuesFor(n.companyId);
    const digest = (await queues.readDigest()) ?? { since: now, items: [] };
    const { list, dropped } = pushCapped(digest.items, n, DIGEST_CAP);
    await queues.writeDigest({ ...digest, items: list });
    await deps.pending.add(n.companyId);
    for (const old of dropped) await observer.dropped(old, "queue_full");
    await observer.queued(n, reason);
  };

  const scheduleRetry = (item: Omit<RetryItem, "nextAt">, result: SendResult, now: number) => {
    const retryAfter = result.ok ? 0 : (result.retryAfterMs ?? 0);
    return { ...item, nextAt: now + Math.max(backoffMs(item.attempts), retryAfter) };
  };

  /** Called for each new notification, inside the company lock. */
  const deliver = async (n: Notification, config: C): Promise<void> => {
    const now = deps.clock();
    // "urgent always passes" (spec decision 6): past quiet hours and past an empty bucket.
    const urgentPasses = n.severity === "urgent" && config.quietHours.allowUrgent;
    if (isQuiet(new Date(now), config.quietHours) && !urgentPasses) {
      return hold(n, "quiet", now);
    }
    const hasToken = deps.bucket.take(n.companyId, config.rateLimit.perMinute, now);
    if (!hasToken && !urgentPasses) return hold(n, "rate_limit", now);

    const result = await deps.send(n, config);
    if (result.ok) return observer.sent(n);
    if (!result.retryable) return observer.failed(n, result.error);
    if (config.retry.maxAttempts <= 1) return observer.dropped(n, "exhausted", result.error);

    const queues = deps.queuesFor(n.companyId);
    const item = scheduleRetry(
      { notification: n, attempts: 1, firstAt: now, lastError: result.error },
      result,
      now,
    );
    const { list, dropped } = pushCapped(await queues.readRetry(), item, RETRY_CAP);
    await queues.writeRetry(list);
    await deps.pending.add(n.companyId);
    for (const old of dropped)
      await observer.dropped(old.notification, "queue_full", old.lastError);
    await observer.retry(n, 1, result.error);
  };

  const drainRetries = async (queues: CompanyQueues, config: C, now: number) => {
    const keep: RetryItem[] = [];
    for (const item of await queues.readRetry()) {
      if (now - item.firstAt >= config.retry.maxAgeMinutes * MINUTE_MS) {
        await observer.dropped(item.notification, "expired", item.lastError);
        continue;
      }
      if (item.nextAt > now) {
        keep.push(item);
        continue;
      }
      const result = await deps.send(item.notification, config);
      if (result.ok) {
        await observer.sent(item.notification);
      } else if (!result.retryable) {
        await observer.dropped(item.notification, "permanent", result.error);
      } else if (item.attempts + 1 >= config.retry.maxAttempts) {
        await observer.dropped(item.notification, "exhausted", result.error);
      } else {
        const attempts = item.attempts + 1;
        keep.push(scheduleRetry({ ...item, attempts, lastError: result.error }, result, now));
        await observer.retry(item.notification, attempts, result.error);
      }
    }
    await queues.writeRetry(keep);
  };

  const drainDigest = async (companyId: string, queues: CompanyQueues, config: C, now: number) => {
    const digest = await queues.readDigest();
    if (digest === null) return;
    const maxAgeMs = config.retry.maxAgeMinutes * MINUTE_MS;
    if (digest.firstFailureAt !== undefined && now - digest.firstFailureAt >= maxAgeMs) {
      await queues.writeDigest(null);
      for (const item of digest.items) await observer.dropped(item, "expired");
      return;
    }
    if (isQuiet(new Date(now), config.quietHours)) return;
    if (now - digest.since < config.rateLimit.digestWindowMinutes * MINUTE_MS) return;
    if (!deps.bucket.take(companyId, config.rateLimit.perMinute, now)) return;

    const summary = buildDigest(digest.items, digest.since, config.quietHours.timezone, companyId);
    const url = await deps.inboxUrl(companyId, config);
    if (url !== undefined) summary.url = url;

    const result = await deps.send(summary, config);
    if (result.ok) {
      await queues.writeDigest(null);
      await observer.digested(companyId, digest.items.length);
      await observer.sent(summary);
    } else if (!result.retryable) {
      await queues.writeDigest(null);
      for (const item of digest.items) await observer.dropped(item, "permanent", result.error);
    } else {
      // Kept for the next drain; expires `retry.maxAgeMinutes` after the first failure
      // (not after `since`, which quiet hours can push back by hours).
      const failures = (digest.failures ?? 0) + 1;
      await queues.writeDigest({
        ...digest,
        failures,
        firstFailureAt: digest.firstFailureAt ?? now,
      });
      await observer.retry(summary, failures, result.error);
    }
  };

  const drainCompany = async (companyId: string) => {
    const queues = deps.queuesFor(companyId);
    const config = await deps.loadConfig(companyId);
    if (config === null) {
      for (const item of await queues.readRetry()) {
        await observer.dropped(item.notification, "disabled", item.lastError);
      }
      for (const item of (await queues.readDigest())?.items ?? []) {
        await observer.dropped(item, "disabled");
      }
      await queues.writeRetry([]);
      await queues.writeDigest(null);
    } else {
      const now = deps.clock();
      await drainRetries(queues, config, now);
      await drainDigest(companyId, queues, config, now);
    }
    if (await queues.isEmpty()) await deps.pending.remove(companyId);
  };

  /** The `delivery-drain` job: every company with queued work, one at a time. */
  const drain = async (): Promise<void> => {
    for (const companyId of await deps.pending.list()) {
      try {
        await deps.withLock(companyId, () => drainCompany(companyId));
      } catch (error) {
        deps.onDrainError?.(companyId, error);
        // The host denies calls for companies the plugin can no longer see (deleted, unscoped).
        if (error instanceof Error && /ScopeDenied/i.test(error.name)) {
          await deps.pending.remove(companyId);
        }
      }
    }
  };

  return { deliver, drain };
}
