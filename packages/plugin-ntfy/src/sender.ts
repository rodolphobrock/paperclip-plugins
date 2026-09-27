import {
  classifyError,
  classifyResponse,
  type Notification,
  type NotificationSender,
  type SenderDeps,
  type SendResult,
  type Severity,
  type Tone,
} from "@paperclip-plugins/notify-core";
import type { NtfyConfig } from "./config.js";

export const PRIORITY_BY_SEVERITY: Readonly<Record<Severity, number>> = {
  low: 2,
  normal: 3,
  high: 4,
  urgent: 5,
};

/** ntfy turns these tags into emoji in front of the title. */
export const TAG_BY_TONE: Readonly<Record<Tone, string>> = {
  info: "information_source",
  success: "white_check_mark",
  warning: "warning",
  failure: "rotating_light",
};

const TEST_NOTIFICATION: Notification = {
  key: "test",
  companyId: "",
  eventType: "activity.logged",
  severity: "normal",
  tone: "success",
  title: "Paperclip test notification",
  body: "If you can read this, the ntfy plugin is configured correctly.",
  tags: ["test"],
  occurredAt: new Date(0).toISOString(),
};

/**
 * Publishes as JSON to the server root (https://docs.ntfy.sh/publish/#publish-as-json),
 * which carries UTF-8 titles without RFC 2047 header encoding.
 */
async function publish(n: Notification, config: NtfyConfig, deps: SenderDeps): Promise<SendResult> {
  try {
    const headers = await buildHeaders(config, deps);
    const body: Record<string, unknown> = {
      topic: config.topicsBySeverity[n.severity] ?? config.topic,
      title: n.title,
      message: n.body || n.title,
      priority: PRIORITY_BY_SEVERITY[n.severity],
      tags: [TAG_BY_TONE[n.tone], ...n.tags],
    };
    if (n.url !== undefined) body.click = n.url;
    if (config.markdown) body.markdown = true;
    if (config.iconUrl !== undefined) body.icon = config.iconUrl;

    const response = await deps.fetch(`${config.serverUrl}/`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return await classifyResponse(response);
  } catch (error) {
    return classifyError(error);
  }
}

async function buildHeaders(config: NtfyConfig, deps: SenderDeps): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  for (const [index, header] of config.extraHeaders.entries()) {
    headers[header.name] = await deps.resolveSecret(header.value, `extraHeaders[${index}].value`);
  }

  const { auth } = config;
  if (auth.mode === "token") {
    headers.Authorization = `Bearer ${await deps.resolveSecret(auth.token, "auth.token")}`;
  } else if (auth.mode === "basic") {
    const password = await deps.resolveSecret(auth.password, "auth.password");
    headers.Authorization = `Basic ${Buffer.from(`${auth.username}:${password}`).toString("base64")}`;
  }
  return headers;
}

export const ntfySender: NotificationSender<NtfyConfig> = {
  name: "ntfy",
  send: publish,
  sendTest: (config, deps) => publish(TEST_NOTIFICATION, config, deps),
};
