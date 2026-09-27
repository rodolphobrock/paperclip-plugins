import { redact } from "./redact.js";
import { SecretResolutionError, type SendResult } from "./types.js";

const BODY_EXCERPT_CHARS = 200;

/** Delay in ms from a `Retry-After` header (seconds or HTTP date), or undefined if invalid. */
export function parseRetryAfter(header: string | null, now: number): number | undefined {
  if (header === null) return undefined;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  if (Number.isNaN(date) || !/[a-z]/i.test(value)) return undefined;
  return Math.max(0, date - now);
}

/** 2xx → ok; 429 and 5xx → retryable (honouring Retry-After); other statuses → permanent. */
export async function classifyResponse(
  res: Response,
  now: number = Date.now(),
): Promise<SendResult> {
  if (res.ok) return { ok: true };

  const retryable = res.status === 429 || res.status >= 500;
  const body = await res.text().catch(() => "");
  const excerpt = redact(body.slice(0, BODY_EXCERPT_CHARS).trim());
  const error = `HTTP ${res.status}${excerpt ? `: ${excerpt}` : ""}`;
  if (!retryable) return { ok: false, retryable: false, error };

  const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"), now);
  return retryAfterMs === undefined
    ? { ok: false, retryable: true, error }
    : { ok: false, retryable: true, error, retryAfterMs };
}

/** Network errors, timeouts and anything unexpected are retryable; secret failures are not. */
export function classifyError(err: unknown): SendResult {
  if (err instanceof SecretResolutionError) {
    return { ok: false, retryable: false, error: err.message };
  }
  if (err instanceof Error) {
    const kind = err.name === "TimeoutError" || err.name === "AbortError" ? "timeout" : "network";
    return { ok: false, retryable: true, error: `${kind} error: ${redact(err.message)}` };
  }
  return { ok: false, retryable: true, error: `unexpected error: ${redact(String(err))}` };
}
