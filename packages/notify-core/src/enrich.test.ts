import type { PluginEvent, PluginLogger } from "@paperclipai/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { collectFacts, type HostPorts } from "./enrich.js";

function event(
  eventType: PluginEvent["eventType"],
  payload: unknown,
  entityId = "ent-1",
): PluginEvent {
  return {
    eventId: "e",
    eventType,
    occurredAt: "2026-09-27T12:00:00Z",
    companyId: "co-1",
    entityId,
    payload,
  };
}

function ports(overrides: Partial<HostPorts> = {}): HostPorts {
  return {
    getApproval: vi.fn(async () => ({ status: "approved", type: "hire_agent" })),
    getAgentName: vi.fn(async () => "CTO"),
    getIssue: vi.fn(async () => ({
      assigneeAgentId: "ag-1",
      projectId: "pr-1",
      identifier: "PAP-1",
      title: "T",
    })),
    ...overrides,
  };
}

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } satisfies PluginLogger;
}

describe("collectFacts", () => {
  it("loads the approval for approval events", async () => {
    const p = ports();
    const facts = await collectFacts(event("approval.decided", {}, "ap-1"), p, logger(), false);
    expect(p.getApproval).toHaveBeenCalledWith("ap-1", "co-1");
    expect(p.getAgentName).not.toHaveBeenCalled();
    expect(p.getIssue).not.toHaveBeenCalled();
    expect(facts).toEqual({ approval: { status: "approved", type: "hire_agent" } });
  });

  it("loads the agent name for run events", async () => {
    const p = ports();
    const facts = await collectFacts(
      event("agent.run.failed", { agentId: "ag-1" }),
      p,
      logger(),
      false,
    );
    expect(p.getAgentName).toHaveBeenCalledWith("ag-1", "co-1");
    expect(facts).toEqual({ agentName: "CTO" });
  });

  it("always loads the issue for comments", async () => {
    const p = ports();
    const facts = await collectFacts(
      event("issue.comment.created", {}, "is-1"),
      p,
      logger(),
      false,
    );
    expect(p.getIssue).toHaveBeenCalledWith("is-1", "co-1");
    expect(facts.issue?.assigneeAgentId).toBe("ag-1");
  });

  it("loads the issue for other issue events only when needed", async () => {
    const p = ports();
    expect(await collectFacts(event("issue.created", {}), p, logger(), false)).toEqual({});
    expect(p.getIssue).not.toHaveBeenCalled();
    const facts = await collectFacts(event("issue.updated", {}), p, logger(), true);
    expect(facts.issue?.projectId).toBe("pr-1");
  });

  it("skips lookups without the ids they need", async () => {
    const p = ports();
    const { entityId: _omitted, ...noEntity } = event("approval.created", {});
    expect(await collectFacts(noEntity, p, logger(), true)).toEqual({});
    expect(await collectFacts(event("agent.run.failed", {}), p, logger(), true)).toEqual({});
    expect(p.getApproval).not.toHaveBeenCalled();
    expect(p.getAgentName).not.toHaveBeenCalled();
  });

  it("does nothing for budget events", async () => {
    const p = ports();
    expect(await collectFacts(event("budget.incident.opened", {}), p, logger(), true)).toEqual({});
  });

  it("drops a fact the host does not have", async () => {
    const p = ports({ getApproval: vi.fn(async () => null) });
    expect(await collectFacts(event("approval.created", {}), p, logger(), false)).toEqual({});
  });

  it("degrades with one warning when a lookup fails", async () => {
    const log = logger();
    const p = ports({
      getAgentName: vi.fn(async () => {
        throw new Error("host down");
      }),
    });
    const facts = await collectFacts(event("agent.run.failed", { agentId: "ag-1" }), p, log, false);
    expect(facts).toEqual({});
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      "notify.enrich_failed",
      expect.objectContaining({ lookup: "agent", error: "host down" }),
    );
  });
});
