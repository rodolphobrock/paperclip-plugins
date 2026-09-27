import type { Notification, SenderDeps } from "@paperclip-plugins/notify-core";
import { describe, expect, it } from "vitest";
import { parseNtfyConfig } from "../../src/config.js";
import { ntfySender } from "../../src/sender.js";

/** Real ntfy server, e.g. from examples/notify/docker-compose.yml. */
const NTFY_URL = process.env.NTFY_URL;

const deps: SenderDeps = {
  fetch: (url, init) => fetch(url, init),
  resolveSecret: async () => "unused",
  logger: { info() {}, warn() {}, error() {}, debug() {} },
};

interface NtfyMessage {
  event: string;
  title?: string;
  message: string;
  priority?: number;
  tags?: string[];
  click?: string;
}

async function received(topic: string): Promise<NtfyMessage[]> {
  const res = await fetch(`${NTFY_URL}/${topic}/json?poll=1`);
  const text = await res.text();
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as NtfyMessage)
    .filter((m) => m.event === "message");
}

describe.skipIf(!NTFY_URL)("ntfy integration", () => {
  it("delivers title, body, priority, tags and click link, with UTF-8 intact", async () => {
    const topic = `paperclip-it-${Date.now()}`;
    const config = parseNtfyConfig({ serverUrl: NTFY_URL, topic });
    const notification: Notification = {
      key: "it",
      companyId: "co",
      eventType: "agent.run.failed",
      severity: "high",
      tone: "failure",
      title: "Execução do CTO falhou ✗",
      body: "exit 1",
      url: "https://pc.example.com/PAP/agents/ag-1/runs/run-1",
      tags: ["run", "agent:CTO"],
      occurredAt: new Date().toISOString(),
    };

    expect(await ntfySender.send(notification, config, deps)).toEqual({ ok: true });

    const [message] = await received(topic);
    expect(message).toMatchObject({
      title: "Execução do CTO falhou ✗",
      message: "exit 1",
      priority: 4,
      tags: ["rotating_light", "run", "agent:CTO"],
      click: "https://pc.example.com/PAP/agents/ag-1/runs/run-1",
    });
  });

  it("sends the test notification", async () => {
    const topic = `paperclip-it-test-${Date.now()}`;
    expect(
      await ntfySender.sendTest(parseNtfyConfig({ serverUrl: NTFY_URL, topic }), deps),
    ).toEqual({
      ok: true,
    });
    expect((await received(topic))[0]?.title).toBe("Paperclip test notification");
  });
});
