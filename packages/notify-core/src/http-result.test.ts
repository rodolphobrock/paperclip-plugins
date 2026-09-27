import { describe, expect, it } from "vitest";
import { classifyError, classifyResponse, parseRetryAfter } from "./http-result.js";

const NOW = Date.parse("2026-09-27T12:00:00Z");

function response(status: number, body = "", headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : body, { status, headers });
}

describe("classifyResponse", () => {
  it.each([200, 201, 204])("treats %i as success", async (status) => {
    expect(await classifyResponse(response(status), NOW)).toEqual({ ok: true });
  });

  it.each([400, 401, 403, 404, 413])("treats %i as a permanent failure", async (status) => {
    const result = await classifyResponse(response(status, "bad topic"), NOW);
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(result.ok || result.error).toContain(String(status));
    expect(result.ok || result.error).toContain("bad topic");
  });

  it.each([500, 502, 503])("treats %i as retryable", async (status) => {
    expect(await classifyResponse(response(status), NOW)).toMatchObject({
      ok: false,
      retryable: true,
    });
  });

  it("treats 429 as retryable and honours Retry-After in seconds", async () => {
    const result = await classifyResponse(response(429, "", { "Retry-After": "30" }), NOW);
    expect(result).toMatchObject({ ok: false, retryable: true, retryAfterMs: 30_000 });
  });

  it("honours Retry-After as an HTTP date", async () => {
    const header = new Date(NOW + 90_000).toUTCString();
    const result = await classifyResponse(response(503, "", { "Retry-After": header }), NOW);
    expect(result).toMatchObject({ retryable: true, retryAfterMs: 90_000 });
  });

  it("omits retryAfterMs when Retry-After is invalid", async () => {
    const result = await classifyResponse(response(429, "", { "Retry-After": "soon" }), NOW);
    expect(result).not.toHaveProperty("retryAfterMs");
  });

  it("caps the body excerpt at 200 characters", async () => {
    const result = await classifyResponse(response(400, "x".repeat(1000)), NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeLessThanOrEqual(240);
  });
});

describe("parseRetryAfter", () => {
  it("parses seconds and dates, rejects the rest", () => {
    expect(parseRetryAfter("0", NOW)).toBe(0);
    expect(parseRetryAfter("120", NOW)).toBe(120_000);
    expect(parseRetryAfter(new Date(NOW - 5000).toUTCString(), NOW)).toBe(0);
    expect(parseRetryAfter(null, NOW)).toBeUndefined();
    expect(parseRetryAfter("-3", NOW)).toBeUndefined();
    expect(parseRetryAfter("later", NOW)).toBeUndefined();
  });
});

describe("classifyError", () => {
  it.each([
    ["AbortError", new DOMException("aborted", "AbortError")],
    ["TimeoutError", new DOMException("timed out", "TimeoutError")],
    ["network TypeError", new TypeError("fetch failed")],
    ["unknown error", new Error("boom")],
    ["non-error value", "boom"],
  ])("treats %s as retryable", (_label, error) => {
    const result = classifyError(error);
    expect(result).toMatchObject({ ok: false, retryable: true });
    expect(result.ok || result.error.length).toBeGreaterThan(0);
  });
});

describe("classifyError review fixes", () => {
  it("treats secret resolution failures as permanent and hides the cause", async () => {
    const { SecretResolutionError } = await import("./types.js");
    const result = classifyError(
      new SecretResolutionError("auth.token", new Error("secret sk-live-xyz gone")),
    );
    expect(result).toEqual({
      ok: false,
      retryable: false,
      error: "secret resolution failed (auth.token): unavailable",
    });
  });

  it("redacts credentials from error messages and response bodies", async () => {
    const result = classifyError(new TypeError("Failed to parse URL from https://u:pw@h/x"));
    expect(result.ok || result.error).not.toContain("pw@");
    const res = new Response("bad token=abc123", { status: 400 });
    const classified = await classifyResponse(res, NOW);
    expect(classified.ok || classified.error).not.toContain("abc123");
  });
});

describe("SecretResolutionError reasons", () => {
  it.each([
    [
      "Secret is not bound to plugin:x at extraHeaders.0.value",
      "not bound to this plugin at this config path",
    ],
    ["Rate limit exceeded for secret resolution", "rate limited, try again in a minute"],
    ["Plugin secret reference is ambiguous; pass configPath", "ambiguous reference"],
    ["Invalid secret reference for plugin: hunter2. Use a binding", "invalid secret reference"],
    ["Secret not found", "secret not found or deleted"],
    ["Secret has been deleted", "secret not found or deleted"],
  ])("maps %j to a fixed reason", async (message, reason) => {
    const { SecretResolutionError } = await import("./types.js");
    const error = new SecretResolutionError("extraHeaders.0.value", new Error(message));
    expect(error.message).toBe(`secret resolution failed (extraHeaders.0.value): ${reason}`);
    expect(error.message).not.toContain("hunter2");
  });
});
