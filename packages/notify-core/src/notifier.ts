import type { PluginContext, PluginEvent, ScopeKey } from "@paperclipai/plugin-sdk";
import { SUBSCRIBED_EVENT_TYPES } from "./catalog.js";
import { type BaseConfig, ConfigError } from "./config.js";
import { DedupeStore, type StatePort, semanticKey } from "./dedupe.js";
import { createDelivery, type DeliveryObserver } from "./delivery.js";
import { collectFacts, type HostPorts } from "./enrich.js";
import { isRecord, readString } from "./guards.js";
import { classifyError } from "./http-result.js";
import { buildDeepLink, PrefixCache } from "./links.js";
import { mapEvent } from "./mappers.js";
import { applyPolicy } from "./policy.js";
import { CompanyQueues, PendingIndex } from "./queues.js";
import { TokenBucket } from "./rate-limit.js";
import { redact } from "./redact.js";
import { type StatusSnapshot, StatusStore } from "./status.js";
import {
  type FetchLike,
  type LinkTarget,
  type Notification,
  type NotificationSender,
  type SecretRef,
  SecretResolutionError,
  type SenderDeps,
} from "./types.js";

const PRIVATE_FETCH_TIMEOUT_MS = 10_000;
const SECRET_TTL_MS = 5 * 60_000;
const HEALTH_FAILURE_WINDOW_MS = 5 * 60_000;
const HEALTH_RETRY_BACKLOG = 100;
export const DRAIN_JOB_KEY = "delivery-drain";

export interface NotifierOptions<C extends BaseConfig> {
  sender: NotificationSender<C>;
  /** Validates the plugin's full config (usually `parseBaseConfig` plus its own fields). */
  parseConfig(raw: unknown): C;
  clock?: () => number;
}

export interface Notifier {
  setup(ctx: PluginContext): Promise<void>;
  /** Resolves when every queued event and drain has finished (tests, `onShutdown`). */
  idle(): Promise<void>;
  /** For `onHealth`: degraded after a recent failed delivery or a large retry backlog. */
  health(): Promise<{ status: "ok" | "degraded"; message?: string }>;
  /** For `onConfigChanged`: forget one-time warnings so the new config is reported afresh. */
  configChanged(companyId: string | null): void;
}

/**
 * The shared pipeline: event → config → facts → draft → policy → dedupe → link → delivery
 * (quiet hours, rate limit, digest, retry). Call `setup` from the plugin's own `setup`;
 * importing this module registers nothing.
 */
