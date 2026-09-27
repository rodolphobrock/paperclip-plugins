import type {
  Agent,
  Company,
  Issue,
  PaperclipPluginManifestV1,
  PluginEvent,
} from "@paperclipai/plugin-sdk";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type BaseConfig, parseBaseConfig } from "./config.js";
import { createNotifier } from "./notifier.js";
import type { Notification, NotificationSender, SenderDeps, SendResult } from "./types.js";

const COMPANY = "test-company";
const clock = { now: Date.parse("2026-09-27T12:00:00Z") };

const manifest: PaperclipPluginManifestV1 = {
  id: "notify-core-test",
  apiVersion: 1,
  version: "0.0.0",
  displayName: "Notify core test",
  description: "Test manifest",
  author: "test",
  categories: ["connector"],
  capabilities: [
    "events.subscribe",
    "plugin.state.read",
    "plugin.state.write",
    "companies.read",
    "approvals.read",
    "agents.read",
    "issues.read",
    "http.outbound",
    "secrets.read-ref",
    "metrics.write",
    "jobs.schedule",
    "activity.log.write",
  ],
  entrypoints: { worker: "./dist/worker.js" },
  jobs: [{ jobKey: "delivery-drain", displayName: "Delivery drain", schedule: "*/1 * * * *" }],
};

interface FakeConfig extends BaseConfig {
  token?: unknown;
}

function fakeSender(result: SendResult | (() => Promise<SendResult>) = { ok: true }) {
  const sent: { n: Notification; deps: SenderDeps }[] = [];
  const sender: NotificationSender<FakeConfig> = {
    name: "fake",
    async send(n, _config, deps) {
      sent.push({ n, deps });
      return typeof result === "function" ? result() : result;
    },
    async sendTest() {
      return { ok: true };
    },
  };
  return { sender, sent };
}

function parseFake(raw: unknown): FakeConfig {
  const base = parseBaseConfig(raw);
  const token = (raw as { token?: unknown } | null)?.token;
  return token === undefined ? base : { ...base, token };
}

async function setup(config: Record<string, unknown>, sender = fakeSender()) {
  const harness = createTestHarness({ manifest, config });
  harness.seed({
    companies: [{ id: COMPANY, issuePrefix: "PAP" } as unknown as Company],
    agents: [{ id: "ag-1", companyId: COMPANY, name: "CTO" } as unknown as Agent],
    issues: [
      {
        id: "is-1",
        companyId: COMPANY,
        projectId: "pr-1",
        title: "Fix login",
        identifier: "PAP-1",
        assigneeAgentId: "ag-1",
      } as unknown as Issue,
    ],
  });
  const notifier = createNotifier({
    sender: sender.sender,
    parseConfig: parseFake,
    clock: () => clock.now,
  });
  await notifier.setup(harness.ctx);
  // Event handlers return before delivery finishes; wait for it in tests.
  const emit = harness.emit.bind(harness);
  harness.emit = async (...args: Parameters<TestHarness["emit"]>) => {
    await emit(...args);
    await notifier.idle();
  };
  return { harness, notifier, ...sender };
}

const CONFIGURED = { paperclipBaseUrl: "https://pc.example.com" };

const runFailed = (extra: Partial<PluginEvent> = {}) =>
  [
    "agent.run.failed",
    { runId: "run-1", agentId: "ag-1", status: "failed", error: "exit 1" },
    { entityId: "run-1", entityType: "heartbeat_run", ...extra },
  ] as const;

const metricNames = (harness: TestHarness) => harness.metrics.map((m) => m.name);

afterEach(() => {
  vi.unstubAllGlobals();
  clock.now = Date.parse("2026-09-27T12:00:00Z");
});

