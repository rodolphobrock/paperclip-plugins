export {
  DEFAULT_RULES,
  type EventRule,
  isRuleKey,
  RULE_KEYS,
  type RuleKey,
  SUBSCRIBED_EVENT_TYPES,
} from "./catalog.js";
export {
  type BaseConfig,
  baseConfigSchema,
  ConfigError,
  DEFAULT_QUIET_HOURS,
  parseBaseConfig,
} from "./config.js";
export { backoffMs, type DropReason, type HoldReason } from "./delivery.js";
export { isRecord, isSecretRef, readNumber, readString } from "./guards.js";
export { classifyError, classifyResponse, parseRetryAfter } from "./http-result.js";
export { buildDeepLink } from "./links.js";
export { type EventFacts, mapEvent, type NotificationDraft } from "./mappers.js";
export {
  createNotifier,
  DRAIN_JOB_KEY,
  type Notifier,
  type NotifierOptions,
  type TestResult,
  validateConfig,
} from "./notifier.js";
export { isQuiet, isValidTimezone, type QuietHours } from "./quiet-hours.js";
export { redact } from "./redact.js";
export {
  compareSeverity,
  isSeverity,
  SEVERITIES,
  type Severity,
  TONES,
  type Tone,
} from "./severity.js";
export type { StatusSnapshot } from "./status.js";
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
