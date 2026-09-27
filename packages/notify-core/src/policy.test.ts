import { describe, expect, it } from "vitest";
import { parseBaseConfig } from "./config.js";
import type { NotificationDraft } from "./mappers.js";
import { applyPolicy } from "./policy.js";

function draft(overrides: Partial<NotificationDraft> = {}): NotificationDraft {
  return {
    rule: "agent.run.failed",
    eventType: "agent.run.failed",
    severity: "high",
    tone: "failure",
    title: "CTO failed",
    body: "",
    tags: [],
    factKey: "failed",
    scope: { agentId: "ag-1", projectId: "pr-1" },
    ...overrides,
  };
}

describe("applyPolicy", () => {
  it("passes an enabled rule with its configured severity", () => {
    expect(applyPolicy(draft(), parseBaseConfig({}))).toEqual({ pass: true, severity: "high" });
  });

  it("blocks a disabled rule", () => {
    const config = parseBaseConfig({ events: { "agent.run.failed": { enabled: false } } });
    expect(applyPolicy(draft(), config)).toEqual({ pass: false, reason: "disabled" });
  });

  it("blocks rules that are off by default", () => {
    const config = parseBaseConfig({});
    expect(applyPolicy(draft({ rule: "issue.created" }), config)).toEqual({
      pass: false,
      reason: "disabled",
    });
  });

  it("uses the severity override", () => {
    const config = parseBaseConfig({ events: { "agent.run.failed": { severity: "urgent" } } });
    expect(applyPolicy(draft(), config)).toEqual({ pass: true, severity: "urgent" });
  });

  it("applies the minimum severity after the override", () => {
    const config = parseBaseConfig({
      minSeverity: "high",
      events: { "agent.run.failed": { severity: "normal" } },
    });
    expect(applyPolicy(draft(), config)).toEqual({ pass: false, reason: "severity" });
    expect(applyPolicy(draft({ rule: "approval.created" }), config)).toEqual({
      pass: true,
      severity: "high",
    });
  });

  describe("agent filter", () => {
    const config = parseBaseConfig({ filters: { agentIds: ["ag-1", "ag-2"] } });

    it("passes a listed agent", () => {
      expect(applyPolicy(draft(), config).pass).toBe(true);
    });

    it("blocks an unlisted agent", () => {
      expect(applyPolicy(draft({ scope: { agentId: "ag-9" } }), config)).toEqual({
        pass: false,
        reason: "filter",
      });
    });

    it("blocks an unknown agent while the filter is on", () => {
      expect(applyPolicy(draft({ scope: {} }), config)).toEqual({ pass: false, reason: "filter" });
    });
  });

  describe("project filter", () => {
    const config = parseBaseConfig({ filters: { projectIds: ["pr-1"] } });

    it("passes a listed project", () => {
      expect(applyPolicy(draft(), config).pass).toBe(true);
    });

    it("blocks an unlisted or unknown project", () => {
      expect(applyPolicy(draft({ scope: { projectId: "pr-2" } }), config).pass).toBe(false);
      expect(applyPolicy(draft({ scope: { agentId: "ag-1" } }), config).pass).toBe(false);
    });
  });
});
