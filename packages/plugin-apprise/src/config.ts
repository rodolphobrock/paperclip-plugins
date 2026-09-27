import {
  type BaseConfig,
  type BasicAuth,
  baseConfigSchema,
  basicAuthSchema,
  type ExtraHeader,
  extraHeadersSchema,
  isRecord,
  isSecretRef,
  isSeverity,
  parseBasicAuth,
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

export const MODES = ["stateful", "stateless"] as const;
export type AppriseMode = (typeof MODES)[number];
export const FORMATS = ["text", "markdown"] as const;
export type AppriseFormat = (typeof FORMATS)[number];

export interface AppriseDestination {
  /** An Apprise URL such as tgram://token/chat; it holds credentials, so it is a secret. */
  url: SecretRef;
  minSeverity: Severity;
}

export interface AppriseConfig extends BaseConfig {
  apiUrl: string;
  mode: AppriseMode;
  /** Stateful mode: the apprise-api configuration key (a secret, it grants access). */
  configKey?: SecretRef;
  /** Stateful mode: Apprise tag(s) per severity. */
  tagsBySeverity: Record<Severity, string>;
  /** Stateless mode: destinations kept in Paperclip as secrets. */
  destinations: AppriseDestination[];
  format: AppriseFormat;
  auth: BasicAuth;
  extraHeaders: ExtraHeader[];
}

type AppriseFields = Omit<AppriseConfig, keyof BaseConfig>;

export const DEFAULT_TAGS: Readonly<Record<Severity, string>> = {
  low: "info",
  normal: "info",
  high: "alert",
  urgent: "urgent,alert",
};

/** Apprise tags: words separated by commas or spaces (comma = OR, space = AND). */
// Stricter than apprise-api's TAG_VALIDATION_RE / TAG_TOKEN_RE (tokens start with a letter or digit;
// no "."), so a tag accepted here is never answered with 400.
const TAGS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*(?:[ ,]+[A-Za-z0-9][A-Za-z0-9_-]*)*$/;

/** Shared fields (notify-core) plus the Apprise fields, all problems reported at once. */
export function parseAppriseConfig(raw: unknown): AppriseConfig {
  return parseWithBase<AppriseFields>(raw, (input, issues) => {
    const apiUrl = parseHttpUrl(input.apiUrl, "apiUrl", issues);
    if (input.apiUrl === undefined || input.apiUrl === "") issues.push("apiUrl is required");

    let mode: AppriseMode = "stateful";
    if (input.mode !== undefined) {
      if ((MODES as readonly unknown[]).includes(input.mode)) mode = input.mode as AppriseMode;
      else issues.push(`mode must be one of ${MODES.join(", ")}`);
    }

    let format: AppriseFormat = "text";
    if (input.format !== undefined) {
      if ((FORMATS as readonly unknown[]).includes(input.format))
        format = input.format as AppriseFormat;
      else issues.push(`format must be one of ${FORMATS.join(", ")}`);
    }

    const configKey = isSecretRef(input.configKey) ? input.configKey : undefined;
    if (mode === "stateful" && configKey === undefined) {
      issues.push("configKey must be a secret reference in stateful mode");
    }

    const destinations = parseDestinations(input.destinations, issues);
    if (mode === "stateless" && destinations.length === 0 && !issues.some(isDestinationIssue)) {
      issues.push("destinations needs at least one destination in stateless mode");
    }

    const fields: AppriseFields = {
      apiUrl: apiUrl ?? "",
      mode,
      tagsBySeverity: parseTags(input.tagsBySeverity, issues),
      destinations,
      format,
      auth: parseBasicAuth(input.auth, issues),
      extraHeaders: parseExtraHeaders(input.extraHeaders, issues),
    };
    if (configKey !== undefined) fields.configKey = configKey;
    return apiUrl === undefined ? undefined : fields;
  });
}

function isDestinationIssue(issue: string): boolean {
  return issue.startsWith("destinations");
}

function parseTags(value: unknown, issues: string[]): Record<Severity, string> {
  const tags = { ...DEFAULT_TAGS };
  if (value === undefined) return tags;
  if (!isRecord(value)) {
    issues.push("tagsBySeverity must be an object");
    return tags;
  }
  for (const [severity, tag] of Object.entries(value)) {
    if (!isSeverity(severity)) {
      issues.push(`tagsBySeverity.${severity} is not a severity (${SEVERITIES.join(", ")})`);
    } else if (tag === undefined || tag === "") {
      // Cleared in the form: keep the default.
    } else if (typeof tag === "string" && TAGS_PATTERN.test(tag.trim())) {
      tags[severity] = tag.trim().toLowerCase();
    } else {
      issues.push(`tagsBySeverity.${severity} must be Apprise tags separated by commas or spaces`);
    }
  }
  return tags;
}

function parseDestinations(value: unknown, issues: string[]): AppriseDestination[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.push("destinations must be a list");
    return [];
  }
  const destinations: AppriseDestination[] = [];
  value.forEach((item, index) => {
    const path = `destinations.${index}`;
    if (!isRecord(item)) {
      issues.push(`${path} must be an object with url and minSeverity`);
      return;
    }
    // Never echo the value: a plain string here is an Apprise URL with credentials.
    if (!isSecretRef(item.url)) issues.push(`${path}.url must be a secret reference`);
    let minSeverity: Severity = "low";
    if (item.minSeverity !== undefined) {
      if (isSeverity(item.minSeverity)) minSeverity = item.minSeverity;
      else issues.push(`${path}.minSeverity must be one of ${SEVERITIES.join(", ")}`);
    }
    if (isSecretRef(item.url)) destinations.push({ url: item.url, minSeverity });
  });
  return destinations;
}

