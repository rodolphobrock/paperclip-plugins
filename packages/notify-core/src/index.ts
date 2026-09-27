export {
  DEFAULT_RULES,
  type EventRule,
  isRuleKey,
  RULE_KEYS,
  type RuleKey,
  SUBSCRIBED_EVENT_TYPES,
} from "./catalog.js";
export { type BaseConfig, baseConfigSchema, ConfigError, parseBaseConfig } from "./config.js";
export { isRecord, isSecretRef, readNumber, readString } from "./guards.js";
export { classifyError, classifyResponse, parseRetryAfter } from "./http-result.js";
export { buildDeepLink } from "./links.js";
export { type EventFacts, mapEvent, type NotificationDraft } from "./mappers.js";
export { createNotifier, type Notifier, type NotifierOptions } from "./notifier.js";
export { redact } from "./redact.js";
export {
  compareSeverity,
  isSeverity,
  SEVERITIES,
  type Severity,
  TONES,
  type Tone,
} from "./severity.js";
export type {
  FetchLike,
  LinkTarget,
  Notification,
  NotificationSender,
  SecretRef,
  SenderDeps,
  SendResult,
} from "./types.js";
export { SecretResolutionError } from "./types.js";
