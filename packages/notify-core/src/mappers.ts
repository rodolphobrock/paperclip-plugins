import type { PluginEvent, PluginEventType } from "@paperclipai/plugin-sdk";
import { DEFAULT_RULES, type RuleKey } from "./catalog.js";
import { isRecord, readNumber, readString } from "./guards.js";
import { redact } from "./redact.js";
import type { Severity, Tone } from "./severity.js";
import type { LinkTarget } from "./types.js";

const TITLE_MAX = 120;
const DETAIL_MAX = 300;

/** Data fetched from the host before mapping; any of it may be missing. */
export interface EventFacts {
  approval?: { status: string; type: string };
  agentName?: string;
  issue?: {
    assigneeAgentId: string | null;
    projectId: string | null;
    identifier: string | null;
    title: string;
  };
}

/** A notification before policy, dedupe and link resolution. */
export interface NotificationDraft {
  rule: RuleKey;
  eventType: PluginEventType;
  severity: Severity;
  tone: Tone;
  title: string;
  body: string;
  tags: string[];
  link?: LinkTarget;
  /** The fact's relevant state, part of the semantic dedupe key. */
  factKey: string;
  scope: { projectId?: string; agentId?: string };
}

interface DraftInput {
  rule: RuleKey;
  tone: Tone;
  title: string;
  body?: (string | undefined)[];
  tags: string[];
  link?: LinkTarget | undefined;
  factKey: string;
}

/** Pure mapping from a host event to a draft; null when the event is not worth notifying. */
export function mapEvent(event: PluginEvent, facts: EventFacts): NotificationDraft | null {
  const payload = isRecord(event.payload) ? event.payload : {};
  const input = mapByType(event, payload, facts);
  if (input === null) return null;

  const draft: NotificationDraft = {
    rule: input.rule,
    eventType: event.eventType as PluginEventType,
    severity: DEFAULT_RULES[input.rule].severity,
    tone: input.tone,
    title: truncate(input.title, TITLE_MAX),
    body: (input.body ?? [])
      .filter((line): line is string => Boolean(line))
      .map((line) => truncate(line, DETAIL_MAX))
      .join("\n"),
    tags: input.tags,
    factKey: input.factKey,
    scope: scopeOf(event, payload, facts),
  };
  if (input.link !== undefined) draft.link = input.link;
  return draft;
}

/**
 * The agent and project the fact is about, for the inclusion filters. The payload's
 * `agentId` is the agent that acted, which is only the right answer for runs.
 */
function scopeOf(
  event: PluginEvent,
  payload: Record<string, unknown>,
  facts: EventFacts,
): NotificationDraft["scope"] {
  let agentId: string | undefined;
  let projectId = readString(payload, "projectId") ?? facts.issue?.projectId ?? undefined;

  if (event.eventType.startsWith("agent.run.")) {
    agentId = readString(payload, "agentId");
  } else if (event.eventType.startsWith("approval.")) {
    agentId = readString(payload, "requestedByAgentId") ?? readString(payload, "agentId");
  } else if (event.eventType.startsWith("issue.")) {
    agentId = facts.issue?.assigneeAgentId ?? undefined;
  } else if (event.eventType.startsWith("budget.")) {
    const scopeType = readString(payload, "scopeType");
    const scopeId = readString(payload, "scopeId");
    if (scopeType === "agent") agentId = scopeId;
    if (scopeType === "project") projectId = scopeId;
  }

  const scope: NotificationDraft["scope"] = {};
  if (agentId !== undefined) scope.agentId = agentId;
  if (projectId !== undefined) scope.projectId = projectId;
  return scope;
}

function mapByType(
  event: PluginEvent,
  payload: Record<string, unknown>,
  facts: EventFacts,
): DraftInput | null {
  switch (event.eventType) {
    case "approval.created":
      return approvalCreated(event, payload);
    case "approval.decided":
      return approvalDecided(event, payload, facts);
    case "agent.run.failed":
    case "agent.run.finished":
      return agentRun(event, payload, facts);
    case "budget.incident.opened":
      return budgetOpened(payload);
    case "budget.incident.resolved":
      return budgetResolved(payload);
    case "issue.updated":
      return issueUpdated(payload, facts);
    case "issue.created":
      return issueCreated(payload, facts);
    case "issue.comment.created":
      return issueComment(event, payload, facts);
    default:
      return null;
  }
}

