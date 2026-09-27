import { describe, expect, it, vi } from "vitest";
import {
  basicAuthHeader,
  extraHeadersSchema,
  parseBasicAuth,
  parseExtraHeaders,
  parseHttpUrl,
  resolveExtraHeaders,
  secretRefSchema,
  URL_PATTERN,
} from "./fields.js";
import type { SecretRef, SenderDeps } from "./types.js";

const secret = (id: string) => ({ type: "secret_ref", secretId: id }) as const;

describe("parseHttpUrl", () => {
  it("accepts http(s), strips trailing slashes, treats empty as absent", () => {
    const issues: string[] = [];
    expect(parseHttpUrl("https://h.example.com/x/", "u", issues)).toBe("https://h.example.com/x");
    expect(parseHttpUrl("http://10.0.0.5:8000", "u", issues)).toBe("http://10.0.0.5:8000");
    expect(parseHttpUrl("", "u", issues)).toBeUndefined();
    expect(parseHttpUrl(undefined, "u", issues)).toBeUndefined();
    expect(issues).toEqual([]);
  });

  it("reports other schemes and garbage", () => {
    const issues: string[] = [];
    parseHttpUrl("ftp://x", "apiUrl", issues);
    parseHttpUrl(42, "apiUrl", issues);
    expect(issues).toEqual(["apiUrl must be an http(s) URL", "apiUrl must be an http(s) URL"]);
  });

  it("exposes an empty-tolerant schema pattern", () => {
    const re = new RegExp(URL_PATTERN);
    expect(re.test("")).toBe(true);
    expect(re.test("https://x")).toBe(true);
    expect(re.test("x")).toBe(false);
  });
});

describe("parseExtraHeaders", () => {
  it("keeps valid headers with secret values", () => {
    const issues: string[] = [];
    const headers = parseExtraHeaders(
      [{ name: "X-Apprise-Config-ID", value: secret("c") }],
      issues,
    );
    expect(headers).toEqual([{ name: "X-Apprise-Config-ID", value: secret("c") }]);
    expect(issues).toEqual([]);
  });

  it("rejects reserved or invalid names and plain values", () => {
    const issues: string[] = [];
    const headers = parseExtraHeaders(
      [{ name: "Authorization", value: secret("x") }, { name: "bad name", value: "plain" }, "x"],
      issues,
    );
    expect(headers).toEqual([]);
    expect(issues.join("\n")).toMatch(/extraHeaders\.0\.name/);
    expect(issues.join("\n")).toMatch(/extraHeaders\.1\.value/);
    expect(issues.join("\n")).toMatch(/extraHeaders\.2\.name/);
  });

  it("rejects a non-list", () => {
    const issues: string[] = [];
    expect(parseExtraHeaders({}, issues)).toEqual([]);
    expect(issues).toEqual(["extraHeaders must be a list"]);
  });
});

describe("parseBasicAuth", () => {
  it("parses none and basic", () => {
    const issues: string[] = [];
    expect(parseBasicAuth(undefined, issues)).toEqual({ mode: "none" });
    expect(parseBasicAuth({ mode: "basic", username: "u", password: secret("p") }, issues)).toEqual(
      {
        mode: "basic",
        username: "u",
        password: secret("p"),
      },
    );
    expect(issues).toEqual([]);
  });

  it("reports missing parts and unknown modes", () => {
    const issues: string[] = [];
    parseBasicAuth({ mode: "basic" }, issues);
    parseBasicAuth({ mode: "token" }, issues);
    parseBasicAuth("basic", issues);
    expect(issues.join("\n")).toMatch(/auth\.username/);
    expect(issues.join("\n")).toMatch(/auth\.password/);
    expect(issues.join("\n")).toMatch(/auth\.mode must be one of none, basic/);
    expect(issues.join("\n")).toMatch(/auth must be an object/);
  });
});

describe("resolveExtraHeaders and basicAuthHeader", () => {
  it("resolves header secrets with the host config path", async () => {
    const resolveSecret = vi.fn(async (ref: SecretRef) => `v-${ref.secretId}`);
    const deps = { resolveSecret } as unknown as SenderDeps;
    const headers = await resolveExtraHeaders(
      [
        { name: "A", value: secret("a") },
        { name: "B", value: secret("b") },
      ],
      deps,
    );
    expect(headers).toEqual({ A: "v-a", B: "v-b" });
    expect(resolveSecret).toHaveBeenLastCalledWith(secret("b"), "extraHeaders.1.value");
  });

  it("builds a Basic header", () => {
    expect(basicAuthHeader("bot", "pw")).toBe(`Basic ${Buffer.from("bot:pw").toString("base64")}`);
  });
});

describe("schemas", () => {
  it("declares secret fields without type and headers as an array of objects", () => {
    expect(secretRefSchema("Token")).toEqual({ format: "secret-ref", title: "Token" });
    const schema = extraHeadersSchema("desc") as {
      type: string;
      items: { properties: Record<string, unknown> };
    };
    expect(schema.type).toBe("array");
    expect(schema.items.properties.value).toMatchObject({ format: "secret-ref", title: "Value" });
  });
});

describe("parseWithBase", () => {
  it("merges the shared fields with the plugin fields", async () => {
    const { parseWithBase } = await import("./fields.js");
    const config = parseWithBase({ topic: "t" }, (input) => ({ topic: String(input.topic) }));
    expect(config).toMatchObject({ enabled: true, topic: "t", minSeverity: "low" });
  });

  it("reports shared and plugin problems together", async () => {
    const { parseWithBase } = await import("./fields.js");
    const { ConfigError } = await import("./config.js");
    const attempt = () =>
      parseWithBase({ minSeverity: "loud" }, (_input, issues) => {
        issues.push("topic is required");
        return undefined;
      });
    expect(attempt).toThrow(ConfigError);
    try {
      attempt();
    } catch (error) {
      expect((error as InstanceType<typeof ConfigError>).issues).toEqual([
        "minSeverity must be one of low, normal, high, urgent",
        "topic is required",
      ]);
    }
  });

  it("rejects a non-object config", async () => {
    const { parseWithBase } = await import("./fields.js");
    expect(() => parseWithBase("x", () => ({}))).toThrow("config must be an object");
  });
});

describe("duplicate extra headers", () => {
  it("rejects names that differ only in case", () => {
    const issues: string[] = [];
    const headers = parseExtraHeaders(
      [
        { name: "CF-Access-Client-Id", value: secret("a") },
        { name: "cf-access-client-id", value: secret("b") },
      ],
      issues,
    );
    expect(headers).toHaveLength(1);
    expect(issues).toEqual(["extraHeaders.1.name duplicates another header"]);
  });
});
