import type { PluginContext, PluginEvent, ScopeKey } from "@paperclipai/plugin-sdk";
import { SUBSCRIBED_EVENT_TYPES } from "./catalog.js";
import type { BaseConfig } from "./config.js";
import { DedupeStore, semanticKey } from "./dedupe.js";
import { collectFacts, type HostPorts } from "./enrich.js";
import { isRecord } from "./guards.js";
import { classifyError } from "./http-result.js";
import { buildDeepLink, PrefixCache } from "./links.js";
import { mapEvent } from "./mappers.js";
import { applyPolicy } from "./policy.js";
import {
  type FetchLike,
  type Notification,
  type NotificationSender,
  type SecretRef,
  SecretResolutionError,
  type SenderDeps,
} from "./types.js";

const PRIVATE_FETCH_TIMEOUT_MS = 10_000;
const SECRET_TTL_MS = 5 * 60_000;

export interface NotifierOptions<C extends BaseConfig> {
  sender: NotificationSender<C>;
  /** Validates the plugin's full config (usually `parseBaseConfig` plus its own fields). */
  parseConfig(raw: unknown): C;
  clock?: () => number;
}

export interface Notifier {
  setup(ctx: PluginContext): Promise<void>;
}

/**
 * The shared pipeline: event → config → facts → draft → policy → dedupe → link → send.
 * Call `setup` from the plugin's own `setup`; importing this module registers nothing.
 */
