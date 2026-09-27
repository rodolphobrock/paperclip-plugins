import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { describe, expect, it } from "vitest";
import { type EventFacts, mapEvent } from "./mappers.js";

function event(
  eventType: PluginEvent["eventType"],
  payload: unknown,
  extra: Partial<PluginEvent> = {},
): PluginEvent {
  return {
    eventId: "evt-1",
    eventType,
    occurredAt: "2026-09-27T12:00:00.000Z",
    companyId: "co-1",
    payload,
    ...extra,
  };
}

const none: EventFacts = {};

describe("approval.created", () => {
  it("asks for attention with a link to the approval", () => {
    const draft = mapEvent(
      event(
        "approval.created",
        { type: "hire_agent", agentId: "ag-1" },
        { entityId: "ap-1", entityType: "approval" },
      ),
      none,
    );
    expect(draft).toMatchObject({
      rule: "approval.created",
      severity: "high",
      tone: "warning",
      title: "Approval needed: hire an agent",
      link: { kind: "approval", approvalId: "ap-1" },
      factKey: "created",
      scope: { agentId: "ag-1" },
    });
    expect(draft?.tags).toContain("approval");
  });
});

describe("approval.decided", () => {
  const decided = (facts: EventFacts) =>
    mapEvent(
      event("approval.decided", { type: "approve_ceo_strategy" }, { entityId: "ap-1" }),
      facts,
    );

  it.each([
    ["approved", "success", "Approval approved: CEO strategy"],
    ["rejected", "failure", "Approval rejected: CEO strategy"],
    ["revision_requested", "warning", "Revision requested: CEO strategy"],
    ["cancelled", "info", "Approval decided: CEO strategy"],
  ])("reads the status from the approval (%s)", (status, tone, title) => {
    expect(decided({ approval: { status, type: "approve_ceo_strategy" } })).toMatchObject({
      tone,
      title,
      factKey: status,
    });
  });

  it("degrades to a neutral message without the approval", () => {
    expect(decided(none)).toMatchObject({
      tone: "info",
      title: "Approval decided: CEO strategy",
      factKey: "unknown",
    });
  });
});

describe("agent.run.failed", () => {
  const payload = {
    runId: "run-1",
    agentId: "ag-1",
    status: "failed",
    error: "exit 1",
    errorCode: "E_EXIT",
  };

  it("names the agent and links to the run", () => {
    const draft = mapEvent(event("agent.run.failed", payload, { entityId: "run-1" }), {
      agentName: "CTO",
    });
    expect(draft).toMatchObject({
      rule: "agent.run.failed",
      severity: "high",
      tone: "failure",
      title: "CTO failed",
      link: { kind: "run", agentId: "ag-1", runId: "run-1" },
      scope: { agentId: "ag-1" },
    });
    expect(draft?.body).toContain("exit 1");
    expect(draft?.body).toContain("E_EXIT");
    expect(draft?.tags).toContain("agent:CTO");
  });

  it("distinguishes timeouts", () => {
    const draft = mapEvent(event("agent.run.failed", { ...payload, status: "timed_out" }), none);
    expect(draft?.title).toBe("Agent timed out");
  });

  it("uses the entity id when the payload lacks runId", () => {
    const draft = mapEvent(
      event("agent.run.failed", { agentId: "ag-1" }, { entityId: "run-9" }),
      none,
    );
    expect(draft?.link).toEqual({ kind: "run", agentId: "ag-1", runId: "run-9" });
  });
});

describe("agent.run.finished", () => {
  it("reports a finished run", () => {
    const draft = mapEvent(event("agent.run.finished", { runId: "r", agentId: "a" }), {
      agentName: "Writer",
    });
    expect(draft).toMatchObject({
      rule: "agent.run.finished",
      tone: "success",
      title: "Writer finished a run",
    });
  });
});

