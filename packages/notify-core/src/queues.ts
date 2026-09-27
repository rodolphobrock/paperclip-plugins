import type { StatePort } from "./dedupe.js";
import { isRecord } from "./guards.js";
import { isSeverity, TONES } from "./severity.js";
import type { Notification } from "./types.js";

/** Bounds on persisted queues so a long outage cannot grow plugin state without limit. */
export const RETRY_CAP = 500;
export const DIGEST_CAP = 200;

export interface RetryItem {
  notification: Notification;
  attempts: number;
  /** When the first attempt failed (ms since epoch). */
  firstAt: number;
  nextAt: number;
  lastError: string;
}

export interface DigestState {
  /** When the first held-back notification arrived. */
  since: number;
  items: Notification[];
}

export function pushCapped<T>(list: T[], item: T, cap: number): { list: T[]; dropped: T[] } {
  const next = [...list, item];
  const overflow = Math.max(0, next.length - cap);
  return { list: next.slice(overflow), dropped: next.slice(0, overflow) };
}

/** Retry queue and digest for one company, persisted through state ports. */
export class CompanyQueues {
  readonly #retry: StatePort;
  readonly #digest: StatePort;

  constructor(ports: { retry: StatePort; digest: StatePort }) {
    this.#retry = ports.retry;
    this.#digest = ports.digest;
  }

  async readRetry(): Promise<RetryItem[]> {
    const raw = await this.#retry.get();
    return Array.isArray(raw) ? raw.filter(isRetryItem) : [];
  }

  async writeRetry(items: RetryItem[]): Promise<void> {
    await this.#retry.set(items.length > 0 ? items : null);
  }

  async readDigest(): Promise<DigestState | null> {
    const raw = await this.#digest.get();
    if (!isRecord(raw) || typeof raw.since !== "number" || !Array.isArray(raw.items)) return null;
    const items = raw.items.filter(isNotification);
    return items.length > 0 ? { since: raw.since, items } : null;
  }

  async writeDigest(state: DigestState | null): Promise<void> {
    await this.#digest.set(state !== null && state.items.length > 0 ? state : null);
  }

  async isEmpty(): Promise<boolean> {
    return (await this.readRetry()).length === 0 && (await this.readDigest()) === null;
  }
}

/** Instance-wide list of companies with queued work, so the drain job knows where to look. */
export class PendingIndex {
  readonly #state: StatePort;

  constructor(state: StatePort) {
    this.#state = state;
  }

  async list(): Promise<string[]> {
    const raw = await this.#state.get();
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
  }

  async add(companyId: string): Promise<void> {
    const ids = await this.list();
    if (!ids.includes(companyId)) await this.#state.set([...ids, companyId]);
  }

  async remove(companyId: string): Promise<void> {
    const ids = await this.list();
    if (ids.includes(companyId)) await this.#state.set(ids.filter((id) => id !== companyId));
  }
}

function isNotification(value: unknown): value is Notification {
  return (
    isRecord(value) &&
    typeof value.key === "string" &&
    typeof value.companyId === "string" &&
    typeof value.eventType === "string" &&
    isSeverity(value.severity) &&
    (TONES as readonly unknown[]).includes(value.tone) &&
    typeof value.title === "string" &&
    typeof value.body === "string" &&
    Array.isArray(value.tags) &&
    typeof value.occurredAt === "string" &&
    (value.url === undefined || typeof value.url === "string")
  );
}

function isRetryItem(value: unknown): value is RetryItem {
  return (
    isRecord(value) &&
    isNotification(value.notification) &&
    typeof value.attempts === "number" &&
    typeof value.firstAt === "number" &&
    typeof value.nextAt === "number" &&
    typeof value.lastError === "string"
  );
}