const APPROVAL_LABELS: Record<string, string> = {
  hire_agent: "hire an agent",
  approve_ceo_strategy: "CEO strategy",
  budget_override_required: "budget override",
  request_board_approval: "board request",
};

function approvalLabel(type: string | undefined): string {
  if (type === undefined) return "request";
  return APPROVAL_LABELS[type] ?? type.replaceAll("_", " ");
}

function approvalLink(event: PluginEvent): LinkTarget | undefined {
  return event.entityId ? { kind: "approval", approvalId: event.entityId } : undefined;
}

function approvalCreated(event: PluginEvent, payload: Record<string, unknown>): DraftInput {
  return {
    rule: "approval.created",
    tone: "warning",
    title: `Approval needed: ${approvalLabel(readString(payload, "type"))}`,
    tags: ["approval"],
    link: approvalLink(event),
    factKey: "created",
  };
}

const DECISIONS: Record<string, { tone: Tone; prefix: string }> = {
  approved: { tone: "success", prefix: "Approval approved" },
  rejected: { tone: "failure", prefix: "Approval rejected" },
  revision_requested: { tone: "warning", prefix: "Revision requested" },
};

function approvalDecided(
  event: PluginEvent,
  payload: Record<string, unknown>,
  facts: EventFacts,
): DraftInput {
  const status = facts.approval?.status;
  const decision = (status !== undefined ? DECISIONS[status] : undefined) ?? {
    tone: "info" as const,
    prefix: "Approval decided",
  };
  const label = approvalLabel(readString(payload, "type") ?? facts.approval?.type);
  return {
    rule: "approval.decided",
    tone: decision.tone,
    title: `${decision.prefix}: ${label}`,
    tags: ["approval"],
    link: approvalLink(event),
    factKey: status ?? "unknown",
  };
}

function agentRun(
  event: PluginEvent,
  payload: Record<string, unknown>,
  facts: EventFacts,
): DraftInput {
  const agent = facts.agentName ?? "Agent";
  const agentId = readString(payload, "agentId");
  const runId = readString(payload, "runId") ?? event.entityId;
  const link: LinkTarget | undefined =
    agentId !== undefined && runId !== undefined ? { kind: "run", agentId, runId } : undefined;
  const tags = ["run", ...(facts.agentName !== undefined ? [`agent:${facts.agentName}`] : [])];

  if (event.eventType === "agent.run.finished") {
    return {
      rule: "agent.run.finished",
      tone: "success",
      title: `${agent} finished a run`,
      tags,
      link,
      factKey: "finished",
    };
  }

  const timedOut = readString(payload, "status") === "timed_out";
  const error = readString(payload, "error");
  const errorCode = readString(payload, "errorCode");
  return {
    rule: "agent.run.failed",
    tone: "failure",
    title: timedOut ? `${agent} timed out` : `${agent} failed`,
    body: [
      // Adapter output skips the host's redaction and may echo credentials.
      error !== undefined ? redact(error) : undefined,
      errorCode && `Code: ${errorCode}`,
    ],
    tags,
    link,
    factKey: "failed",
  };
}

function budgetAmounts(payload: Record<string, unknown>): string | undefined {
  const observed = readNumber(payload, "amountObserved");
  const limit = readNumber(payload, "amountLimit");
  if (observed === undefined || limit === undefined) return undefined;
  const scope = readString(payload, "scopeType");
  return `Spent ${observed} of ${limit}${scope ? ` (${scope})` : ""}`;
}

function budgetOpened(payload: Record<string, unknown>): DraftInput {
  // Only the hard-limit incident carries `approvalId` (possibly null); see the plan's facts table.
  const hard = "approvalId" in payload;
  return {
    rule: hard ? "budget.incident.opened.hard" : "budget.incident.opened.soft",
    tone: hard ? "failure" : "warning",
    title: hard ? "Budget limit reached" : "Budget nearing its limit",
    body: [budgetAmounts(payload)],
    tags: ["budget"],
    factKey: hard ? "hard" : "soft",
  };
}

