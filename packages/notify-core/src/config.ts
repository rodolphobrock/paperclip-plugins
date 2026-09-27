import type { JsonSchema } from "@paperclipai/plugin-sdk";
import { DEFAULT_RULES, type EventRule, isRuleKey, RULE_KEYS, type RuleKey } from "./catalog.js";
import { isRecord } from "./guards.js";
import { isValidTimezone, type QuietHours, TIME_PATTERN } from "./quiet-hours.js";
import { isSeverity, SEVERITIES, type Severity } from "./severity.js";

/** Config fields every notifier plugin shares (spec decision 7). */
export interface BaseConfig {
  enabled: boolean;
  /** Needed for deep links; the worker does not receive the host's public URL. */
  paperclipBaseUrl?: string;
  events: Record<RuleKey, EventRule>;
  minSeverity: Severity;
  filters: { projectIds: string[]; agentIds: string[] };
  network: { allowPrivateNetwork: boolean };
  quietHours: QuietHours;
  rateLimit: { perMinute: number; digestWindowMinutes: number };
  retry: { maxAttempts: number; maxAgeMinutes: number };
}

export const DEFAULT_QUIET_HOURS: Readonly<QuietHours> = {
  enabled: false,
  start: "22:00",
  end: "07:00",
  timezone: "UTC",
  allowUrgent: true,
};

/** Inclusive integer ranges for the delivery settings. */
const LIMITS = {
  "rateLimit.perMinute": [1, 600, 10],
  "rateLimit.digestWindowMinutes": [1, 1440, 5],
  "retry.maxAttempts": [1, 20, 5],
  "retry.maxAgeMinutes": [1, 1440, 60],
} as const;

export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid notifier config: ${issues.join("; ")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

/** Validates the shared fields and applies defaults. Unknown top-level keys are left to the plugin. */
export function parseBaseConfig(raw: unknown): BaseConfig {
  const input = raw ?? {};
  if (!isRecord(input)) throw new ConfigError(["config must be an object"]);

  const issues: string[] = [];
  const bool = (value: unknown, path: string, fallback: boolean): boolean => {
    if (value === undefined) return fallback;
    if (typeof value === "boolean") return value;
    issues.push(`${path} must be a boolean`);
    return fallback;
  };
  const severity = (value: unknown, path: string, fallback: Severity): Severity => {
    if (value === undefined) return fallback;
    if (isSeverity(value)) return value;
    issues.push(`${path} must be one of ${SEVERITIES.join(", ")}`);
    return fallback;
  };
  const strings = (value: unknown, path: string): string[] => {
    if (value === undefined) return [];
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) return [...value];
    issues.push(`${path} must be a list of strings`);
    return [];
  };
  const object = (value: unknown, path: string): Record<string, unknown> => {
    if (value === undefined) return {};
    if (isRecord(value)) return value;
    issues.push(`${path} must be an object`);
    return {};
  };

  const events = { ...DEFAULT_RULES } as Record<RuleKey, EventRule>;
  for (const [key, override] of Object.entries(object(input.events, "events"))) {
    if (!isRuleKey(key)) {
      issues.push(`events.${key} is not a known event rule`);
      continue;
    }
    const rule = object(override, `events.${key}`);
    events[key] = {
      enabled: bool(rule.enabled, `events.${key}.enabled`, DEFAULT_RULES[key].enabled),
      severity: severity(rule.severity, `events.${key}.severity`, DEFAULT_RULES[key].severity),
    };
  }

  const int = (value: unknown, path: keyof typeof LIMITS): number => {
    const [min, max, fallback] = LIMITS[path];
    if (value === undefined) return fallback;
    if (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max) {
      return value;
    }
    issues.push(`${path} must be a whole number from ${min} to ${max}`);
    return fallback;
  };
  const time = (value: unknown, path: string, fallback: string): string => {
    if (value === undefined) return fallback;
    if (typeof value === "string" && TIME_PATTERN.test(value)) return value;
    issues.push(`${path} must be a time as HH:MM (00:00 to 23:59)`);
    return fallback;
  };

  const quiet = object(input.quietHours, "quietHours");
  const quietHours: QuietHours = {
    enabled: bool(quiet.enabled, "quietHours.enabled", DEFAULT_QUIET_HOURS.enabled),
    start: time(quiet.start, "quietHours.start", DEFAULT_QUIET_HOURS.start),
    end: time(quiet.end, "quietHours.end", DEFAULT_QUIET_HOURS.end),
    timezone: DEFAULT_QUIET_HOURS.timezone,
    allowUrgent: bool(quiet.allowUrgent, "quietHours.allowUrgent", DEFAULT_QUIET_HOURS.allowUrgent),
  };
  if (quiet.timezone !== undefined) {
    if (typeof quiet.timezone === "string" && isValidTimezone(quiet.timezone)) {
      quietHours.timezone = quiet.timezone;
    } else {
      issues.push("quietHours.timezone must be an IANA timezone such as America/Sao_Paulo");
    }
  }
  if (quietHours.enabled && quietHours.start === quietHours.end) {
    issues.push("quietHours.start and quietHours.end must differ when quiet hours are enabled");
  }

  const rateLimit = object(input.rateLimit, "rateLimit");
  const retry = object(input.retry, "retry");
  const filters = object(input.filters, "filters");
  const network = object(input.network, "network");
  const config: BaseConfig = {
    quietHours,
    rateLimit: {
      perMinute: int(rateLimit.perMinute, "rateLimit.perMinute"),
      digestWindowMinutes: int(rateLimit.digestWindowMinutes, "rateLimit.digestWindowMinutes"),
    },
    retry: {
      maxAttempts: int(retry.maxAttempts, "retry.maxAttempts"),
      maxAgeMinutes: int(retry.maxAgeMinutes, "retry.maxAgeMinutes"),
    },
    enabled: bool(input.enabled, "enabled", true),
    events,
    minSeverity: severity(input.minSeverity, "minSeverity", "low"),
    filters: {
      projectIds: strings(filters.projectIds, "filters.projectIds"),
      agentIds: strings(filters.agentIds, "filters.agentIds"),
    },
    network: {
      allowPrivateNetwork: bool(network.allowPrivateNetwork, "network.allowPrivateNetwork", false),
    },
  };

  const baseUrl = parseBaseUrl(input.paperclipBaseUrl, issues);
  if (baseUrl !== undefined) config.paperclipBaseUrl = baseUrl;

  if (issues.length > 0) throw new ConfigError(issues);
  return config;
}

