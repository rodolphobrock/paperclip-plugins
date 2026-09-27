/** Notification severities, from lowest to highest. */
export const SEVERITIES = ["low", "normal", "high", "urgent"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Visual tone of a notification, independent of its severity. */
export const TONES = ["info", "success", "warning", "failure"] as const;
export type Tone = (typeof TONES)[number];

/** Negative when `a` is less severe than `b`, positive when more, 0 when equal. */
export function compareSeverity(a: Severity, b: Severity): number {
  return SEVERITIES.indexOf(a) - SEVERITIES.indexOf(b);
}

export function isSeverity(value: unknown): value is Severity {
  return typeof value === "string" && (SEVERITIES as readonly string[]).includes(value);
}