describe("budget incidents", () => {
  it("treats a payload with approvalId as the hard limit", () => {
    const draft = mapEvent(
      event("budget.incident.opened", {
        scopeType: "company",
        amountObserved: 10_000,
        amountLimit: 10_000,
        approvalId: null,
      }),
      none,
    );
    expect(draft).toMatchObject({
      rule: "budget.incident.opened.hard",
      severity: "urgent",
      tone: "failure",
      title: "Budget limit reached",
      factKey: "hard",
    });
    expect(draft?.body).toContain("10000");
  });

  it("treats a payload without approvalId as the soft limit", () => {
    const draft = mapEvent(
      event("budget.incident.opened", {
        scopeType: "agent",
        amountObserved: 8000,
        amountLimit: 10_000,
      }),
      none,
    );
    expect(draft).toMatchObject({
      rule: "budget.incident.opened.soft",
      severity: "high",
      tone: "warning",
      title: "Budget nearing its limit",
      factKey: "soft",
    });
  });

  it("reports resolution", () => {
    const draft = mapEvent(
      event("budget.incident.resolved", { action: "raise_budget_and_resume", amount: 20_000 }),
      none,
    );
    expect(draft).toMatchObject({
      rule: "budget.incident.resolved",
      tone: "success",
      title: "Budget incident resolved",
    });
    expect(draft?.body).toContain("20000");
  });
});

describe("issue.updated", () => {
  const updated = (payload: unknown) =>
    mapEvent(event("issue.updated", payload, { entityId: "is-1" }), none);

  it.each([
    [
      "main route",
      { status: "blocked", _previous: { status: "in_progress" }, identifier: "PAP-7" },
    ],
    ["wake queue", { status: "blocked", previousStatus: "todo", identifier: "PAP-7" }],
    [
      "plugin route",
      { patch: { status: "blocked" }, _previous: { status: "todo" }, identifier: "PAP-7" },
    ],
    ["status only", { status: "blocked", identifier: "PAP-7" }],
  ])("detects blocked from the %s payload", (_label, payload) => {
    expect(updated(payload)).toMatchObject({
      rule: "issue.updated.blocked",
      severity: "high",
      tone: "warning",
      title: "PAP-7 is blocked",
      link: { kind: "issue", identifier: "PAP-7" },
      factKey: "blocked",
    });
  });

  it("detects done", () => {
    expect(
      updated({ status: "done", _previous: { status: "in_review" }, identifier: "PAP-7" }),
    ).toMatchObject({
      rule: "issue.updated.done",
      tone: "success",
      title: "PAP-7 is done",
    });
  });

  it.each([
    ["no status change", { status: "blocked", _previous: { status: "blocked" } }],
    ["other status", { status: "in_progress", _previous: { status: "todo" } }],
    ["no status", { title: "renamed" }],
  ])("ignores %s", (_label, payload) => {
    expect(updated(payload)).toBeNull();
  });

  it("falls back to a generic label without an identifier", () => {
    const draft = updated({ status: "blocked" });
    expect(draft?.title).toBe("Issue is blocked");
    expect(draft?.link).toBeUndefined();
  });
});

describe("issue.created", () => {
  it("includes identifier and title", () => {
    const draft = mapEvent(
      event("issue.created", { identifier: "PAP-8", title: "Fix login", status: "todo" }),
      none,
    );
    expect(draft).toMatchObject({
      rule: "issue.created",
      severity: "low",
      tone: "info",
      title: "New issue PAP-8: Fix login",
      link: { kind: "issue", identifier: "PAP-8" },
    });
  });

  it("uses the project from the issue facts for filtering", () => {
    const draft = mapEvent(event("issue.created", { identifier: "PAP-8" }), {
      issue: { assigneeAgentId: null, projectId: "pr-1", identifier: "PAP-8", title: "x" },
    });
    expect(draft?.scope.projectId).toBe("pr-1");
  });
});

describe("issue.comment.created", () => {
  const issue = { assigneeAgentId: "ag-1", projectId: null, identifier: "PAP-9", title: "Docs" };
  const comment = (extra: Partial<PluginEvent>, facts: EventFacts = { issue }) =>
    mapEvent(
      event("issue.comment.created", { commentId: "c-1", bodySnippet: "Looks good" }, extra),
      facts,
    );

  it("ignores comments by the assigned agent", () => {
    expect(comment({ actorType: "agent", actorId: "ag-1" })).toBeNull();
  });

  it("notifies comments by others", () => {
    const draft = comment({ actorType: "user", actorId: "u-1" });
    expect(draft).toMatchObject({
      rule: "issue.comment.created",
      title: "New comment on PAP-9",
      factKey: "c-1",
      link: { kind: "issue", identifier: "PAP-9" },
    });
    expect(draft?.body).toContain("Looks good");
  });

  it("notifies when the issue could not be loaded", () => {
    expect(comment({ actorType: "agent", actorId: "ag-1" }, none)).not.toBeNull();
  });

  it("falls back to the event id without a comment id", () => {
    const draft = mapEvent(
      event("issue.comment.created", { identifier: "PAP-9" }, { actorType: "user" }),
      none,
    );
    expect(draft?.factKey).toBe("evt-1");
  });
});

