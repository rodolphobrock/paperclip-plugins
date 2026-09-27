import type { Notification, SecretRef, SenderDeps } from "@paperclip-plugins/notify-core";
import { describe, expect, it } from "vitest";
import { parseAppriseConfig } from "../../src/config.js";
import { appriseSender } from "../../src/sender.js";

/**
 * Real apprise-api and ntfy, e.g. from examples/notify/docker-compose.yml. apprise-api reaches
 * ntfy at NTFY_INTERNAL (the compose service name); the test reads messages at NTFY_URL.
 */
const APPRISE_URL = process.env.APPRISE_URL;
const NTFY_URL = process.env.NTFY_URL;
const NTFY_INTERNAL = process.env.NTFY_INTERNAL ?? "ntfy";

const secret = (id: string): SecretRef => ({ type: "secret_ref", secretId: id });

function deps(secrets: Record<string, string>): SenderDeps {
  return {
    fetch: (url, init) => fetch(url, init),
    resolveSecret: async (ref) => secrets[ref.secretId] ?? "",
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  };
}

const notification = (severity: Notification["severity"]): Notification => ({
  key: "it",
  companyId: "co",
  eventType: "agent.run.failed",
  severity,
  tone: "failure",
  title: "CTO failed",
  body: "exit 1",
  url: "https://pc.example.com/PAP/agents/ag-1/runs/run-1",
  tags: ["run"],
  occurredAt: new Date().toISOString(),
});

async function received(
  topic: string,
): Promise<{ title?: string; message: string; priority?: number; click?: string }[]> {
  // apprise-api delivers asynchronously relative to our read; poll briefly.
  for (let i = 0; i < 20; i++) {
    const text = await (await fetch(`${NTFY_URL}/${topic}/json?poll=1`)).text();
    const messages = text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((m) => m.event === "message");
    if (messages.length > 0) return messages;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return [];
}

describe.skipIf(!APPRISE_URL || !NTFY_URL)("apprise-api integration", () => {
  it("stateless: delivers to an ntfy destination with priority and click", async () => {
    const topic = `paperclip-apprise-${Date.now()}`;
    const config = parseAppriseConfig({
      apiUrl: APPRISE_URL,
      mode: "stateless",
      destinations: [{ url: secret("dest") }],
    });
    const result = await appriseSender.send(
      notification("high"),
      config,
      deps({ dest: `ntfy://${NTFY_INTERNAL}/${topic}` }),
    );
    expect(result).toEqual({ ok: true });
    const [message] = await received(topic);
    expect(message).toMatchObject({
      title: "CTO failed",
      message: "exit 1",
      priority: 4,
      click: "https://pc.example.com/PAP/agents/ag-1/runs/run-1",
    });
  });

  it("stateful: routes by severity tag and reports when no tag matches", async () => {
    const topic = `paperclip-apprise-key-${Date.now()}`;
    const key = `paperclip${Date.now()}`;
    const add = await fetch(`${APPRISE_URL}/add/${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: `alert=ntfy://${NTFY_INTERNAL}/${topic}`, format: "text" }),
    });
    expect(add.ok).toBe(true);

    const config = parseAppriseConfig({ apiUrl: APPRISE_URL, configKey: secret("key") });
    const d = deps({ key });
    expect(await appriseSender.send(notification("high"), config, d)).toEqual({ ok: true });
    expect((await received(topic))[0]).toMatchObject({ title: "CTO failed" });

    // "low" maps to the "info" tag, which this configuration does not define.
    expect(await appriseSender.send(notification("low"), config, d)).toMatchObject({
      ok: false,
      retryable: false,
    });
  });
});
