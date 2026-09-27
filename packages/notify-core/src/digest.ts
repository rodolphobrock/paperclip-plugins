import { localTime } from "./quiet-hours.js";
import { compareSeverity } from "./severity.js";
import type { Notification } from "./types.js";

const DIGEST_LINES = 10;

/** One notification standing for everything held back since `since` (quiet hours, rate limit). */
export function buildDigest(
  items: Notification[],
  since: number,
  timezone: string,
  companyId: string,
): Notification {
  const worst = items.reduce((a, b) => (compareSeverity(b.severity, a.severity) > 0 ? b : a));
  const lines = items.slice(0, DIGEST_LINES).map((n) => `• ${n.title}`);
  if (items.length > DIGEST_LINES) lines.push(`…and ${items.length - DIGEST_LINES} more`);
  const noun = items.length === 1 ? "notification" : "notifications";

  return {
    key: `digest:${companyId}:${since}`,
    companyId,
    eventType: worst.eventType,
    severity: worst.severity,
    tone: worst.tone,
    title: `${items.length} ${noun} since ${localTime(new Date(since), timezone)}`,
    body: lines.join("\n"),
    tags: ["digest"],
    occurredAt: new Date(since).toISOString(),
  };
}
