import {
  type BaseConfig,
  baseConfigSchema,
  type ExtraHeader,
  extraHeadersSchema,
  isRecord,
  isSecretRef,
  isSeverity,
  parseExtraHeaders,
  parseHttpUrl,
  parseWithBase,
  SEVERITIES,
  type SecretRef,
  type Severity,
  secretRefSchema,
  URL_PATTERN,
} from "@paperclip-plugins/notify-core";
import type { JsonSchema } from "@paperclipai/plugin-sdk";

export type NtfyAuth =
  | { mode: "none" }
  | { mode: "token"; token: SecretRef }
  | { mode: "basic"; username: string; password: SecretRef };

export interface NtfyConfig extends BaseConfig {
  serverUrl: string;
  topic: string;
  /** Per-severity topic overrides, e.g. urgent alerts on a separate topic. */
  topicsBySeverity: Partial<Record<Severity, string>>;
  auth: NtfyAuth;
  /** Extra headers such as CF-Access-Client-Id / CF-Access-Client-Secret; values are secrets. */
  extraHeaders: ExtraHeader[];
  markdown: boolean;
  iconUrl?: string;
}

type NtfyFields = Omit<NtfyConfig, keyof BaseConfig>;

const DEFAULT_SERVER = "https://ntfy.sh";
const TOPIC_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Shared fields (notify-core) plus the ntfy fields, all problems reported at once. */
export function parseNtfyConfig(raw: unknown): NtfyConfig {
  return parseWithBase<NtfyFields>(raw, (input, issues) => {
    const topic = parseTopic(input.topic, "topic", issues, true);
    const serverUrl = parseHttpUrl(input.serverUrl, "serverUrl", issues) ?? DEFAULT_SERVER;
    const iconUrl = parseHttpUrl(input.iconUrl, "iconUrl", issues);

    const topicsBySeverity: Partial<Record<Severity, string>> = {};
    if (input.topicsBySeverity !== undefined && !isRecord(input.topicsBySeverity)) {
      issues.push("topicsBySeverity must be an object");
    } else {
      for (const [severity, value] of Object.entries(input.topicsBySeverity ?? {})) {
        if (!isSeverity(severity)) {
          issues.push(`topicsBySeverity.${severity} is not a severity (${SEVERITIES.join(", ")})`);
          continue;
        }
        const parsed = parseTopic(value, `topicsBySeverity.${severity}`, issues, false);
        if (parsed !== undefined) topicsBySeverity[severity] = parsed;
      }
    }

    let markdown = false;
    if (input.markdown !== undefined) {
      if (typeof input.markdown === "boolean") markdown = input.markdown;
      else issues.push("markdown must be a boolean");
    }

    const auth = parseAuth(input.auth, issues);
    const extraHeaders = parseExtraHeaders(input.extraHeaders, issues);
    if (topic === undefined) return undefined;

    const fields: NtfyFields = {
      serverUrl,
      topic,
      topicsBySeverity,
      auth,
      extraHeaders,
      markdown,
    };
    if (iconUrl !== undefined) fields.iconUrl = iconUrl;
    return fields;
  });
}

function parseTopic(
  value: unknown,
  path: string,
  issues: string[],
  required: boolean,
): string | undefined {
  if (value === undefined || value === "") {
    if (required) issues.push(`${path} is required`);
    return undefined;
  }
  if (typeof value === "string" && TOPIC_PATTERN.test(value)) return value;
  issues.push(`${path} must be 1-64 letters, digits, "-" or "_"`);
  return undefined;
}

function parseAuth(value: unknown, issues: string[]): NtfyAuth {
  if (value === undefined) return { mode: "none" };
  if (!isRecord(value)) {
    issues.push("auth must be an object");
    return { mode: "none" };
  }
  const mode = value.mode ?? "none";
  if (mode === "none") return { mode: "none" };
  if (mode === "token") {
    if (isSecretRef(value.token)) return { mode: "token", token: value.token };
    issues.push("auth.token must be a secret reference when auth.mode is token");
    return { mode: "none" };
  }
  if (mode === "basic") {
    const username =
      typeof value.username === "string" && value.username !== "" ? value.username : undefined;
    if (username === undefined) issues.push("auth.username is required when auth.mode is basic");
    if (!isSecretRef(value.password)) {
      issues.push("auth.password must be a secret reference when auth.mode is basic");
    }
    if (username !== undefined && isSecretRef(value.password)) {
      return { mode: "basic", username, password: value.password };
    }
    return { mode: "none" };
  }
  issues.push("auth.mode must be one of none, token, basic");
  return { mode: "none" };
}

// Optional fields accept "": the host form saves "" when a user clears a field.
const OPTIONAL_TOPIC_PATTERN = "^([A-Za-z0-9_-]{1,64})?$";
const topicSchema = (title: string, optional = false): JsonSchema => ({
  type: "string",
  title,
  pattern: optional ? OPTIONAL_TOPIC_PATTERN : TOPIC_PATTERN.source,
});

/** `instanceConfigSchema` for the manifest: shared fields plus ntfy fields. */
export const ntfyConfigSchema: JsonSchema & {
  properties: Record<string, JsonSchema>;
  required: string[];
} = {
  type: "object",
  required: ["topic"],
  properties: {
    serverUrl: {
      type: "string",
      pattern: URL_PATTERN,
      title: "ntfy server URL",
      default: DEFAULT_SERVER,
    },
    topic: {
      ...topicSchema("Topic"),
      description: "On ntfy.sh the topic name works like a password; prefer an access token.",
    },
    topicsBySeverity: {
      type: "object",
      title: "Topic per severity",
      description: "Optional overrides, e.g. urgent alerts on a separate topic.",
      properties: Object.fromEntries(SEVERITIES.map((s) => [s, topicSchema(s, true)])),
    },
    auth: {
      type: "object",
      title: "Authentication",
      properties: {
        mode: { type: "string", enum: ["none", "token", "basic"], default: "none" },
        token: secretRefSchema("Access token"),
        username: { type: "string", title: "Username" },
        password: secretRefSchema("Password"),
      },
    },
    extraHeaders: extraHeadersSchema(
      "For example CF-Access-Client-Id and CF-Access-Client-Secret for Cloudflare Access.",
    ),
    markdown: { type: "boolean", title: "Markdown", default: false },
    iconUrl: { type: "string", pattern: URL_PATTERN, title: "Icon URL" },
    ...baseConfigSchema.properties,
  },
};
