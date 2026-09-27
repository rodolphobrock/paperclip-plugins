import {
  type Notification,
  type SecretRef,
  SecretResolutionError,
  type SenderDeps,
} from "@paperclip-plugins/notify-core";
import { describe, expect, it, vi } from "vitest";
import { type AppriseConfig, parseAppriseConfig } from "../src/config.js";
import { appriseSender } from "../src/sender.js";

const secret = (id: string) => ({ type: "secret_ref", secretId: id }) as const;

const SECRETS: Record<string, string> = {
  key: "abc123",
  tg: "tgram://bottoken/12345",
  ntfy: "ntfys://tk_secret@ntfy.example.com/alerts",
  ntfyq: "ntfy://ntfy.example.com/alerts?priority=min",
  mail: "mailto://user:pass@gmail.com",
  pw: "hunter2",
  cfg: "cfg-id",
};

const notification: Notification = {
  key: "k",
  companyId: "co-1",
  eventType: "agent.run.failed",
  severity: "high",
  tone: "failure",
  title: "CTO failed",
  body: "exit 1",
  url: "https://pc.example.com/PAP/agents/ag-1/runs/run-1",
  tags: ["run"],
  occurredAt: "2026-09-27T12:00:00.000Z",
};

function deps(responses: (Response | Error)[] = []) {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => {
    const next = responses.shift() ?? new Response("{}", { status: 200 });
    if (next instanceof Error) throw next;
    return next;
  });
  const resolveSecret = vi.fn(async (ref: SecretRef) => SECRETS[ref.secretId] ?? "missing");
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { fetch, resolveSecret, logger } satisfies SenderDeps;
}

const stateful = (overrides: Record<string, unknown> = {}): AppriseConfig =>
  parseAppriseConfig({ apiUrl: "http://apprise:8000", configKey: secret("key"), ...overrides });

const stateless = (destinations: unknown[], overrides: Record<string, unknown> = {}) =>
  parseAppriseConfig({
    apiUrl: "http://apprise:8000",
    mode: "stateless",
    destinations,
    ...overrides,
  });

const call = (d: ReturnType<typeof deps>, i = 0) => {
  const [url, init] = d.fetch.mock.calls[i] ?? [];
  return {
    url,
    headers: init?.headers as Record<string, string>,
    body: JSON.parse(String(init?.body)) as Record<string, unknown>,
  };
};