function budgetResolved(payload: Record<string, unknown>): DraftInput {
  const action = readString(payload, "action");
  const amount = readNumber(payload, "amount");
  const detail =
    action === "raise_budget_and_resume"
      ? `Budget raised${amount !== undefined ? ` to ${amount}` : ""} and work resumed`
      : action === "keep_paused"
        ? "Kept paused"
        : undefined;
  return {
    rule: "budget.incident.resolved",
    tone: "success",
    title: "Budget incident resolved",
    body: [detail],
    tags: ["budget"],
    factKey: "resolved",
  };
}

function issueIdentifier(payload: Record<string, unknown>, facts: EventFacts): string | undefined {
  return readString(payload, "identifier") ?? facts.issue?.identifier ?? undefined;
}

function issueLink(identifier: string | undefined): LinkTarget | undefined {
  return identifier !== undefined ? { kind: "issue", identifier } : undefined;
}

function issueUpdated(payload: Record<string, unknown>, facts: EventFacts): DraftInput | null {
  const change = statusChange(payload);
  if (change === null) return null;
  const { status } = change;
  if (status !== "blocked" && status !== "done") return null;

  const identifier = issueIdentifier(payload, facts);
  const blocked = status === "blocked";
  return {
    rule: blocked ? "issue.updated.blocked" : "issue.updated.done",
    tone: blocked ? "warning" : "success",
    title: `${identifier ?? "Issue"} is ${status}`,
    body: [readString(payload, "title") ?? facts.issue?.title],
    tags: ["issue"],
    link: issueLink(identifier),
    factKey: status,
  };
}

/**
 * Emitters disagree on the shape: `changes.status.{from,to}`; `status` + `_previous.status`
 * (main PATCH route, where `status` is the requested value and `changes`/`_previous` list only
 * fields that really changed); `status` + `previousStatus`; `patch.status` + `_previous.status`;
 * or `status` alone. Returns null when the status did not change.
 */
function statusChange(payload: Record<string, unknown>): { status: string } | null {
  const { changes, _previous: previousFields, patch } = payload;
  if (isRecord(changes) && isRecord(changes.status)) {
    const to = readString(changes.status, "to");
    return to !== undefined && to !== readString(changes.status, "from") ? { status: to } : null;
  }

  const status = readString(payload, "status") ?? readString(patch, "status");
  const previous = readString(previousFields, "status") ?? readString(payload, "previousStatus");
  if (status === undefined || status === previous) return null;

  const listsRealChanges = isRecord(changes) || (isRecord(previousFields) && !isRecord(patch));
  if (previous === undefined && listsRealChanges) return null;
  return { status };
}

function issueCreated(payload: Record<string, unknown>, facts: EventFacts): DraftInput {
  const identifier = issueIdentifier(payload, facts);
  const title = readString(payload, "title") ?? facts.issue?.title;
  const head = identifier !== undefined ? `New issue ${identifier}` : "New issue";
  return {
    rule: "issue.created",
    tone: "info",
    title: title ? `${head}: ${title}` : head,
    tags: ["issue"],
    link: issueLink(identifier),
    factKey: "created",
  };
}

function issueComment(
  event: PluginEvent,
  payload: Record<string, unknown>,
  facts: EventFacts,
): DraftInput | null {
  const assignee = facts.issue?.assigneeAgentId;
  if (event.actorType === "agent" && assignee && event.actorId === assignee) return null;

  const identifier = issueIdentifier(payload, facts);
  return {
    rule: "issue.comment.created",
    tone: "info",
    title: `New comment on ${identifier ?? "an issue"}`,
    body: [
      readString(payload, "issueTitle") ?? facts.issue?.title,
      readString(payload, "bodySnippet"),
    ],
    tags: ["comment"],
    link: issueLink(identifier),
    factKey: readString(payload, "commentId") ?? event.eventId,
  };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