export function createNotifier<C extends BaseConfig>(opts: NotifierOptions<C>): Notifier {
  const clock = opts.clock ?? Date.now;
  const queues = new Map<string, Promise<void>>();
  const warned = new Set<string>();
  const secrets = new Map<string, { value: string; at: number }>();

  return {
    async setup(ctx) {
      const prefixes = new PrefixCache(
        async (companyId) => (await ctx.companies.get(companyId))?.issuePrefix ?? null,
        clock,
      );
      const ports = hostPorts(ctx);

      const warnOnce = (key: string, message: string, meta: Record<string, unknown>) => {
        if (warned.has(key)) return;
        warned.add(key);
        ctx.logger.warn(message, meta);
      };

      const metric = (name: string, tags: Record<string, string>) => {
        ctx.metrics.write(name, 1, tags).catch(() => undefined);
      };

      const loadConfig = async (companyId: string): Promise<C | null> => {
        const raw = await ctx.config.get(companyId);
        if (!isRecord(raw) || Object.keys(raw).length === 0) return null;
        try {
          const config = opts.parseConfig(raw);
          warned.delete(`invalid:${companyId}`);
          return config.enabled ? config : null;
        } catch (error) {
          warnOnce(`invalid:${companyId}`, "notify.invalid_config", {
            companyId,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      };

      const handle = async (event: PluginEvent) => {
        const { companyId } = event;
        const config = await loadConfig(companyId);
        if (config === null) return;

        const { agentIds, projectIds } = config.filters;
        const needsIssue = agentIds.length > 0 || projectIds.length > 0;
        const facts = await collectFacts(event, ports, ctx.logger, needsIssue);
        const draft = mapEvent(event, facts);
        if (draft === null) return;

        const tags = { eventType: event.eventType, severity: draft.severity };
        const verdict = applyPolicy(draft, config);
        if (!verdict.pass) {
          ctx.logger.debug("notify.suppressed", {
            eventType: event.eventType,
            reason: verdict.reason,
          });
          metric("notify.suppressed", { ...tags, reason: verdict.reason });
          return;
        }

        const key = semanticKey(event.eventType, event.entityId, draft.factKey);
        const dedupe = new DedupeStore(stateOf(ctx, companyId));
        const keys = [`eventId:${event.eventId}`, key];
        const now = clock();
        if (await dedupe.seen(keys, now)) {
          ctx.logger.debug("notify.suppressed", { eventType: event.eventType, reason: "dedupe" });
          metric("notify.deduped", tags);
          return;
        }
        // Remember before sending: at most one attempt per fact, even if the send hangs or crashes.
        await dedupe.remember(keys, now);

        const notification: Notification = {
          key,
          companyId,
          eventType: draft.eventType,
          severity: verdict.severity,
          tone: draft.tone,
          title: draft.title,
          body: draft.body,
          tags: draft.tags,
          occurredAt: event.occurredAt,
        };
        if (draft.link !== undefined) {
          if (config.paperclipBaseUrl === undefined) {
            warnOnce(`base-url:${companyId}`, "notify.missing_base_url", { companyId });
          } else {
            try {
              const prefix = await prefixes.get(companyId);
              const link =
                prefix !== null
                  ? buildDeepLink(config.paperclipBaseUrl, prefix, draft.link)
                  : undefined;
              if (link !== undefined) notification.url = link;
            } catch (error) {
              ctx.logger.warn("notify.link_failed", {
                companyId,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }

        const deps: SenderDeps = {
          fetch: selectFetch(ctx, config),
          resolveSecret: (ref, configPath) => resolveSecret(ref, configPath, companyId),
          logger: ctx.logger,
        };
        const result = await opts.sender.send(notification, config, deps).catch(classifyError);
        const logTags = { ...tags, severity: notification.severity, sender: opts.sender.name };
        if (result.ok) {
          ctx.logger.info("notify.sent", { ...logTags, key });
          metric("notify.sent", { eventType: event.eventType, severity: notification.severity });
        } else {
          ctx.logger.error("notify.failed", {
            ...logTags,
            key,
            error: result.error,
            retryable: result.retryable,
          });
          metric("notify.failed", { eventType: event.eventType, severity: notification.severity });
        }
      };

      const resolveSecret = async (ref: SecretRef, configPath: string, companyId: string) => {
        const cacheKey = `${companyId}:${ref.secretId}:${ref.version ?? "latest"}`;
        const cached = secrets.get(cacheKey);
        const now = clock();
        if (cached !== undefined && now - cached.at < SECRET_TTL_MS) return cached.value;
        try {
          const value = await ctx.secrets.resolve(ref, { companyId, configPath });
          secrets.set(cacheKey, { value, at: now });
          return value;
        } catch (error) {
          // Deleted refs and the host's 30 reads/min limit are not fixed by retrying soon.
          throw new SecretResolutionError(configPath, error);
        }
      };

      // Serialized per company so concurrent deliveries cannot race on the dedupe ring.
      const enqueue = (event: PluginEvent): Promise<void> => {
        const previous = queues.get(event.companyId) ?? Promise.resolve();
        const next = previous.then(() =>
          handle(event).catch((error: unknown) => {
            ctx.logger.error("notify.handler_failed", {
              eventType: event.eventType,
              error: error instanceof Error ? error.message : String(error),
            });
          }),
        );
        queues.set(event.companyId, next);
        return next.finally(() => {
          if (queues.get(event.companyId) === next) queues.delete(event.companyId);
        });
      };

      // Exactly one subscription per type (paperclip#13732 multiplies duplicate registrations).
      for (const eventType of SUBSCRIBED_EVENT_TYPES) {
        ctx.events.on(eventType, enqueue);
      }
    },
  };
}

function stateOf(ctx: PluginContext, companyId: string) {
  const scope: ScopeKey = {
    scopeKind: "company",
    scopeId: companyId,
    namespace: "notify",
    stateKey: "dedupe",
  };
  return {
    get: () => ctx.state.get(scope),
    set: (value: unknown) => ctx.state.set(scope, value),
  };
}

function selectFetch(ctx: PluginContext, config: BaseConfig): FetchLike {
  if (!config.network.allowPrivateNetwork) return (url, init) => ctx.http.fetch(url, init);
  // The operator opted out of the host's SSRF protection for this company (spec decision 8).
  return (url, init) =>
    globalThis.fetch(url, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(PRIVATE_FETCH_TIMEOUT_MS),
    });
}

function hostPorts(ctx: PluginContext): HostPorts {
  return {
    async getApproval(id, companyId) {
      const approval = await ctx.approvals.get(id, companyId);
      return approval ? { status: approval.status, type: approval.type } : null;
    },
    async getAgentName(id, companyId) {
      return (await ctx.agents.get(id, companyId))?.name ?? null;
    },
    async getIssue(id, companyId) {
      const issue = await ctx.issues.get(id, companyId);
      return issue
        ? {
            assigneeAgentId: issue.assigneeAgentId,
            projectId: issue.projectId,
            identifier: issue.identifier,
            title: issue.title,
          }
        : null;
    },
  };
}
