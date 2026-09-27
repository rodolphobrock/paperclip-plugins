import { ConfigError } from "@paperclip-plugins/notify-core";
import { describe, expect, it } from "vitest";
import { ntfyConfigSchema, parseNtfyConfig } from "../src/config.js";

const secret = (id: string) => ({ type: "secret_ref", secretId: id }) as const;

function issuesOf(raw: unknown): string[] {
  try {
    parseNtfyConfig(raw);
  } catch (error) {
    if (error instanceof ConfigError) return error.issues;
    throw error;
  }
  return [];
}

describe("parseNtfyConfig", () => {
  it("applies defaults around the required topic", () => {
    const config = parseNtfyConfig({ topic: "paperclip-alerts" });
    expect(config).toMatchObject({
      enabled: true,
      serverUrl: "https://ntfy.sh",
      topic: "paperclip-alerts",
      topicsBySeverity: {},
      auth: { mode: "none" },
      extraHeaders: [],
      markdown: false,
      minSeverity: "low",
    });
    expect(config).not.toHaveProperty("iconUrl");
  });

  it("keeps explicit values and trims the server URL", () => {
    const config = parseNtfyConfig({
      topic: "alerts",
      serverUrl: "https://ntfy.example.com/sub/",
      topicsBySeverity: { urgent: "alerts-urgent" },
      auth: { mode: "token", token: secret("tok") },
      extraHeaders: [{ name: "CF-Access-Client-Id", value: secret("cf-id") }],
      markdown: true,
      iconUrl: "https://example.com/icon.png",
    });
    expect(config).toMatchObject({
      serverUrl: "https://ntfy.example.com/sub",
      topicsBySeverity: { urgent: "alerts-urgent" },
      auth: { mode: "token", token: secret("tok") },
      extraHeaders: [{ name: "CF-Access-Client-Id", value: secret("cf-id") }],
      markdown: true,
      iconUrl: "https://example.com/icon.png",
    });
  });

  it("accepts basic auth with a username and a password secret", () => {
    const config = parseNtfyConfig({
      topic: "t",
      auth: { mode: "basic", username: "bot", password: secret("pw") },
    });
    expect(config.auth).toEqual({ mode: "basic", username: "bot", password: secret("pw") });
  });

  it("requires a valid topic", () => {
    expect(issuesOf({})).toEqual(["topic is required"]);
    expect(issuesOf({ topic: "has space" })[0]).toMatch(/topic/);
    expect(issuesOf({ topic: "x".repeat(65) })[0]).toMatch(/topic/);
  });

  it("reports ntfy and shared problems together", () => {
    const issues = issuesOf({
      topic: "ok",
      minSeverity: "loud",
      serverUrl: "ftp://x",
      topicsBySeverity: { urgent: "bad topic", critical: "x" },
      auth: { mode: "token" },
      extraHeaders: [
        { name: "Authorization", value: secret("x") },
        { name: "bad name", value: "plain" },
      ],
      markdown: "yes",
      iconUrl: "not a url",
    });
    const text = issues.join("\n");
    expect(text).toMatch(/minSeverity/);
    expect(text).toMatch(/serverUrl/);
    expect(text).toMatch(/topicsBySeverity\.urgent/);
    expect(text).toMatch(/topicsBySeverity\.critical/);
    expect(text).toMatch(/auth\.token/);
    expect(text).toMatch(/extraHeaders\[0\]\.name/);
    expect(text).toMatch(/extraHeaders\[1\]\.name/);
    expect(text).toMatch(/extraHeaders\[1\]\.value/);
    expect(text).toMatch(/markdown/);
    expect(text).toMatch(/iconUrl/);
  });

  it("validates each auth mode", () => {
    expect(issuesOf({ topic: "t", auth: { mode: "basic", password: secret("p") } })[0]).toMatch(
      /auth\.username/,
    );
    expect(issuesOf({ topic: "t", auth: { mode: "basic", username: "u" } })[0]).toMatch(
      /auth\.password/,
    );
    expect(issuesOf({ topic: "t", auth: { mode: "oauth" } })[0]).toMatch(/auth\.mode/);
    expect(issuesOf({ topic: "t", auth: "token" })[0]).toMatch(/auth/);
  });

  it("rejects a non-object config", () => {
    expect(issuesOf("x")).toEqual(["config must be an object"]);
  });
});

describe("ntfyConfigSchema", () => {
  it("is an object schema requiring the topic and marking secrets", () => {
    expect(ntfyConfigSchema.type).toBe("object");
    expect(ntfyConfigSchema.required).toEqual(["topic"]);
    const props = ntfyConfigSchema.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining([
        "enabled",
        "paperclipBaseUrl",
        "events",
        "serverUrl",
        "topic",
        "auth",
      ]),
    );
    const auth = props.auth as { properties: Record<string, { format?: string }> };
    expect(auth.properties.token?.format).toBe("secret-ref");
    expect(auth.properties.password?.format).toBe("secret-ref");
    const headers = props.extraHeaders as {
      items: { properties: Record<string, { format?: string }> };
    };
    expect(headers.items.properties.value?.format).toBe("secret-ref");
  });
});
