import type { PluginEventType } from "@paperclipai/plugin-sdk";
import type { Severity } from "./severity.js";

/**
 * One rule per notifiable fact. It is the event type, or `type.variant` when a condition
 * inside the event changes the severity (budget soft/hard, issue blocked/done).
 */
export const RULE_KEYS = [
  "approval.created",
  "approval.decided",
  "agent.run.failed",
  "agent.run.finished",
  "budget.incident.opened.hard",
  "budget.incident.opened.soft",
  "budget.incident.resolved",
  "issue.updated.blocked",
  "issue.updated.done",
  "issue.created",
  "issue.comment.created",
] as const;
export type RuleKey = (typeof RULE_KEYS)[number];

export interface EventRule {
  enabled: boolean;
  severity: Severity;
}

/** Event types the notifier subscribes to, one `events.on` each. */
export const SUBSCRIBED_EVENT_TYPES: readonly PluginEventType[] = [
  "approval.created",
  "approval.decided",
  "agent.run.failed",
  "agent.run.finished",
  "budget.incident.opened",
  "budget.incident.resolved",
  "issue.updated",
  "issue.created",
  "issue.comment.created",
];

/** Defaults from the spec's event catalog (decision 4). */
export const DEFAULT_RULES: Readonly<Record<RuleKey, Readonly<EventRule>>> = {
  "approval.created": { enabled: true, severity: "high" },
  "approval.decided": { enabled: true, severity: "normal" },
  "agent.run.failed": { enabled: true, severity: "high" },
  "agent.run.finished": { enabled: false, severity: "low" },
  "budget.incident.opened.hard": { enabled: true, severity: "urgent" },
  "budget.incident.opened.soft": { enabled: true, severity: "high" },
  "budget.incident.resolved": { enabled: true, severity: "normal" },
  "issue.updated.blocked": { enabled: true, severity: "high" },
  "issue.updated.done": { enabled: false, severity: "normal" },
  "issue.created": { enabled: false, severity: "low" },
  "issue.comment.created": { enabled: false, severity: "low" },
};

export function isRuleKey(value: string): value is RuleKey {
  return (RULE_KEYS as readonly string[]).includes(value);
}
