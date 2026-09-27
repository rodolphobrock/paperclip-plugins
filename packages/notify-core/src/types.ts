import type { EnvSecretRefBinding, PluginEventType, PluginLogger } from "@paperclipai/plugin-sdk";
import type { Severity, Tone } from "./severity.js";

/** Secret reference as the host stores it in plugin config (`format: "secret-ref"`). */
export type SecretRef = EnvSecretRefBinding;

/** Where a notification's deep link points inside Paperclip. */
export type LinkTarget =
  | { kind: "issue"; identifier: string }
  | { kind: "approval"; approvalId: string }
  | { kind: "run"; agentId: string; runId: string };

/** A normalized notification, ready for a sender. */
export interface Notification {
  /** Semantic dedupe key. */
  key: string;
  companyId: string;
  eventType: PluginEventType;
  severity: Severity;
  tone: Tone;
  /** At most 120 characters. */
  title: string;
  body: string;
  url?: string;
  tags: string[];
  /** ISO 8601. */
  occurredAt: string;
}

export type SendResult =
  | { ok: true }
  | { ok: false; retryable: boolean; error: string; retryAfterMs?: number };

/**
 * A secret could not be resolved (deleted reference, host rate limit). Not retryable,
 * and the message never carries the underlying cause, which may echo secret material.
 */
export class SecretResolutionError extends Error {
  readonly configPath: string;

  constructor(configPath: string, cause?: unknown) {
    super(`secret resolution failed (${configPath})`, { cause });
    this.name = "SecretResolutionError";
    this.configPath = configPath;
  }
}

/** The subset of `fetch` both `ctx.http.fetch` and the global fetch provide. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface SenderDeps {
  /** `ctx.http.fetch` (SSRF-protected), or the global fetch when private networks are allowed. */
  fetch: FetchLike;
  /** Resolves a secret for the current company; cached by the notifier. */
  resolveSecret(ref: SecretRef, configPath: string): Promise<string>;
  logger: PluginLogger;
}

/** The one thing a notifier plugin implements: how to deliver a notification. */
export interface NotificationSender<C> {
  readonly name: string;
  send(n: Notification, config: C, deps: SenderDeps): Promise<SendResult>;
  sendTest(config: C, deps: SenderDeps): Promise<SendResult>;
}
