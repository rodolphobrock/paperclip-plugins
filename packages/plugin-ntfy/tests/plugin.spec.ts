import type { Agent, Company } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import pkg from "../package.json" with { type: "json" };
import { ntfyConfigSchema } from "../src/config.js";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

const COMPANY = "test-company";

describe("paperclip-plugin-ntfy manifest", () => {
  it("uses the package name as id and the package version", () => {
    expect(manifest.id).toBe(pkg.name);
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.apiVersion).toBe(1);
    expect(manifest.entrypoints.worker).toBe("./dist/worker.js");
  });

  // The Paperclip server passes hostVersion "0.0.0" to the plugin loader (server/src/app.ts),
  // so any minimumHostVersion makes installation fail on a stock host.
  it("does not declare minimumHostVersion", () => {
    expect(manifest).not.toHaveProperty("minimumHostVersion");
  });

  it("declares the capabilities the notifier uses and the config schema", () => {
    expect([...manifest.capabilities].sort()).toEqual(
      [
        "agents.read",
        "approvals.read",
        "companies.read",
        "events.subscribe",
        "http.outbound",
        "issues.read",
        "metrics.write",
        "plugin.state.read",
        "plugin.state.write",
        "secrets.read-ref",
      ].sort(),
    );
    expect(manifest.instanceConfigSchema).toBe(ntfyConfigSchema);
  });
});

async function start(config: Record<string, unknown>) {
  const harness = createTestHarness({ manifest, config });
  harness.seed({
    companies: [{ id: COMPANY, issuePrefix: "PAP" } as unknown as Company],
    agents: [{ id: "ag-1", companyId: COMPANY, name: "CTO" } as unknown as Agent],
  });
  const fetch = vi.spyOn(harness.ctx.http, "fetch").mockResolvedValue(new Response("{}"));
  await plugin.definition.setup(harness.ctx);
  return { harness, fetch };
}

const CONFIG = { topic: "alerts", paperclipBaseUrl: "https://pc.example.com" };
const RUN_FAILED = [
  "agent.run.failed",
  { runId: "run-1", agentId: "ag-1", status: "failed", error: "exit 1" },
  { entityId: "run-1", entityType: "heartbeat_run" },
] as const;

describe("paperclip-plugin-ntfy worker", () => {
  it("publishes one ntfy message per default event", async () => {
    const { harness, fetch } = await start(CONFIG);
    await harness.emit(...RUN_FAILED);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://ntfy.sh/");
    expect(JSON.parse(String(init?.body))).toEqual({
      topic: "alerts",
      title: "CTO failed",
      message: "exit 1",
      priority: 4,
      tags: ["rotating_light", "run", "agent:CTO"],
      click: "https://pc.example.com/PAP/agents/ag-1/runs/run-1",
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
    const result = await harness.performAction("send-test", {}, { companyId: COMPANY });
    expect(result).toEqual({ ok: true });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).title).toBe(
      "Paperclip test notification",
    );
  });

  it("validates config without resolving secrets", async () => {
    const validate = plugin.definition.onValidateConfig;
    expect(await validate?.({ topic: "alerts" })).toEqual({ ok: true });
    expect(await validate?.({})).toEqual({ ok: false, errors: ["topic is required"] });
  });

  it("reports healthy", async () => {
    expect((await plugin.definition.onHealth?.())?.status).toBe("ok");
  });
});