function parseBaseUrl(value: unknown, issues: string[]): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value === "string" && URL.canParse(value)) {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return value.replace(/\/+$/, "");
  }
  issues.push("paperclipBaseUrl must be an http(s) URL");
  return undefined;
}

const severitySchema = (fallback: Severity): JsonSchema => ({
  type: "string",
  enum: [...SEVERITIES],
  default: fallback,
});

/** JSON Schema fragment for the shared fields; plugins merge it into `instanceConfigSchema`. */
export const baseConfigSchema: { properties: Record<string, JsonSchema> } = {
  properties: {
    enabled: {
      type: "boolean",
      title: "Enabled",
      default: true,
    },
    paperclipBaseUrl: {
      type: "string",
      // A pattern, not format "uri": the host form saves "" for a cleared field.
      pattern: "^(https?://\\S+)?$",
      title: "Paperclip base URL",
      description: "Public URL of this Paperclip instance, used for links in notifications.",
    },
    events: {
      type: "object",
      title: "Events",
      properties: Object.fromEntries(
        RULE_KEYS.map((key) => [
          key,
          {
            type: "object",
            properties: {
              enabled: { type: "boolean", default: DEFAULT_RULES[key].enabled },
              severity: severitySchema(DEFAULT_RULES[key].severity),
            },
          },
        ]),
      ),
    },
    minSeverity: { ...severitySchema("low"), title: "Minimum severity" },
    filters: {
      type: "object",
      title: "Filters",
      description: "Only notify for these projects or agents. Empty means all.",
      properties: {
        projectIds: { type: "array", items: { type: "string" }, default: [] },
        agentIds: { type: "array", items: { type: "string" }, default: [] },
      },
    },
    network: {
      type: "object",
      title: "Network",
      properties: {
        allowPrivateNetwork: {
          type: "boolean",
          default: false,
          description:
            "Allow sending to private network addresses (self-hosted servers). Only enable for destinations you trust.",
        },
      },
    },
    quietHours: {
      type: "object",
      title: "Quiet hours",
      description:
        "Hold notifications below urgent during this window and send them as one digest when it ends.",
      properties: {
        enabled: { type: "boolean", default: DEFAULT_QUIET_HOURS.enabled },
        start: { type: "string", pattern: TIME_PATTERN.source, default: DEFAULT_QUIET_HOURS.start },
        end: { type: "string", pattern: TIME_PATTERN.source, default: DEFAULT_QUIET_HOURS.end },
        timezone: {
          type: "string",
          default: DEFAULT_QUIET_HOURS.timezone,
          description: "IANA timezone, e.g. America/Sao_Paulo.",
        },
        allowUrgent: { type: "boolean", default: DEFAULT_QUIET_HOURS.allowUrgent },
      },
    },
    rateLimit: {
      type: "object",
      title: "Rate limit",
      description: "Notifications above the limit are grouped into a digest.",
      properties: {
        perMinute: integerSchema("rateLimit.perMinute"),
        digestWindowMinutes: integerSchema("rateLimit.digestWindowMinutes"),
      },
    },
    retry: {
      type: "object",
      title: "Retry",
      properties: {
        maxAttempts: integerSchema("retry.maxAttempts"),
        maxAgeMinutes: integerSchema("retry.maxAgeMinutes"),
      },
    },
  },
};

function integerSchema(path: keyof typeof LIMITS): JsonSchema {
  const [minimum, maximum, fallback] = LIMITS[path];
  return { type: "integer", minimum, maximum, default: fallback };
}