export function createNotifier<C extends BaseConfig>(opts: NotifierOptions<C>): Notifier {
  const clock = opts.clock ?? Date.now;
  const locks = new Map<string, Promise<void>>();
  const warned = new Set<string>();
  const secrets = new Map<string, { value: string; at: number }>();
  const bucket = new TokenBucket();
  const retryBacklog = new Map<string, number>();
  let lastOutcome: { ok: boolean; at: number } | undefined;

  /** Runs tasks for one company one at a time, so events and the drain job share state safely. */
  const withLock = (companyId: string, task: () => Promise<void>): Promise<void> => {
    const previous = locks.get(companyId) ?? Promise.resolve();
    const next = previous.then(task);
    const settled = next.catch(() => undefined);
    locks.set(companyId, settled);
    void settled.then(() => {
      if (locks.get(companyId) === settled) locks.delete(companyId);
    });
    return next;
  };

  return {
    async idle() {
      while (locks.size > 0) await Promise.all(locks.values());
    },

    async health() {
      const backlog = Math.max(0, ...retryBacklog.values());
      if (backlog > HEALTH_RETRY_BACKLOG) {
        return { status: "degraded", message: `${backlog} notifications waiting to be retried` };
      }
      if (lastOutcome !== undefined && !lastOutcome.ok) {
        if (clock() - lastOutcome.at < HEALTH_FAILURE_WINDOW_MS) {
          return { status: "degraded", message: "The last delivery failed" };
        }
      }
      return { status: "ok" };
    },

    configChanged(companyId) {
      for (const key of [...warned]) {
        if (companyId === null || key.endsWith(`:${companyId}`)) warned.delete(key);
      }
    },

    async setup(ctx) {
      const prefixes = new PrefixCache(
        async (companyId) => (await ctx.companies.get(companyId))?.issuePrefix ?? null,
        clock,
      );
      const ports = hostPorts(ctx);
      const errorText = (error: unknown) =>
        error instanceof Error ? error.message : String(error);

      const warnOnce = (key: string, message: string, meta: Record<string, unknown>) => {
        if (warned.has(key)) return;
        warned.add(key);
        ctx.logger.warn(message, meta);
      };

      const metric = (name: string, tags: Record<string, string>, value = 1) => {
        ctx.metrics.write(name, value, tags).catch(() => undefined);
      };

      const readConfig = async (companyId: string): Promise<ConfigRead<C>> => {
        const raw = await ctx.config.get(companyId);
        if (!isRecord(raw) || Object.keys(raw).length === 0) return { state: "missing" };
        try {
          return { state: "ok", config: opts.parseConfig(raw) };
        } catch (error) {
          return { state: "invalid", error: errorText(error) };
        }
      };

      const loadConfig = async (companyId: string): Promise<C | null> => {
        const read = await readConfig(companyId);
        if (read.state === "missing") return null;
        if (read.state === "invalid") {
          warnOnce(`invalid:${companyId}`, "notify.invalid_config", {
            companyId,
            error: read.error,
          });
          return null;
        }
        warned.delete(`invalid:${companyId}`);
        return read.config.enabled ? read.config : null;
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

      const depsFor = (config: C, companyId: string): SenderDeps => ({
        fetch: selectFetch(ctx, config),
        resolveSecret: (ref, configPath) => resolveSecret(ref, configPath, companyId),
        logger: ctx.logger,
      });

      const recordStatus = async (companyId: string, error: string | undefined) => {
        lastOutcome = { ok: error === undefined, at: clock() };
        const store = new StatusStore(stateOf(ctx, companyId, "status"));
        const at = new Date(clock());
        try {
          if (error === undefined) await store.recordSuccess(at);
          else await store.recordError(at, error);
        } catch (failure) {
          warnOnce(`status:${companyId}`, "notify.status_write_failed", {
            companyId,
            error: errorText(failure),
          });
        }
      };

      const link = async (config: C, companyId: string, target: LinkTarget) => {
        if (config.paperclipBaseUrl === undefined) {
          warnOnce(`base-url:${companyId}`, "notify.missing_base_url", { companyId });
          return undefined;
        }
        try {
          const prefix = await prefixes.get(companyId);
          return prefix !== null
            ? buildDeepLink(config.paperclipBaseUrl, prefix, target)
            : undefined;
        } catch (error) {
          ctx.logger.warn("notify.link_failed", { companyId, error: errorText(error) });
          return undefined;
        }
      };

      const tagsOf = (n: Notification) => ({ eventType: n.eventType, severity: n.severity });

      const observer: DeliveryObserver = {
        async sent(n) {
          ctx.logger.info("notify.sent", { ...tagsOf(n), key: n.key, sender: opts.sender.name });
          metric("notify.sent", tagsOf(n));
          await recordStatus(n.companyId, undefined);
        },
        async failed(n, error) {
          ctx.logger.error("notify.failed", { ...tagsOf(n), key: n.key, error, retryable: false });
          metric("notify.failed", tagsOf(n));
          await recordStatus(n.companyId, error);
        },
        queued(n, reason) {
          ctx.logger.info("notify.queued", { ...tagsOf(n), key: n.key, reason });
          metric("notify.queued", { ...tagsOf(n), reason });
        },
        async retry(n, attempt, error) {
          ctx.logger.warn("notify.retry", { ...tagsOf(n), key: n.key, attempt, error });
          metric("notify.retry", tagsOf(n));
          await recordStatus(n.companyId, error);
        },
        async dropped(n, reason, error) {
          ctx.logger.error("notify.dropped", { ...tagsOf(n), key: n.key, reason, error });
          metric("notify.dropped", { ...tagsOf(n), reason });
          lastOutcome = { ok: false, at: clock() };
          await ctx.activity
            .log({
              companyId: n.companyId,
              message: `Notification not delivered (${reason}): ${n.title}`,
              metadata: { eventType: n.eventType, reason, ...(error ? { error } : {}) },
            })
            .catch((failure: unknown) =>
              ctx.logger.warn("notify.activity_log_failed", { error: errorText(failure) }),
            );
        },
        digested(companyId, count) {
          metric("notify.digested", { companyId }, count);
        },
      };

      const delivery = createDelivery<C>({
        clock,
        bucket,
        send: (n, config) =>
          opts.sender.send(n, config, depsFor(config, n.companyId)).catch(classifyError),
        loadConfig,
        queuesFor: (companyId) => {
          const retry = stateOf(ctx, companyId, "retry");
          return new CompanyQueues({
            retry: {
              get: retry.get,
              set: async (value) => {
                retryBacklog.set(companyId, Array.isArray(value) ? value.length : 0);
                await retry.set(value);
              },
            },
            digest: stateOf(ctx, companyId, "digest"),
          });
        },
        pending: new PendingIndex(instanceState(ctx, "pending")),
        inboxUrl: (companyId, config) => link(config, companyId, { kind: "inbox" }),
        withLock,
        observer,
      });

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
        const dedupe = new DedupeStore(stateOf(ctx, companyId, "dedupe"));
        const keys = [`eventId:${event.eventId}`, key];
        const now = clock();
        if (await dedupe.seen(keys, now)) {
          ctx.logger.debug("notify.suppressed", { eventType: event.eventType, reason: "dedupe" });
          metric("notify.deduped", tags);
          return;
        }
        // Remember before delivering: failures are retried from the queue, never re-derived.
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
          const url = await link(config, companyId, draft.link);
          if (url !== undefined) notification.url = url;
        }
        await delivery.deliver(notification, config);
      };

      // The host waits on this handler over RPC (30 s timeout); delivery continues in the
      // background, serialized per company.
      const onEvent = async (event: PluginEvent): Promise<void> => {
        void withLock(event.companyId, () => handle(event)).catch((error: unknown) => {
          ctx.logger.error("notify.handler_failed", {
            eventType: event.eventType,
            error: errorText(error),
          });
        });
      };

      // Exactly one subscription per type (paperclip#13732 multiplies duplicate registrations).
      for (const eventType of SUBSCRIBED_EVENT_TYPES) {
        ctx.events.on(eventType, onEvent);
      }

      ctx.jobs.register(DRAIN_JOB_KEY, async () => {
        await delivery.drain();
      });

      // The host puts the authorized company into params.companyId for the settings page.
      ctx.data.register("status", async (params): Promise<StatusSnapshot> => {
        const companyId = companyOf(params);
        if (companyId === undefined) return { configured: false, enabled: false };
        const read = await readConfig(companyId);
        const stored = await new StatusStore(stateOf(ctx, companyId, "status")).read();
        const snapshot: StatusSnapshot = {
          configured: read.state !== "missing",
          enabled: read.state === "ok" && read.config.enabled,
          ...stored,
        };
        if (read.state === "invalid") snapshot.configError = read.error;
        return snapshot;
      });

      // Resolves secrets with the right company, which the host's "Test configuration" cannot.
      ctx.actions.register("send-test", async (params, context): Promise<TestResult> => {
        const companyId = context.companyId ?? companyOf(params);
        if (companyId === undefined) return { ok: false, error: "Missing company" };
        const read = await readConfig(companyId);
        if (read.state === "missing")
          return { ok: false, error: "Not configured for this company" };
        if (read.state === "invalid") return { ok: false, error: read.error };

        const result = await opts.sender
          .sendTest(read.config, depsFor(read.config, companyId))
          .catch(classifyError);
        await recordStatus(companyId, result.ok ? undefined : result.error);
        ctx.logger.info("notify.test", { companyId, ok: result.ok });
        return result.ok ? { ok: true } : { ok: false, error: redact(result.error) };
      });
    },
  };
}

