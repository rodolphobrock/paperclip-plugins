import type { JsonSchema } from "@paperclipai/plugin-sdk";
import { type BaseConfig, ConfigError, parseBaseConfig } from "./config.js";
import { isRecord, isSecretRef } from "./guards.js";
import type { SecretRef, SenderDeps } from "./types.js";

/** Config parsing and schema pieces shared by the notifier plugins. */

/**
 * For schemas: a pattern instead of `format: "uri"`, accepting "" because the host form saves
 * "" when a user clears a field, and the host validates the saved config with Ajv.
 */
export const URL_PATTERN = "^(https?://\\S+)?$";

const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const RESERVED_HEADERS = ["authorization", "content-type", "content-length", "host"];

export interface ExtraHeader {
  name: string;
  value: SecretRef;
}

export type BasicAuth = { mode: "none" } | { mode: "basic"; username: string; password: SecretRef };

/** An http(s) URL without trailing slashes; "" and undefined mean absent. */
export function parseHttpUrl(value: unknown, path: string, issues: string[]): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value === "string" && URL.canParse(value)) {
    const { protocol } = new URL(value);
    if (protocol === "http:" || protocol === "https:") return value.replace(/\/+$/, "");
  }
  issues.push(`${path} must be an http(s) URL`);
  return undefined;
}

/** Headers with secret values, e.g. Cloudflare Access service tokens or X-Apprise-Config-ID. */
export function parseExtraHeaders(value: unknown, issues: string[]): ExtraHeader[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.push("extraHeaders must be a list");
    return [];
  }
  const headers: ExtraHeader[] = [];
  value.forEach((item, index) => {
    // Dot paths, as the host keys secret bindings (extraHeaders.0.value).
    const path = `extraHeaders.${index}`;
    const name = isRecord(item) ? item.name : undefined;
    const secret = isRecord(item) ? item.value : undefined;
    const validName =
      typeof name === "string" &&
      HEADER_NAME_PATTERN.test(name) &&
      !RESERVED_HEADERS.includes(name.toLowerCase());
    if (!validName) {
      issues.push(`${path}.name must be a header name other than ${RESERVED_HEADERS.join(", ")}`);
    }
    if (!isSecretRef(secret)) issues.push(`${path}.value must be a secret reference`);
    // Header names are case-insensitive; a second value would be merged into the first.
    const duplicate =
      validName && headers.some((h) => h.name.toLowerCase() === (name as string).toLowerCase());
    if (duplicate) issues.push(`${path}.name duplicates another header`);
    if (validName && !duplicate && isSecretRef(secret)) headers.push({ name, value: secret });
  });
  return headers;
}

/** `auth: { mode: "none" | "basic", username, password (secret) }`. */
export function parseBasicAuth(value: unknown, issues: string[]): BasicAuth {
  if (value === undefined) return { mode: "none" };
  if (!isRecord(value)) {
    issues.push("auth must be an object");
    return { mode: "none" };
  }
  const mode = value.mode ?? "none";
  if (mode === "none") return { mode: "none" };
  if (mode !== "basic") {
    issues.push("auth.mode must be one of none, basic");
    return { mode: "none" };
  }
  const username =
    typeof value.username === "string" && value.username !== "" ? value.username : undefined;
  if (username === undefined) issues.push("auth.username is required when auth.mode is basic");
  if (!isSecretRef(value.password)) {
    issues.push("auth.password must be a secret reference when auth.mode is basic");
  }
  return username !== undefined && isSecretRef(value.password)
    ? { mode: "basic", username, password: value.password }
    : { mode: "none" };
}

export async function resolveExtraHeaders(
  headers: ExtraHeader[],
  deps: SenderDeps,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const [index, header] of headers.entries()) {
    resolved[header.name] = await deps.resolveSecret(header.value, `extraHeaders.${index}.value`);
  }
  return resolved;
}

export function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

/**
 * No `type`: the host UI saves `{ type: "secret_ref", secretId }` objects, and its server-side
 * Ajv check would reject them under `type: "string"`. The form picks the widget from `format`.
 */
export function secretRefSchema(title: string): JsonSchema {
  return { format: "secret-ref", title };
}

export function extraHeadersSchema(description: string): JsonSchema {
  return {
    type: "array",
    title: "Extra headers",
    description,
    items: {
      type: "object",
      required: ["name", "value"],
      properties: {
        name: { type: "string", title: "Header" },
        value: secretRefSchema("Value"),
      },
    },
    default: [],
  };
}

export function basicAuthSchema(): JsonSchema {
  return {
    type: "object",
    title: "Authentication",
    properties: {
      mode: { type: "string", enum: ["none", "basic"], default: "none" },
      username: { type: "string", title: "Username" },
      password: secretRefSchema("Password"),
    },
  };
}

/**
 * Parses the shared fields (notify-core) and the plugin's own fields, reporting every problem
 * at once. `parseOwn` pushes its problems to `issues` and may return undefined when a required
 * field is missing.
 */
export function parseWithBase<E extends object>(
  raw: unknown,
  parseOwn: (input: Record<string, unknown>, issues: string[]) => E | undefined,
): BaseConfig & E {
  if (!isRecord(raw ?? {})) throw new ConfigError(["config must be an object"]);
  const issues: string[] = [];
  let base: BaseConfig | undefined;
  try {
    base = parseBaseConfig(raw);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    issues.push(...error.issues);
  }
  const own = parseOwn(isRecord(raw) ? raw : {}, issues);
  if (issues.length > 0 || base === undefined || own === undefined) throw new ConfigError(issues);
  return { ...base, ...own };
}
