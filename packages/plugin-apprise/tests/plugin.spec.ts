import type { Agent, Company } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import pkg from "../package.json" with { type: "json" };
import { appriseConfigSchema } from "../src/config.js";
import manifest from "../src/manifest.js";
import plugin, { notifier } from "../src/worker.js";

const COMPANY = "test-company";
const KEY = { type: "secret_ref", secretId: "key" };

describe("paperclip-plugin-apprise manifest", () => {
  it("uses the package name as id and the package version", () => {
    expect(manifest.id).toBe(pkg.name);
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.apiVersion).toBe(1);
    expect(manifest.entrypoints).toEqual({ worker: "./dist/worker.js", ui: "./dist/ui" });
    expect(manifest).not.toHaveProperty("minimumHostVersion");
  });

  it("declares capabilities, schema, drain job and settings page", () => {
    expect([...manifest.capabilities].sort()).toEqual(
      [
        "activity.log.write",
        "agents.read",
        "approvals.read",
        "companies.read",
        "events.subscribe",
        "http.outbound",
        "instance.settings.register",
        "issues.read",
        "jobs.schedule",
        "metrics.write",
        "plugin.state.read",
        "plugin.state.write",
        "secrets.read-ref",
      ].sort(),
    );
    expect(manifest.instanceConfigSchema).toBe(appriseConfigSchema);
    expect(manifest.jobs?.map((j) => [j.jobKey, j.schedule])).toEqual([
      ["delivery-drain", "*/1 * * * *"],
    ]);
    expect(manifest.ui?.slots).toEqual([
      {
        type: "companySettingsPage",
        id: "apprise-settings",
        displayName: "Apprise",
        exportName: "AppriseSettingsPage",
        routePath: "apprise",
      },
    ]);
  });

  it("exports the settings page named in the manifest", async () => {
    const ui = await import("../src/ui/index.js");
    expect(typeof ui.AppriseSettingsPage).toBe("function");
  });
});

async function start(config: Record<string, unknown>) {
  const harness = createTestHarness({ manifest, config });
  harness.seed({
    companies: [{ id: COMPANY, issuePrefix: "PAP" } as unknown as Company],
    agents: [{ id: "ag-1", companyId: COMPANY, name: "CTO" } as unknown as Agent],
  });
  const fetch = vi.spyOn(harness.ctx.http, "fetch").mockResolvedValue(new Response("{}"));
  vi.spyOn(harness.ctx.secrets, "resolve").mockResolvedValue("abc123");
  await plugin.definition.setup(harness.ctx);
  const emit = harness.emit.bind(harness);
  harness.emit = async (...args: Parameters<typeof harness.emit>) => {
    await emit(...args);
    await notifier.idle();
  };
  return { harness, fetch };
}

const CONFIG = {
  apiUrl: "http://apprise:8000",
  configKey: KEY,
  paperclipBaseUrl: "https://pc.example.com",
};
const RUN_FAILED = [
  "agent.run.failed",
  { runId: "run-1", agentId: "ag-1", status: "failed", error: "exit 1" },
  { entityId: "run-1", entityType: "heartbeat_run" },
] as const;

describe("paperclip-plugin-apprise worker", () => {
  it("notifies apprise-api once per default event, routed by tag", async () => {
    const { harness, fetch } = await start(CONFIG);
    await harness.emit(...RUN_FAILED);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("http://apprise:8000/notify/abc123");
    expect(JSON.parse(String(init?.body))).toEqual({
      title: "CTO failed",
      body: "exit 1\n\nhttps://pc.example.com/PAP/agents/ag-1/runs/run-1",
      type: "failure",
      tag: "alert",
      format: "text",
    });
  });

  it("sends nothing for a company without config", async () => {
    const { harness, fetch } = await start({});
    await harness.emit(...RUN_FAILED);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends once when handlers are registered twice (paperclip#13732)", async () => {
    const { harness, fetch } = await start(CONFIG);
    await plugin.definition.setup(harness.ctx);
    await harness.emit(...RUN_FAILED);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("sends a test notification from the settings page action", async () => {
    const { harness, fetch } = await start(CONFIG);
    expect(await harness.performAction("send-test", {}, { companyId: COMPANY })).toEqual({
      ok: true,
    });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).title).toBe(
      "Paperclip test notification",
    );
  });

  it("validates config without resolving secrets", async () => {
    const validate = plugin.definition.onValidateConfig;
    expect(await validate?.(CONFIG)).toEqual({ ok: true });
    expect(await validate?.({ apiUrl: "http://apprise:8000", mode: "stateless" })).toEqual({
      ok: false,
      errors: ["destinations needs at least one destination in stateless mode"],
    });
  });

  it("serves many companies, reports health, drains on shutdown and handles config changes", async () => {
    expect(plugin.definition.multiCompanyConfig).toBe(true);
    expect((await plugin.definition.onHealth?.())?.status).toBe("ok");
    await expect(plugin.definition.onShutdown?.()).resolves.toBeUndefined();
    await expect(
      plugin.definition.onConfigChanged?.({}, { companyId: COMPANY }),
    ).resolves.toBeUndefined();
  });

  it("registers the drain job", async () => {
    const { harness, fetch } = await start(CONFIG);
    fetch.mockResolvedValueOnce(new Response("", { status: 503 }));
    await harness.emit(...RUN_FAILED);
    await harness.runJob("delivery-drain");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