describe("robustness", () => {
  it.each([[null], [{}], ["text"], [[1]], [{ status: 3, identifier: {}, agentId: 5, runId: [] }]])(
    "never throws on odd payload %j",
    (payload) => {
      for (const type of [
        "approval.created",
        "approval.decided",
        "agent.run.failed",
        "agent.run.finished",
        "budget.incident.opened",
        "budget.incident.resolved",
        "issue.updated",
        "issue.created",
        "issue.comment.created",
      ] as const) {
        expect(() => mapEvent(event(type, payload), none)).not.toThrow();
      }
    },
  );

  it("ignores event types outside the catalog", () => {
    expect(mapEvent(event("agent.created", {}), none)).toBeNull();
  });

  it("truncates long titles to 120 characters", () => {
    const draft = mapEvent(
      event("issue.created", { identifier: "PAP-1", title: "x".repeat(300) }),
      none,
    );
    expect(draft?.title).toHaveLength(120);
    expect(draft?.title.endsWith("…")).toBe(true);
  });
});

describe("review fixes", () => {
  it("ignores a requested status that did not change (main PATCH route)", () => {
    const payload = { status: "blocked", _previous: { description: "old" }, identifier: "PAP-7" };
    expect(mapEvent(event("issue.updated", payload), none)).toBeNull();
    const withChanges = { status: "blocked", changes: { description: { from: "a", to: "b" } } };
    expect(mapEvent(event("issue.updated", withChanges), none)).toBeNull();
  });

  it("reads the status change from changes", () => {
    const payload = { changes: { status: { from: "todo", to: "blocked" } }, identifier: "PAP-7" };
    expect(mapEvent(event("issue.updated", payload), none)?.rule).toBe("issue.updated.blocked");
  });

  it("redacts secrets from run errors", () => {
    const payload = {
      agentId: "a",
      runId: "r",
      error: "POST https://u:pw@h/x token=abc123 failed",
    };
    const draft = mapEvent(event("agent.run.failed", payload), none);
    expect(draft?.body).not.toContain("pw@");
    expect(draft?.body).not.toContain("abc123");
  });

  it("caps comment snippets and titles in the body", () => {
    const payload = { commentId: "c", bodySnippet: "y".repeat(1000), issueTitle: "t".repeat(1000) };
    const draft = mapEvent(event("issue.comment.created", payload, { actorType: "user" }), none);
    for (const line of draft?.body.split("\n") ?? []) expect(line.length).toBeLessThanOrEqual(300);
  });

  describe("scope", () => {
    it("uses the issue assignee, not the acting agent, for issue events", () => {
      const facts: EventFacts = {
        issue: { assigneeAgentId: "ag-owner", projectId: "pr-1", identifier: "PAP-1", title: "x" },
      };
      const draft = mapEvent(
        event("issue.updated", { status: "blocked", agentId: "ag-actor" }),
        facts,
      );
      expect(draft?.scope).toEqual({ agentId: "ag-owner", projectId: "pr-1" });
    });

    it("uses the requester for approvals", () => {
      const draft = mapEvent(event("approval.decided", { requestedByAgentId: "ag-req" }), none);
      expect(draft?.scope.agentId).toBe("ag-req");
    });

    it("uses the budget scope", () => {
      const agentScope = { scopeType: "agent", scopeId: "ag-9" };
      expect(mapEvent(event("budget.incident.opened", agentScope), none)?.scope).toEqual({
        agentId: "ag-9",
      });
      const projectScope = { scopeType: "project", scopeId: "pr-9" };
      expect(mapEvent(event("budget.incident.resolved", projectScope), none)?.scope).toEqual({
        projectId: "pr-9",
      });
      expect(
        mapEvent(event("budget.incident.opened", { scopeType: "company", scopeId: "co" }), none)
          ?.scope,
      ).toEqual({});
    });

    it("uses the run agent and the run issue project", () => {
      const facts: EventFacts = {
        issue: { assigneeAgentId: "x", projectId: "pr-3", identifier: "PAP-3", title: "x" },
      };
      const draft = mapEvent(
        event("agent.run.failed", { agentId: "ag-1", issueId: "is-3" }),
        facts,
      );
      expect(draft?.scope).toEqual({ agentId: "ag-1", projectId: "pr-3" });
    });
  });
});