/** For `onValidateConfig`: structural checks only (the host passes no company, so no secrets). */
export async function validateConfig<C>(
  parseConfig: (raw: unknown) => C,
  raw: unknown,
): Promise<{ ok: true } | { ok: false; errors: string[] }> {
  try {
    parseConfig(raw);
    return { ok: true };
  } catch (error) {
    if (error instanceof ConfigError) return { ok: false, errors: error.issues };
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
}

type ConfigRead<C> =
  | { state: "missing" }
  | { state: "invalid"; error: string }
  | { state: "ok"; config: C };

export type TestResult = { ok: true } | { ok: false; error: string };

function companyOf(params: Record<string, unknown>): string | undefined {
  return readString(params, "companyId");
}

type CompanyStateKey = "dedupe" | "status" | "retry" | "digest";

function stateOf(ctx: PluginContext, companyId: string, stateKey: CompanyStateKey): StatePort {
  const scope: ScopeKey = {
    scopeKind: "company",
    scopeId: companyId,
    namespace: "notify",
    stateKey,
  };
  return {
    get: () => ctx.state.get(scope),
    set: (value: unknown) => ctx.state.set(scope, value),
  };
}

function instanceState(ctx: PluginContext, stateKey: string): StatePort {
  const scope: ScopeKey = { scopeKind: "instance", namespace: "notify", stateKey };
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
