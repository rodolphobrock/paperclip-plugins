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