describe("stateful mode", () => {
  it("posts to /notify/{key} with the severity tag and the link in the body", async () => {
    const d = deps();
    expect(await appriseSender.send(notification, stateful(), d)).toEqual({ ok: true });
    expect(call(d)).toEqual({
      url: "http://apprise:8000/notify/abc123",
      headers: { "Content-Type": "application/json" },
      body: {
        title: "CTO failed",
        body: "exit 1\n\nhttps://pc.example.com/PAP/agents/ag-1/runs/run-1",
        type: "failure",
        tag: "alert",
        format: "text",
      },
    });
    expect(d.resolveSecret).toHaveBeenCalledWith(secret("key"), "configKey");
  });

  it.each([
    ["low", "info"],
    ["normal", "info"],
    ["urgent", "urgent,alert"],
  ] as const)("uses the %s tag", async (severity, tag) => {
    const d = deps();
    await appriseSender.send({ ...notification, severity }, stateful(), d);
    expect(call(d).body.tag).toBe(tag);
  });

  it("uses the title as body when there is neither body nor link", async () => {
    const d = deps();
    const { url: _url, ...rest } = notification;
    await appriseSender.send({ ...rest, body: "" }, stateful({ format: "markdown" }), d);
    expect(call(d).body).toMatchObject({ body: "CTO failed", format: "markdown" });
  });

  it("rejects a key apprise-api would not accept, without echoing it", async () => {
    const d = deps();
    d.resolveSecret.mockResolvedValue("not a/valid key");
    const result = await appriseSender.send(notification, stateful(), d);
    expect(result).toEqual({
      ok: false,
      retryable: false,
      error: "configKey is not a valid apprise-api key (1-128 letters, digits, - or _)",
    });
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("sends Basic auth and extra headers", async () => {
    const d = deps();
    await appriseSender.send(
      notification,
      stateful({
        auth: { mode: "basic", username: "bot", password: secret("pw") },
        extraHeaders: [{ name: "X-Apprise-Config-ID", value: secret("cfg") }],
      }),
      d,
    );
    expect(call(d).headers).toEqual({
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from("bot:hunter2").toString("base64")}`,
      "X-Apprise-Config-ID": "cfg-id",
    });
  });
});

describe("stateless mode", () => {
  it("sends only to destinations at or above their minimum severity", async () => {
    const d = deps();
    const config = stateless([
      { url: secret("tg"), minSeverity: "high" },
      { url: secret("mail"), minSeverity: "urgent" },
    ]);
    await appriseSender.send(notification, config, d);
    expect(d.fetch).toHaveBeenCalledTimes(1);
    expect(call(d)).toMatchObject({
      url: "http://apprise:8000/notify/",
      body: {
        urls: ["tgram://bottoken/12345"],
        title: "CTO failed",
        body: "exit 1\n\nhttps://pc.example.com/PAP/agents/ag-1/runs/run-1",
        type: "failure",
        format: "text",
      },
    });
    expect(call(d).body).not.toHaveProperty("tag");
    expect(d.resolveSecret).not.toHaveBeenCalledWith(secret("mail"), expect.anything());
  });

  it("gives ntfy destinations priority, tags and click, without the link in the body", async () => {
    const d = deps();
    const config = stateless([
      { url: secret("tg") },
      { url: secret("ntfy") },
      { url: secret("ntfyq") },
    ]);
    await appriseSender.send(notification, config, d);
    expect(d.fetch).toHaveBeenCalledTimes(2);
    const ntfyCall = call(d, 0);
    expect(ntfyCall.body.body).toBe("exit 1");
    expect(ntfyCall.body.urls).toEqual([
      "ntfys://tk_secret@ntfy.example.com/alerts?priority=high&tags=rotating_light%2Crun&click=https%3A%2F%2Fpc.example.com%2FPAP%2Fagents%2Fag-1%2Fruns%2Frun-1",
      "ntfy://ntfy.example.com/alerts?priority=min&tags=rotating_light%2Crun&click=https%3A%2F%2Fpc.example.com%2FPAP%2Fagents%2Fag-1%2Fruns%2Frun-1",
    ]);
    const otherCall = call(d, 1);
    expect(otherCall.body.urls).toEqual(["tgram://bottoken/12345"]);
    expect(otherCall.body.body).toContain("https://pc.example.com/PAP/agents/ag-1/runs/run-1");
  });

  it("maps urgent to max priority on ntfy destinations", async () => {
    const d = deps();
    await appriseSender.send(
      { ...notification, severity: "urgent" },
      stateless([{ url: secret("ntfy") }]),
      d,
    );
    expect((call(d).body.urls as string[])[0]).toContain("priority=max");
  });

  it("does nothing when no destination wants this severity", async () => {
    const d = deps();
    const config = stateless([{ url: secret("tg"), minSeverity: "urgent" }]);
    expect(await appriseSender.send(notification, config, d)).toEqual({ ok: true });
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("resolves destination secrets with the host config path", async () => {
    const d = deps();
    await appriseSender.send(
      notification,
      stateless([{ url: secret("mail") }, { url: secret("tg") }]),
      d,
    );
    expect(d.resolveSecret).toHaveBeenCalledWith(secret("tg"), "destinations.1.url");
  });

  it("reports the first failure without any destination URL", async () => {
    const d = deps([
      new Response("", { status: 200 }),
      new Response("tgram://bottoken failed", { status: 424 }),
    ]);
    const config = stateless([{ url: secret("ntfy") }, { url: secret("tg") }]);
    const result = await appriseSender.send(notification, config, d);
    expect(result).toEqual({
      ok: false,
      retryable: false,
      error: "partially delivered: apprise-api: a destination failed or no tag matched (HTTP 424)",
    });
  });
});

describe("responses", () => {
  it.each([
    [204, false, "apprise-api: no saved configuration for this key (HTTP 204)"],
    [400, false, "apprise-api rejected the request (HTTP 400)"],
    [401, false, "apprise-api: authentication failed (HTTP 401)"],
    [403, false, "apprise-api: access denied (HTTP 403)"],
    [404, false, "apprise-api: not found, check apiUrl (HTTP 404)"],
    [424, false, "apprise-api: a destination failed or no tag matched (HTTP 424)"],
    [500, true, "apprise-api unavailable (HTTP 500)"],
    [503, true, "apprise-api unavailable (HTTP 503)"],
  ])("maps HTTP %i", async (status, retryable, error) => {
    const d = deps([new Response(status === 204 ? null : "secret echo", { status })]);
    expect(await appriseSender.send(notification, stateful(), d)).toEqual({
      ok: false,
      retryable,
      error,
    });
  });

  it("honours Retry-After on 429", async () => {
    const d = deps([new Response("", { status: 429, headers: { "Retry-After": "60" } })]);
    expect(await appriseSender.send(notification, stateful(), d)).toEqual({
      ok: false,
      retryable: true,
      error: "apprise-api rate limited the request (HTTP 429)",
      retryAfterMs: 60_000,
    });
  });

  it("treats network errors as retryable", async () => {
    const result = await appriseSender.send(
      notification,
      stateful(),
      deps([new TypeError("fetch failed")]),
    );
    expect(result).toMatchObject({ ok: false, retryable: true });
  });

  it("fails permanently on a secret that cannot be resolved", async () => {
    const d = deps();
    d.resolveSecret.mockRejectedValue(
      new SecretResolutionError("configKey", new Error("Secret not found")),
    );
    expect(await appriseSender.send(notification, stateful(), d)).toEqual({
      ok: false,
      retryable: false,
      error: "secret resolution failed (configKey): secret not found or deleted",
    });
  });
});

describe("sendTest", () => {
  it("reaches every stateless destination regardless of minimum severity", async () => {
    const d = deps();
    const config = stateless([{ url: secret("tg"), minSeverity: "urgent" }]);
    expect(await appriseSender.sendTest(config, d)).toEqual({ ok: true });
    expect(call(d).body).toMatchObject({
      urls: ["tgram://bottoken/12345"],
      title: "Paperclip test notification",
      type: "success",
    });
  });

  it("uses the normal tag in stateful mode", async () => {
    const d = deps();
    await appriseSender.sendTest(stateful(), d);
    expect(call(d).body.tag).toBe("info");
  });
});

describe("stateless partial outcomes", () => {
  const both = () => stateless([{ url: secret("ntfy") }, { url: secret("tg") }]);

  it("does not retry (and duplicate) when one batch was delivered", async () => {
    const d = deps([new Response("", { status: 200 }), new Response("", { status: 503 })]);
    const result = await appriseSender.send(notification, both(), d);
    expect(result).toEqual({
      ok: false,
      retryable: false,
      error: "partially delivered: apprise-api unavailable (HTTP 503)",
    });
  });

  it("keeps the retryable failure when nothing was delivered", async () => {
    const d = deps([new Response("", { status: 424 }), new Response("", { status: 503 })]);
    expect(await appriseSender.send(notification, both(), d)).toMatchObject({
      ok: false,
      retryable: true,
    });
  });

  it("still sends the second batch when the first throws", async () => {
    const d = deps([new TypeError("fetch failed"), new Response("", { status: 200 })]);
    const result = await appriseSender.send(notification, both(), d);
    expect(d.fetch).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(result.ok || result.error).toMatch(/^partially delivered: network error/);
  });
});

describe("ntfy URL parameters review fixes", () => {
  it("treats xtags as tags already set", async () => {
    const d = deps();
    SECRETS.ntfyx = "ntfys://ntfy.example.com/alerts?xtags=mine";
    await appriseSender.send(notification, stateless([{ url: secret("ntfyx") }]), d);
    const url = (call(d).body.urls as string[])[0] ?? "";
    expect(url).not.toMatch(/[?&]tags=/);
    expect(url).toContain("xtags=mine");
  });

  it("explains a 204 in stateful mode as a missing configuration", async () => {
    const d = deps([new Response(null, { status: 204 })]);
    expect(await appriseSender.send(notification, stateful(), d)).toEqual({
      ok: false,
      retryable: false,
      error: "apprise-api: no saved configuration for this key (HTTP 204)",
    });
  });
});

describe("stateless 204", () => {
  it("means no valid destinations", async () => {
    const d = deps([new Response(null, { status: 204 })]);
    expect(await appriseSender.send(notification, stateless([{ url: secret("tg") }]), d)).toEqual({
      ok: false,
      retryable: false,
      error: "apprise-api: no valid destinations (HTTP 204)",
    });
  });
});

describe("backlog fixes (apprise sender)", () => {
  it("inserts ntfy parameters before a fragment", async () => {
    const d = deps();
    SECRETS.ntfyf = "ntfys://ntfy.example.com/alerts#note";
    const { url: _url, ...rest } = notification;
    await appriseSender.send(rest, stateless([{ url: secret("ntfyf") }]), d);
    expect((call(d).body.urls as string[])[0]).toBe(
      "ntfys://ntfy.example.com/alerts?priority=high&tags=rotating_light%2Crun#note",
    );
  });

  it("keeps one ntfy tag per notification tag even when a tag has a comma", async () => {
    const d = deps();
    const { url: _url, ...rest } = notification;
    await appriseSender.send({ ...rest, tags: ["a,b"] }, stateless([{ url: secret("ntfy") }]), d);
    expect((call(d).body.urls as string[])[0]).toContain("tags=rotating_light%2Ca_b");
  });

  it("explains a 404 as a wrong apiUrl", async () => {
    const d = deps([new Response("", { status: 404 })]);
    expect(await appriseSender.send(notification, stateful(), d)).toEqual({
      ok: false,
      retryable: false,
      error: "apprise-api: not found, check apiUrl (HTTP 404)",
    });
  });
});
