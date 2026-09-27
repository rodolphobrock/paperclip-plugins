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

  // Inclusion lists: when a list is set, an event whose agent/project is unknown does not pass.
  if (!included(config.filters.agentIds, draft.scope.agentId))
    return { pass: false, reason: "filter" };
  if (!included(config.filters.projectIds, draft.scope.projectId))
    return { pass: false, reason: "filter" };

  return { pass: true, severity: rule.severity };
}

function included(list: string[], value: string | undefined): boolean {
  return list.length === 0 || (value !== undefined && list.includes(value));
}