describe("createNotifier", () => {
  it("sends one notification for a default event with title, severity and link", async () => {
    const { harness, sent } = await setup(CONFIGURED);
    await harness.emit(...runFailed());

    expect(sent).toHaveLength(1);
    expect(sent[0]?.n).toMatchObject({
      companyId: COMPANY,
      eventType: "agent.run.failed",
      severity: "high",
      tone: "failure",
      title: "CTO failed",
      url: "https://pc.example.com/PAP/agents/ag-1/runs/run-1",
      key: "agent.run.failed:run-1:failed",
    });
    expect(metricNames(harness)).toContain("notify.sent");
  });

  it("delivers once when handlers are registered twice (paperclip#13732)", async () => {
    const { harness, notifier, sent } = await setup(CONFIGURED);
    await notifier.setup(harness.ctx);
    await harness.emit(...runFailed());
    expect(sent).toHaveLength(1);
    expect(metricNames(harness)).toContain("notify.deduped");
  });

  it("delivers once when the same fact arrives with a new eventId", async () => {
    const { harness, sent } = await setup(CONFIGURED);
    await harness.emit(...runFailed({ eventId: "e-1" }));
    await harness.emit(...runFailed({ eventId: "e-2" }));
    expect(sent).toHaveLength(1);
  });

  it("does nothing for a company without config", async () => {
    const { harness, sent } = await setup({});
    await harness.emit(...runFailed());
    expect(sent).toHaveLength(0);
    expect(
      harness.getState({
        scopeKind: "company",
        scopeId: COMPANY,
        namespace: "notify",
        stateKey: "dedupe",
      }),
    ).toBeUndefined();
  });

  it("does nothing when disabled", async () => {
    const { harness, sent } = await setup({ ...CONFIGURED, enabled: false });
    await harness.emit(...runFailed());
    expect(sent).toHaveLength(0);
  });

  it("warns once about invalid config and sends nothing", async () => {
    const { harness, sent } = await setup({ minSeverity: "loud" });
    await harness.emit(...runFailed({ eventId: "e-1" }));
    await harness.emit(...runFailed({ eventId: "e-2", entityId: "run-2" }));
    expect(sent).toHaveLength(0);
    expect(harness.logs.filter((l) => l.message === "notify.invalid_config")).toHaveLength(1);
  });

  it("suppresses events the policy rejects", async () => {
    const { harness, sent } = await setup({ ...CONFIGURED, minSeverity: "urgent" });
    await harness.emit(...runFailed());
    expect(sent).toHaveLength(0);
    expect(harness.metrics).toContainEqual(
      expect.objectContaining({
        name: "notify.suppressed",
        tags: expect.objectContaining({ reason: "severity" }),
      }),
    );
  });

  it("ignores events the mapper drops", async () => {
    const { harness, sent } = await setup(CONFIGURED);
    await harness.emit("issue.updated", { status: "in_progress" }, { entityId: "is-1" });
    expect(sent).toHaveLength(0);
  });

  it("sends without a link and warns once when the base URL is missing", async () => {
    const { harness, sent } = await setup({ enabled: true });
    await harness.emit(...runFailed({ eventId: "e-1" }));
    await harness.emit(...runFailed({ eventId: "e-2", entityId: "run-2" }));
    expect(sent[0]?.n.url).toBeUndefined();
    expect(harness.logs.filter((l) => l.message === "notify.missing_base_url")).toHaveLength(1);
  });

  it("sends without a link when the company prefix cannot be loaded", async () => {
    const { harness, sent } = await setup(CONFIGURED);
    vi.spyOn(harness.ctx.companies, "get").mockRejectedValue(new Error("down"));
    await harness.emit(...runFailed());
    expect(sent).toHaveLength(1);
    expect(sent[0]?.n.url).toBeUndefined();
  });

  it("still sends when enrichment fails", async () => {
    const { harness, sent } = await setup(CONFIGURED);
    vi.spyOn(harness.ctx.agents, "get").mockRejectedValue(new Error("down"));
    await harness.emit(...runFailed());
    expect(sent[0]?.n.title).toBe("Agent failed");
    expect(harness.logs.some((l) => l.message === "notify.enrich_failed")).toBe(true);
  });

  it("uses the issue to filter by project", async () => {
    const { harness, sent } = await setup({ ...CONFIGURED, filters: { projectIds: ["pr-1"] } });
    await harness.emit(
      "issue.updated",
      { status: "blocked", identifier: "PAP-1" },
      { entityId: "is-1", entityType: "issue" },
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.n.url).toBe("https://pc.example.com/PAP/issues/PAP-1");
  });

  it("records failures from the sender", async () => {
    const { harness } = await setup(
      CONFIGURED,
      fakeSender({ ok: false, retryable: false, error: "HTTP 401" }),
    );
    await harness.emit(...runFailed());
    expect(metricNames(harness)).toContain("notify.failed");
    expect(harness.logs).toContainEqual(
      expect.objectContaining({ level: "error", message: "notify.failed" }),
    );
  });

  it("treats a throwing sender as a retryable failure", async () => {
    const { harness } = await setup(
      CONFIGURED,
      fakeSender(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await harness.emit(...runFailed());
    expect(harness.logs).toContainEqual(expect.objectContaining({ message: "notify.retry" }));
  });

  it("uses the host fetch by default", async () => {
    const { harness, sent } = await setup(CONFIGURED);
    const hostFetch = vi.spyOn(harness.ctx.http, "fetch").mockResolvedValue(new Response("ok"));
    await harness.emit(...runFailed());
    await sent[0]?.deps.fetch("https://ntfy.example.com/topic", { method: "POST" });
    expect(hostFetch).toHaveBeenCalledWith("https://ntfy.example.com/topic", { method: "POST" });
  });

  it("uses the global fetch with a timeout when private networks are allowed", async () => {
    const globalFetch = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", globalFetch);
    const { harness, sent } = await setup({
      ...CONFIGURED,
      network: { allowPrivateNetwork: true },
    });
    const hostFetch = vi.spyOn(harness.ctx.http, "fetch");
    await harness.emit(...runFailed());
    await sent[0]?.deps.fetch("http://10.0.0.5/topic", { method: "POST" });
    expect(hostFetch).not.toHaveBeenCalled();
    expect(globalFetch).toHaveBeenCalledWith(
      "http://10.0.0.5/topic",
      expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) }),
    );
  });

  it("caches resolved secrets per company", async () => {
    const { harness, sent } = await setup(CONFIGURED);
    const resolve = vi.spyOn(harness.ctx.secrets, "resolve").mockResolvedValue("s3cret");
    await harness.emit(...runFailed());
    const ref = { type: "secret_ref", secretId: "sec-1" } as const;
    const deps = sent[0]?.deps;
    expect(await deps?.resolveSecret(ref, "token")).toBe("s3cret");
    expect(await deps?.resolveSecret(ref, "token")).toBe("s3cret");
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(ref, { companyId: COMPANY, configPath: "token" });
  });
});

