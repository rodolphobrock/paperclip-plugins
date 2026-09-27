const MINUTE_MS = 60_000;

/**
 * Per-company token bucket held in memory. It refills continuously at `perMinute` tokens
 * per minute; a worker restart starts every bucket full, which errs toward delivering.
 */
export class TokenBucket {
  readonly #buckets = new Map<string, { tokens: number; at: number }>();

  take(companyId: string, perMinute: number, now: number): boolean {
    const bucket = this.#buckets.get(companyId) ?? { tokens: perMinute, at: now };
    const refilled = bucket.tokens + ((now - bucket.at) * perMinute) / MINUTE_MS;
    const tokens = Math.min(perMinute, refilled);
    const allowed = tokens >= 1;
    this.#buckets.set(companyId, { tokens: allowed ? tokens - 1 : tokens, at: now });
    return allowed;
  }
}
