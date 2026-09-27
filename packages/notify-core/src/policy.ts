import type { BaseConfig } from "./config.js";
import type { NotificationDraft } from "./mappers.js";
import { compareSeverity, type Severity } from "./severity.js";

export type PolicyResult =
  | { pass: true; severity: Severity }
  | { pass: false; reason: "disabled" | "severity" | "filter" };

/** Event toggles, severity overrides, minimum severity and project/agent inclusion lists. */
export function applyPolicy(draft: NotificationDraft, config: BaseConfig): PolicyResult {
  const rule = config.events[draft.rule];
  if (!rule.enabled) return { pass: false, reason: "disabled" };
  if (compareSeverity(rule.severity, config.minSeverity) < 0)
    return { pass: false, reason: "severity" };

  if (excluded(config.filters.agentIds, draft.scope.agentId)) {
    return { pass: false, reason: "filter" };
  }
  if (excluded(config.filters.projectIds, draft.scope.projectId)) {
    return { pass: false, reason: "filter" };
  }

  return { pass: true, severity: rule.severity };
}

/**
 * Inclusion lists only apply to events that have that dimension: a company-wide budget
 * incident or a board decision has no agent, and must not be silenced by an agent filter.
 */
function excluded(list: string[], value: string | undefined): boolean {
  return list.length > 0 && value !== undefined && !list.includes(value);
}
