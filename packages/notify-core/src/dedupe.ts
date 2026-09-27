import { isRecord } from "./guards.js";

/** One persisted value, e.g. a `ctx.state` key bound to a company. */
export interface StatePort {
  get(): Promise<unknown>;
  set(value: unknown): Promise<void>;
}

interface Entry {
  k: string;
  t: number;
}

const DEFAULT_CAPACITY = 500;
const DEFAULT_TTL_MS = 10 * 60_000;

/**
 * Key for "the same fact": two activity-log writes about one fact carry different
 * eventIds, so the eventId alone does not deduplicate them.
 */
export function semanticKey(
  eventType: string,
  entityId: string | undefined,
  factKey: string,
): string {
  return `${eventType}:${entityId ?? "-"}:${factKey}`;
}

/** Ring of recent keys with a TTL, persisted through a StatePort. */
export class DedupeStore {
  readonly #state: StatePort;
  readonly #capacity: number;
  readonly #ttlMs: number;

  constructor(state: StatePort, opts: { capacity?: number; ttlMs?: number } = {}) {
    this.#state = state;
    this.#capacity = opts.capacity ?? DEFAULT_CAPACITY;
    this.#ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  }

  /** One state read: true when any key was seen; otherwise records the keys. */
  async checkAndRemember(keys: string[], now: number): Promise<boolean> {
    const live = this.#live(await this.#load(), now);
    if (live.some((entry) => keys.includes(entry.k))) return true;
    const next = [...live, ...keys.map((k) => ({ k, t: now }))].slice(-this.#capacity);
    await this.#state.set(next);
    return false;
  }

  async seen(keys: string[], now: number): Promise<boolean> {
    const live = this.#live(await this.#load(), now);
    return live.some((entry) => keys.includes(entry.k));
  }

  async remember(keys: string[], now: number): Promise<void> {
    const kept = this.#live(await this.#load(), now).filter((entry) => !keys.includes(entry.k));
    const next = [...kept, ...keys.map((k) => ({ k, t: now }))].slice(-this.#capacity);
    await this.#state.set(next);
  }

  #live(entries: Entry[], now: number): Entry[] {
    return entries.filter((entry) => now - entry.t < this.#ttlMs);
  }

  async #load(): Promise<Entry[]> {
    const raw = await this.#state.get();
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (item): item is Entry =>
        isRecord(item) && typeof item.k === "string" && typeof item.t === "number",
    );
  }
}
