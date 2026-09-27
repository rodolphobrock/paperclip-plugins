import { ConfigError } from "@paperclip-plugins/notify-core";
import { describe, expect, it } from "vitest";
import { appriseConfigSchema, parseAppriseConfig } from "../src/config.js";

const secret = (id: string) => ({ type: "secret_ref", secretId: id }) as const;

function issuesOf(raw: unknown): string[] {
  try {
    parseAppriseConfig(raw);
  } catch (error) {
    if (error instanceof ConfigError) return error.issues;
    throw error;
  }
  return [];
}

describe("parseAppriseConfig", () => {
  it("defaults to stateful mode with tag routing", () => {
    const config = parseAppriseConfig({ apiUrl: "http://apprise:8000/", configKey: secret("key") });
    expect(config).toMatchObject({
      apiUrl: "http://apprise:8000",
      mode: "stateful",
      configKey: secret("key"),
      tagsBySeverity: { low: "info", normal: "info", high: "alert", urgent: "urgent,alert" },
      destinations: [],
      format: "text",
      auth: { mode: "none" },
      extraHeaders: [],
      enabled: true,
    });
  });

  it("merges tag overrides and ignores cleared ones", () => {
    const config = parseAppriseConfig({
      apiUrl: "https://a.example.com",
      configKey: secret("key"),
      tagsBySeverity: { urgent: "pager", low: "" },
    });
    expect(config.tagsBySeverity).toEqual({
      low: "info",
      normal: "info",
      high: "alert",
      urgent: "pager",
    });
  });

  it("accepts stateless mode with destinations", () => {
    const config = parseAppriseConfig({
      apiUrl: "https://a.example.com",
      mode: "stateless",
      destinations: [{ url: secret("tg"), minSeverity: "high" }, { url: secret("mail") }],
      format: "markdown",
      auth: { mode: "basic", username: "u", password: secret("pw") },
      extraHeaders: [{ name: "X-Apprise-Config-ID", value: secret("cfg") }],
    });
    expect(config).toMatchObject({
      mode: "stateless",
      destinations: [
        { url: secret("tg"), minSeverity: "high" },
        { url: secret("mail"), minSeverity: "low" },
      ],
      format: "markdown",
      auth: { mode: "basic", username: "u", password: secret("pw") },
    });
    expect(config).not.toHaveProperty("configKey");
  });

  it("requires what each mode needs", () => {
    expect(issuesOf({})).toEqual([
      "apiUrl is required",
      "configKey must be a secret reference in stateful mode",
    ]);
    expect(issuesOf({ apiUrl: "https://a" })).toEqual([
      "configKey must be a secret reference in stateful mode",
    ]);
    expect(issuesOf({ apiUrl: "https://a", mode: "stateless" })).toEqual([
      "destinations needs at least one destination in stateless mode",
    ]);
  });

  it("reports every problem at once", () => {
    const text = issuesOf({
      apiUrl: "ftp://a",
      mode: "sideways",
      minSeverity: "loud",
      tagsBySeverity: { urgent: "a/b", critical: "x" },
      destinations: [{ url: "tgram://token/chat", minSeverity: "loud" }, "x"],
      format: "html",
      auth: { mode: "token" },
      extraHeaders: [{ name: "Host", value: secret("x") }],
    }).join("\n");
    for (const path of [
      "apiUrl",
      "mode",
      "minSeverity",
      "tagsBySeverity.urgent",
      "tagsBySeverity.critical",
      "destinations.0.url",
      "destinations.0.minSeverity",
      "destinations.1",
      "format",
      "auth.mode",
      "extraHeaders.0.name",
    ]) {
      expect(text).toContain(path);
    }
    expect(text).not.toContain("tgram://token/chat");
  });
});

describe("appriseConfigSchema", () => {
  it("requires apiUrl and marks secrets", () => {
    expect(appriseConfigSchema.required).toEqual(["apiUrl"]);
    const props = appriseConfigSchema.properties as Record<string, Record<string, unknown>>;
    expect(props.configKey).toMatchObject({ format: "secret-ref" });
    const destinations = props.destinations as {
      items: { properties: Record<string, { format?: string }> };
    };
    expect(destinations.items.properties.url?.format).toBe("secret-ref");
    expect(Object.keys(props)).toEqual(expect.arrayContaining(["quietHours", "events", "mode"]));
  });
});