const severityEnum = (fallback: Severity): JsonSchema => ({
  type: "string",
  enum: [...SEVERITIES],
  default: fallback,
});

/** `instanceConfigSchema` for the manifest: shared fields plus Apprise fields. */
export const appriseConfigSchema: JsonSchema & {
  properties: Record<string, JsonSchema>;
  required: string[];
} = {
  type: "object",
  required: ["apiUrl"],
  properties: {
    apiUrl: {
      type: "string",
      pattern: URL_PATTERN,
      title: "apprise-api URL",
      description: "Base URL of your apprise-api server, e.g. http://apprise:8000.",
    },
    mode: {
      type: "string",
      enum: [...MODES],
      default: "stateful",
      title: "Mode",
      description:
        "stateful: destinations live in apprise-api, routed by tag. stateless: destinations are Apprise URLs stored here as secrets.",
    },
    configKey: {
      ...secretRefSchema("Configuration key"),
      description: "Stateful mode: the apprise-api configuration key.",
    },
    tagsBySeverity: {
      type: "object",
      title: "Tags per severity",
      description: "Stateful mode: Apprise tags to notify for each severity.",
      properties: Object.fromEntries(
        SEVERITIES.map((s) => [
          s,
          {
            type: "string",
            pattern: `^(${TAGS_PATTERN.source.slice(1, -1)})?$`,
            default: DEFAULT_TAGS[s],
          },
        ]),
      ),
    },
    destinations: {
      type: "array",
      title: "Destinations",
      description:
        "Stateless mode: Apprise URLs (as secrets) and the minimum severity each receives.",
      items: {
        type: "object",
        required: ["url"],
        properties: {
          url: secretRefSchema("Apprise URL"),
          minSeverity: severityEnum("low"),
        },
      },
      default: [],
    },
    format: { type: "string", enum: [...FORMATS], default: "text", title: "Body format" },
    auth: basicAuthSchema(),
    extraHeaders: extraHeadersSchema(
      "For example X-Apprise-Config-ID for a configuration user, or Cloudflare Access headers.",
    ),
    ...baseConfigSchema.properties,
  },
};
