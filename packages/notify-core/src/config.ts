import type { JsonSchema } from "@paperclipai/plugin-sdk";
import { DEFAULT_RULES, type EventRule, isRuleKey, RULE_KEYS, type RuleKey } from "./catalog.js";
import { isRecord } from "./guards.js";
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
}

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

  const filters = object(input.filters, "filters");
  const network = object(input.network, "network");
  const config: BaseConfig = {
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
      format: "uri",
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
  },
};
