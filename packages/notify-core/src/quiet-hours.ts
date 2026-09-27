/** Per-company quiet hours (spec decision 6). `start`/`end` are local `HH:MM`. */
export interface QuietHours {
  enabled: boolean;
  start: string;
  end: string;
  /** IANA timezone, e.g. America/Sao_Paulo. */
  timezone: string;
  /** Let urgent notifications through during quiet hours. */
  allowUrgent: boolean;
}

export const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let cached = formatters.get(timezone);
  if (cached === undefined) {
    cached = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timezone, cached);
  }
  return cached;
}

export function isValidTimezone(timezone: string): boolean {
  if (timezone === "") return false;
  try {
    formatter(timezone);
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock `HH:MM` of `now` in `timezone`. */
export function localTime(now: Date, timezone: string): string {
  return formatter(timezone).format(now);
}

/** Whether `now` falls in the window; a window with start after end crosses midnight. */
export function isQuiet(now: Date, qh: QuietHours): boolean {
  if (!qh.enabled || qh.start === qh.end) return false;
  const time = localTime(now, qh.timezone);
  return qh.start < qh.end ? time >= qh.start && time < qh.end : time >= qh.start || time < qh.end;
}