describe("createNotifier review fixes", () => {
  it("wraps secret failures so they are not retried", async () => {
    const { harness, sent } = await setup(CONFIGURED);
    vi.spyOn(harness.ctx.secrets, "resolve").mockRejectedValue(new Error("rate limited: sk-abc"));
    await harness.emit(...runFailed());
    const ref = { type: "secret_ref", secretId: "sec-1" } as const;
    const attempt = sent[0]?.deps.resolveSecret(ref, "auth.token");
    await expect(attempt).rejects.toMatchObject({
      name: "SecretResolutionError",
      configPath: "auth.token",
    });
  });

  it("keeps budget alerts when an agent filter is set", async () => {
    const { harness, sent } = await setup({ ...CONFIGURED, filters: { agentIds: ["ag-1"] } });
    await harness.emit(
      "budget.incident.opened",
      {
        scopeType: "company",
        scopeId: COMPANY,
        amountObserved: 1,
        amountLimit: 1,
        approvalId: null,
      },
      { entityId: "inc-1" },
    );
    expect(sent).toHaveLength(1);
  });
});

describe("send-test action and status data", () => {
  it("sends a test with the company secrets and records status", async () => {
    const { harness, sender } = await setup(CONFIGURED);
    const sendTest = vi.spyOn(sender, "sendTest");
    const result = await harness.performAction("send-test", {}, { companyId: COMPANY });
    expect(result).toEqual({ ok: true });
    expect(sendTest).toHaveBeenCalledTimes(1);

    const status = await harness.getData<Record<string, unknown>>("status", { companyId: COMPANY });
    expect(status).toMatchObject({
      configured: true,
      enabled: true,
      lastSentAt: expect.any(String),
    });
    expect(status).not.toHaveProperty("lastError");
  });

  it("works even when notifications are disabled", async () => {
    const { harness } = await setup({ ...CONFIGURED, enabled: false });
    expect(await harness.performAction("send-test", {}, { companyId: COMPANY })).toEqual({
      ok: true,
    });
  });

  it("reports an unconfigured company", async () => {
    const { harness } = await setup({});
    expect(await harness.performAction("send-test", {}, { companyId: COMPANY })).toEqual({
      ok: false,
      error: "Not configured for this company",
    });
    expect(await harness.getData("status", { companyId: COMPANY })).toEqual({
      configured: false,
      enabled: false,
    });
  });

  it("reports invalid config", async () => {
    const { harness } = await setup({ minSeverity: "loud" });
    const result = await harness.performAction<{ ok: boolean; error: string }>(
      "send-test",
      {},
      { companyId: COMPANY },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/minSeverity/);
  });

  it("requires a company", async () => {
    const { harness } = await setup(CONFIGURED);
    expect(await harness.performAction("send-test", {})).toEqual({
      ok: false,
      error: "Missing company",
    });
    expect(await harness.getData("status", {})).toEqual({ configured: false, enabled: false });
  });

  it("records the last error without secrets", async () => {
    const failing = fakeSender({ ok: false, retryable: false, error: "HTTP 401: token=abc123" });
    const { harness } = await setup(CONFIGURED, failing);
    failing.sender.sendTest = async () => ({ ok: false, retryable: false, error: "HTTP 401" });
    await harness.emit(...runFailed());
    const status = await harness.getData<{ lastError?: { message: string } }>("status", {
      companyId: COMPANY,
    });
    expect(status.lastError?.message).toContain("HTTP 401");
    expect(status.lastError?.message).not.toContain("abc123");

    const result = await harness.performAction("send-test", {}, { companyId: COMPANY });
    expect(result).toEqual({ ok: false, error: "HTTP 401" });
  });
});

