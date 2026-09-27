import { describe, expect, it } from "vitest";
import { DEFAULT_RULES, RULE_KEYS, SUBSCRIBED_EVENT_TYPES } from "./catalog.js";
import { baseConfigSchema, ConfigError, parseBaseConfig } from "./config.js";

describe("catalog", () => {
  it("subscribes to each event type once", () => {
    expect(new Set(SUBSCRIBED_EVENT_TYPES).size).toBe(SUBSCRIBED_EVENT_TYPES.length);
    expect(SUBSCRIBED_EVENT_TYPES).toHaveLength(9);
    expect(SUBSCRIBED_EVENT_TYPES).not.toContain("agent.status_changed");
  });

  it("matches the spec's defaults (decision 4)", () => {
    expect(DEFAULT_RULES["approval.created"]).toEqual({ enabled: true, severity: "high" });
    expect(DEFAULT_RULES["approval.decided"]).toEqual({ enabled: true, severity: "normal" });
    expect(DEFAULT_RULES["agent.run.failed"]).toEqual({ enabled: true, severity: "high" });
    expect(DEFAULT_RULES["budget.incident.opened.hard"]).toEqual({
      enabled: true,
      severity: "urgent",
    });
    expect(DEFAULT_RULES["budget.incident.opened.soft"]).toEqual({
      enabled: true,
      severity: "high",
    });
    expect(DEFAULT_RULES["budget.incident.resolved"]).toEqual({
      enabled: true,
      severity: "normal",
    });
    expect(DEFAULT_RULES["issue.updated.blocked"]).toEqual({ enabled: true, severity: "high" });
    expect(DEFAULT_RULES["issue.updated.done"]).toEqual({ enabled: false, severity: "normal" });
    expect(DEFAULT_RULES["issue.created"]).toEqual({ enabled: false, severity: "low" });
    expect(DEFAULT_RULES["issue.comment.created"]).toEqual({ enabled: false, severity: "low" });
    expect(DEFAULT_RULES["agent.run.finished"]).toEqual({ enabled: false, severity: "low" });
    expect(Object.keys(DEFAULT_RULES).sort()).toEqual([...RULE_KEYS].sort());
  });
});

describe("parseBaseConfig", () => {
  it("fills every default from an empty object", () => {
    expect(parseBaseConfig({})).toEqual({
      enabled: true,
      events: DEFAULT_RULES,
      minSeverity: "low",
      filters: { projectIds: [], agentIds: [] },
      network: { allowPrivateNetwork: false },
    });
  });

  it("merges partial event overrides with the defaults", () => {
    const config = parseBaseConfig({
      events: { "issue.created": { enabled: true }, "approval.created": { severity: "urgent" } },
    });
    expect(config.events["issue.created"]).toEqual({ enabled: true, severity: "low" });
    expect(config.events["approval.created"]).toEqual({ enabled: true, severity: "urgent" });
    expect(config.events["agent.run.failed"]).toEqual(DEFAULT_RULES["agent.run.failed"]);
  });

  it("keeps explicit values and strips the base URL's trailing slashes", () => {
    const config = parseBaseConfig({
      enabled: false,
      paperclipBaseUrl: "https://pc.example.com/app//",
      minSeverity: "high",
      filters: { projectIds: ["p1"], agentIds: ["a1", "a2"] },
      network: { allowPrivateNetwork: true },
      topic: "ignored-by-core",
    });
    expect(config).toMatchObject({
      enabled: false,
      paperclipBaseUrl: "https://pc.example.com/app",
      minSeverity: "high",
      filters: { projectIds: ["p1"], agentIds: ["a1", "a2"] },
      network: { allowPrivateNetwork: true },
    });
  });

  it("treats null and undefined as empty config", () => {
    expect(parseBaseConfig(null).enabled).toBe(true);
    expect(parseBaseConfig(undefined).minSeverity).toBe("low");
  });

  it("reports every problem at once", () => {
    const attempt = () =>
      parseBaseConfig({
        enabled: "yes",
        paperclipBaseUrl: "ftp://example.com",
        minSeverity: "critical",
        events: { "issue.created": { severity: "loud" }, "made.up": { enabled: true } },
        filters: { projectIds: "p1", agentIds: [1] },
        network: { allowPrivateNetwork: "no" },
      });
    expect(attempt).toThrow(ConfigError);
    try {
      attempt();
    } catch (error) {
      const issues = (error as ConfigError).issues;
      expect(issues).toHaveLength(8);
      expect(issues.join("\n")).toMatch(/paperclipBaseUrl/);
      expect(issues.join("\n")).toMatch(/events\.made\.up/);
      expect(issues.join("\n")).toMatch(/events\.issue\.created\.severity/);
    }
  });

  it("rejects a non-object config", () => {
    expect(() => parseBaseConfig("x")).toThrow(ConfigError);
    expect(() => parseBaseConfig([])).toThrow(ConfigError);
  });

  it("rejects a malformed base URL", () => {
    expect(() => parseBaseConfig({ paperclipBaseUrl: "not a url" })).toThrow(/paperclipBaseUrl/);
  });
});

describe("baseConfigSchema", () => {
  it("declares one property per config field and one per event rule", () => {
    expect(Object.keys(baseConfigSchema.properties).sort()).toEqual(
      ["enabled", "events", "filters", "minSeverity", "network", "paperclipBaseUrl"].sort(),
    );
    const events = baseConfigSchema.properties.events as { properties: Record<string, unknown> };
    expect(Object.keys(events.properties).sort()).toEqual([...RULE_KEYS].sort());
  });
});
