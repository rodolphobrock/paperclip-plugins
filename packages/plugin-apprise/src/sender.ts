import {
  basicAuthHeader,
  classifyError,
  compareSeverity,
  type Notification,
  type NotificationSender,
  parseRetryAfter,
  resolveExtraHeaders,
  type SenderDeps,
  type SendResult,
  type Severity,
  type Tone,
} from "@paperclip-plugins/notify-core";
import type { AppriseConfig } from "./config.js";

/** apprise-api keys: 1-128 characters (https://github.com/caronc/apprise-api). */
const KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Apprise's ntfy URL parameters (https://appriseit.com/services/ntfy/). */
const NTFY_PRIORITY: Readonly<Record<Severity, string>> = {
  low: "low",
  normal: "default",
  high: "high",
  urgent: "max",
};

const NTFY_TAG_BY_TONE: Readonly<Record<Tone, string>> = {
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
  body: "If you can read this, the Apprise plugin is configured correctly.",
  tags: ["test"],
  occurredAt: new Date(0).toISOString(),
};

/**
 * Fixed messages per status. The response body is never used: apprise-api may echo
 * destination URLs, which carry credentials.
 */
const STATUS_ERRORS: Readonly<Record<number, string>> = {
  204: "apprise-api: no valid destinations",
  400: "apprise-api rejected the request",
  401: "apprise-api: authentication failed",
  403: "apprise-api: access denied",
  404: "apprise-api: configuration key not found",
  // A destination failed or no tag matched; resending would duplicate on the others.
  424: "apprise-api: a destination failed or no tag matched",
  429: "apprise-api rate limited the request",
};

function classifyAppriseResponse(res: Response): SendResult {
  if (res.status === 200 || res.status === 201) return { ok: true };
  const retryable = res.status === 429 || res.status >= 500;
  const base =
    STATUS_ERRORS[res.status] ?? (retryable ? "apprise-api unavailable" : "apprise-api error");
  const error = `${base} (HTTP ${res.status})`;
  if (!retryable) return { ok: false, retryable: false, error };
  const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"), Date.now());
  return retryAfterMs === undefined
    ? { ok: false, retryable: true, error }
    : { ok: false, retryable: true, error, retryAfterMs };
}

function bodyWithLink(n: Notification): string {
  const parts = [n.body, n.url].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join("\n\n") : n.title;
}

function isNtfyUrl(url: string): boolean {
  return /^ntfys?:\/\//i.test(url);
}

/** Adds priority, tags and click to an Apprise ntfy URL, keeping any the operator already set. */
function withNtfyParams(url: string, n: Notification): string {
  const params: [string, string][] = [
    ["priority", NTFY_PRIORITY[n.severity]],
    ["tags", [NTFY_TAG_BY_TONE[n.tone], ...n.tags].join(",")],
  ];
  if (n.url !== undefined) params.push(["click", n.url]);
  const present = (name: string) => new RegExp(`[?&]${name}=`, "i").test(url);
  const added = params
    .filter(([name]) => !present(name))
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`);
  if (added.length === 0) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${added.join("&")}`;
}

async function buildHeaders(
  config: AppriseConfig,
  deps: SenderDeps,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.auth.mode === "basic") {
    const password = await deps.resolveSecret(config.auth.password, "auth.password");
    headers.Authorization = basicAuthHeader(config.auth.username, password);
  }
  Object.assign(headers, await resolveExtraHeaders(config.extraHeaders, deps));
  return headers;
}

async function post(
  url: string,
  payload: object,
  headers: Record<string, string>,
  deps: SenderDeps,
) {
  const response = await deps.fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  return classifyAppriseResponse(response);
}

async function sendStateful(n: Notification, config: AppriseConfig, deps: SenderDeps) {
  if (config.configKey === undefined) {
    return { ok: false, retryable: false, error: "configKey is not configured" } as const;
  }
  const key = await deps.resolveSecret(config.configKey, "configKey");
  if (!KEY_PATTERN.test(key)) {
    return {
      ok: false,
      retryable: false,
      error: "configKey is not a valid apprise-api key (1-128 letters, digits, - or _)",
    } as const;
  }
  const payload = {
    title: n.title,
    body: bodyWithLink(n),
    type: n.tone,
    tag: config.tagsBySeverity[n.severity],
    format: config.format,
  };
  return post(`${config.apiUrl}/notify/${key}`, payload, await buildHeaders(config, deps), deps);
}

async function sendStateless(
  n: Notification,
  config: AppriseConfig,
  deps: SenderDeps,
  ignoreMinSeverity: boolean,
): Promise<SendResult> {
  const ntfyUrls: string[] = [];
  const otherUrls: string[] = [];
  for (const [index, destination] of config.destinations.entries()) {
    if (!ignoreMinSeverity && compareSeverity(n.severity, destination.minSeverity) < 0) continue;
    const url = await deps.resolveSecret(destination.url, `destinations.${index}.url`);
    if (isNtfyUrl(url)) ntfyUrls.push(withNtfyParams(url, n));
    else otherUrls.push(url);
  }
  if (ntfyUrls.length === 0 && otherUrls.length === 0) return { ok: true };

  const headers = await buildHeaders(config, deps);
  const common = { title: n.title, type: n.tone, format: config.format };
  const batches: { urls: string[]; body: string }[] = [
    { urls: ntfyUrls, body: n.body || n.title }, // the link travels as click
    { urls: otherUrls, body: bodyWithLink(n) },
  ];
  let firstFailure: SendResult | undefined;
  for (const batch of batches) {
    if (batch.urls.length === 0) continue;
    const result = await post(`${config.apiUrl}/notify/`, { ...common, ...batch }, headers, deps);
    if (!result.ok && firstFailure === undefined) firstFailure = result;
  }
  return firstFailure ?? { ok: true };
}

async function send(
  n: Notification,
  config: AppriseConfig,
  deps: SenderDeps,
  ignoreMinSeverity = false,
): Promise<SendResult> {
  try {
    return config.mode === "stateful"
      ? await sendStateful(n, config, deps)
      : await sendStateless(n, config, deps, ignoreMinSeverity);
  } catch (error) {
    return classifyError(error);
  }
}

export const appriseSender: NotificationSender<AppriseConfig> = {
  name: "apprise",
  send: (n, config, deps) => send(n, config, deps),
  sendTest: (config, deps) => send(TEST_NOTIFICATION, config, deps, true),
};