describe("validateConfig", () => {
  it("reports parse problems for onValidateConfig", async () => {
    const { validateConfig } = await import("./notifier.js");
    expect(await validateConfig(parseFake, CONFIGURED)).toEqual({ ok: true });
    expect(await validateConfig(parseFake, { minSeverity: "loud" })).toEqual({
      ok: false,
      errors: [expect.stringMatching(/minSeverity/)],
    });
  });
});

describe("delivery pipeline", () => {
  const MIN = 60_000;
  const drain = (harness: TestHarness) => harness.runJob("delivery-drain");

  it("returns from the event handler before delivery finishes", async () => {
    let release: (value: SendResult) => void = () => {};
    const slow = fakeSender(() => new Promise<SendResult>((resolve) => (release = resolve)));
    const harness = createTestHarness({ manifest, config: CONFIGURED });
    harness.seed({ companies: [{ id: COMPANY, issuePrefix: "PAP" } as unknown as Company] });
    const notifier = createNotifier({ sender: slow.sender, parseConfig: parseFake });
    await notifier.setup(harness.ctx);

    await harness.emit(...runFailed());
    expect(slow.sent).toHaveLength(0);
    await vi.waitFor(() => expect(slow.sent).toHaveLength(1));
    release({ ok: true });
    await notifier.idle();
    expect(metricNames(harness)).toContain("notify.sent");
  });

  it("retries through the drain job until the server is back (criterion 7)", async () => {
    const results: SendResult[] = [{ ok: false, retryable: true, error: "HTTP 503" }];
    const { harness, notifier, sent } = await setup(
      CONFIGURED,
      fakeSender(async () => results.shift() ?? { ok: true }),
    );
    await harness.emit(...runFailed());
    expect(metricNames(harness)).toContain("notify.retry");
    expect((await notifier.health()).status).toBe("degraded");

    clock.now += 31_000;
    await drain(harness);
    expect(sent).toHaveLength(2);
    expect(metricNames(harness)).toContain("notify.sent");
    const status = await harness.getData<{ lastSentAt?: string }>("status", { companyId: COMPANY });
    expect(status.lastSentAt).toBe(new Date(clock.now).toISOString());

    clock.now += 6 * MIN;
    expect((await notifier.health()).status).toBe("ok");
  });

  it("drops after maxAgeMinutes into the activity log", async () => {
    const { harness } = await setup(
      { ...CONFIGURED, retry: { maxAgeMinutes: 1 } },
      fakeSender({ ok: false, retryable: true, error: "HTTP 503" }),
    );
    await harness.emit(...runFailed());
    clock.now += 2 * MIN;
    await drain(harness);
    expect(harness.metrics).toContainEqual(
      expect.objectContaining({
        name: "notify.dropped",
        tags: expect.objectContaining({ reason: "expired" }),
      }),
    );
    expect(harness.activity).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("CTO failed") }),
    );
  });

  it("holds events in quiet hours and sends one digest when they end (criterion 6)", async () => {
    const quiet = { ...CONFIGURED, quietHours: { enabled: true, start: "11:00", end: "13:00" } };
    const { harness, sent } = await setup(quiet);
    await harness.emit(...runFailed({ eventId: "e1" }));
    await harness.emit(...runFailed({ eventId: "e2", entityId: "run-2" }));
    expect(sent).toHaveLength(0);
    expect(harness.metrics.filter((m) => m.name === "notify.queued")).toHaveLength(2);

    clock.now = Date.parse("2026-09-27T13:00:00Z");
    await drain(harness);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.n).toMatchObject({
      title: "2 notifications since 12:00",
      url: "https://pc.example.com/PAP/inbox",
    });
    expect(harness.metrics).toContainEqual(
      expect.objectContaining({ name: "notify.digested", value: 2 }),
    );
  });

  it("reports health and clears warnings on config change", async () => {
    const { harness, notifier } = await setup({ minSeverity: "loud" });
    await harness.emit(...runFailed());
    notifier.configChanged(COMPANY);
    await harness.emit(...runFailed({ eventId: "e-2", entityId: "run-2" }));
    expect(harness.logs.filter((l) => l.message === "notify.invalid_config")).toHaveLength(2);
    expect(await notifier.health()).toEqual({ status: "ok" });
  });
});

