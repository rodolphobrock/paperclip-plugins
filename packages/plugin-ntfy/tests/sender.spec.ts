import {
  type Notification,
  type SecretRef,
  SecretResolutionError,
  type SenderDeps,
} from "@paperclip-plugins/notify-core";
import { describe, expect, it, vi } from "vitest";
import { type NtfyConfig, parseNtfyConfig } from "../src/config.js";
import { ntfySender } from "../src/sender.js";

const secret = (id: string) => ({ type: "secret_ref", secretId: id }) as const;

const notification: Notification = {
  key: "agent.run.failed:run-1:failed",
  companyId: "co-1",
  eventType: "agent.run.failed",
  severity: "high",
  tone: "failure",
  title: "CTO falhou na execução",
  body: "exit 1",
  url: "https://pc.example.com/PAP/agents/ag-1/runs/run-1",
  tags: ["run", "agent:CTO"],
  occurredAt: "2026-09-27T12:00:00.000Z",
};

function deps(response: Response | Error = new Response("{}", { status: 200 })) {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => {
    if (response instanceof Error) throw response;
    return response;
  });
  const resolveSecret = vi.fn(async (ref: SecretRef) => `value-of-${ref.secretId}`);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { fetch, resolveSecret, logger } satisfies SenderDeps;
}

function config(overrides: Record<string, unknown> = {}): NtfyConfig {
  return parseNtfyConfig({ topic: "alerts", ...overrides });
}

function sentBody(d: ReturnType<typeof deps>): Record<string, unknown> {
  return JSON.parse(String(d.fetch.mock.calls[0]?.[1]?.body));
}

function sentHeaders(d: ReturnType<typeof deps>): Record<string, string> {
  return d.fetch.mock.calls[0]?.[1]?.headers as Record<string, string>;
}

describe("ntfySender.send", () => {
  it("publishes JSON to the server root", async () => {
    const d = deps();
    const result = await ntfySender.send(notification, config(), d);

    expect(result).toEqual({ ok: true });
    expect(d.fetch).toHaveBeenCalledWith(
      "https://ntfy.sh/",
      expect.objectContaining({ method: "POST" }),
    );
    expect(sentHeaders(d)).toEqual({ "Content-Type": "application/json" });
    expect(sentBody(d)).toEqual({
      topic: "alerts",
      title: "CTO falhou na execução",
      message: "exit 1",
      priority: 4,
      tags: ["rotating_light", "run", "agent:CTO"],
      click: "https://pc.example.com/PAP/agents/ag-1/runs/run-1",
    });
  });

  it.each([
    ["low", 2],
    ["normal", 3],
    ["high", 4],
    ["urgent", 5],
  ] as const)("maps severity %s to priority %i", async (severity, priority) => {
    const d = deps();
    await ntfySender.send({ ...notification, severity }, config(), d);
    expect(sentBody(d).priority).toBe(priority);
  });

  it.each([
    ["info", "information_source"],
    ["success", "white_check_mark"],
    ["warning", "warning"],
    ["failure", "rotating_light"],
  ] as const)("maps tone %s to the %s emoji tag", async (tone, tag) => {
    const d = deps();
    await ntfySender.send({ ...notification, tone }, config(), d);
    expect((sentBody(d).tags as string[])[0]).toBe(tag);
  });

  it("uses the topic for the severity and the server path", async () => {
    const d = deps();
    const cfg = config({
      serverUrl: "https://h.example.com/ntfy",
      topicsBySeverity: { high: "alerts-high" },
    });
    await ntfySender.send(notification, cfg, d);
    expect(d.fetch.mock.calls[0]?.[0]).toBe("https://h.example.com/ntfy/");
    expect(sentBody(d).topic).toBe("alerts-high");
  });

  it("uses the title as message when there is no body, and omits click without a URL", async () => {
    const d = deps();
    const { url: _url, ...withoutUrl } = notification;
    await ntfySender.send({ ...withoutUrl, body: "" }, config(), d);
    expect(sentBody(d).message).toBe("CTO falhou na execução");
    expect(sentBody(d)).not.toHaveProperty("click");
  });

  it("sends markdown and icon only when configured", async () => {
    const d = deps();
    await ntfySender.send(
      notification,
      config({ markdown: true, iconUrl: "https://e.com/i.png" }),
      d,
    );
    expect(sentBody(d)).toMatchObject({ markdown: true, icon: "https://e.com/i.png" });
  });

  it("authenticates with a bearer token", async () => {
    const d = deps();
    await ntfySender.send(
      notification,
      config({ auth: { mode: "token", token: secret("tok") } }),
      d,
    );
    expect(sentHeaders(d).Authorization).toBe("Bearer value-of-tok");
    expect(d.resolveSecret).toHaveBeenCalledWith(secret("tok"), "auth.token");
  });

  it("authenticates with basic auth", async () => {
    const d = deps();
    const cfg = config({ auth: { mode: "basic", username: "bot", password: secret("pw") } });
    await ntfySender.send(notification, cfg, d);
    const expected = `Basic ${Buffer.from("bot:value-of-pw").toString("base64")}`;
    expect(sentHeaders(d).Authorization).toBe(expected);
    expect(d.resolveSecret).toHaveBeenCalledWith(secret("pw"), "auth.password");
  });

  it("adds the resolved extra headers", async () => {
    const d = deps();
    const cfg = config({
      extraHeaders: [
        { name: "CF-Access-Client-Id", value: secret("id") },
        { name: "CF-Access-Client-Secret", value: secret("sec") },
      ],
    });
    await ntfySender.send(notification, cfg, d);
    expect(sentHeaders(d)).toMatchObject({
      "CF-Access-Client-Id": "value-of-id",
      "CF-Access-Client-Secret": "value-of-sec",
    });
    expect(d.resolveSecret).toHaveBeenCalledWith(secret("sec"), "extraHeaders.1.value");
  });

  it("classifies HTTP failures", async () => {
    const denied = await ntfySender.send(
      notification,
      config(),
      deps(new Response("forbidden", { status: 403 })),
    );
    expect(denied).toMatchObject({ ok: false, retryable: false });
    const limited = await ntfySender.send(
      notification,
      config(),
      deps(new Response("", { status: 429, headers: { "Retry-After": "10" } })),
    );
    expect(limited).toMatchObject({ ok: false, retryable: true, retryAfterMs: 10_000 });
  });

  it("treats network errors as retryable", async () => {
    const result = await ntfySender.send(
      notification,
      config(),
      deps(new TypeError("fetch failed")),
    );
    expect(result).toMatchObject({ ok: false, retryable: true });
  });

  it("fails permanently without leaking a secret that cannot be resolved", async () => {
    const d = deps();
    d.resolveSecret.mockRejectedValue(
      new SecretResolutionError("auth.token", new Error("tk_leak")),
    );
    const result = await ntfySender.send(
      notification,
      config({ auth: { mode: "token", token: secret("t") } }),
      d,
    );
    expect(result).toEqual({
      ok: false,
      retryable: false,
      error: "secret resolution failed (auth.token): unavailable",
    });
    expect(d.fetch).not.toHaveBeenCalled();
  });
});

describe("ntfySender.sendTest", () => {
  it("sends a fixed test message with default priority", async () => {
    const d = deps();
    expect(await ntfySender.sendTest(config(), d)).toEqual({ ok: true });
    expect(sentBody(d)).toMatchObject({
      topic: "alerts",
      title: "Paperclip test notification",
      priority: 3,
      tags: ["white_check_mark", "test"],
    });
  });
});