describe("delivery review fixes", () => {
  it("keeps every company in the pending index when failures arrive together", async () => {
    const { harness, notifier } = await setup(
      CONFIGURED,
      fakeSender({ ok: false, retryable: true, error: "HTTP 503" }),
    );
    await Promise.all(
      ["co-a", "co-b", "co-c"].map((companyId, i) =>
        harness.emit(
          "agent.run.failed",
          { runId: `r${i}`, agentId: "ag-1", status: "failed" },
          {
            entityId: `r${i}`,
            companyId,
          },
        ),
      ),
    );
    await notifier.idle();
    const pending = harness.getState({
      scopeKind: "instance",
      namespace: "notify",
      stateKey: "pending",
    });
    expect([...(pending as string[])].sort()).toEqual(["co-a", "co-b", "co-c"]);
  });

  it("forgets cached secrets when the config changes", async () => {
    const { harness, notifier, sent } = await setup(CONFIGURED);
    const resolve = vi.spyOn(harness.ctx.secrets, "resolve").mockResolvedValue("old");
    await harness.emit(...runFailed());
    const ref = { type: "secret_ref", secretId: "sec-1" } as const;
    await sent[0]?.deps.resolveSecret(ref, "auth.token");
    notifier.configChanged(COMPANY);
    resolve.mockResolvedValue("new");
    expect(await sent[0]?.deps.resolveSecret(ref, "auth.token")).toBe("new");
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});
