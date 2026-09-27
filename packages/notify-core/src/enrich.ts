import type { PluginEvent, PluginLogger } from "@paperclipai/plugin-sdk";
import { readString } from "./guards.js";
import type { EventFacts } from "./mappers.js";

/** Host lookups the notifier needs, narrowed so they are easy to fake in tests. */
export interface HostPorts {
  getApproval(id: string, companyId: string): Promise<{ status: string; type: string } | null>;
  getAgentName(id: string, companyId: string): Promise<string | null>;
  getIssue(id: string, companyId: string): Promise<EventFacts["issue"] | null>;
}

/**
 * Fetches only what the event needs. A failed lookup is logged and skipped: the
 * notification still goes out with the payload's data.
 */
export async function collectFacts(
  event: PluginEvent,
  ports: HostPorts,
  logger: PluginLogger,
  needsIssue: boolean,
): Promise<EventFacts> {
  const facts: EventFacts = {};
  const { companyId, entityId, eventType } = event;

  const lookup = async <T>(name: string, load: () => Promise<T | null>): Promise<T | undefined> => {
    try {
      return (await load()) ?? undefined;
    } catch (error) {
      logger.warn("notify.enrich_failed", {
        eventType,
        lookup: name,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  };

  if (eventType.startsWith("approval.") && entityId) {
    const approval = await lookup("approval", () => ports.getApproval(entityId, companyId));
    if (approval !== undefined) facts.approval = approval;
  }

  const agentId = readString(event.payload, "agentId");
  if (eventType.startsWith("agent.run.") && agentId !== undefined) {
    const name = await lookup("agent", () => ports.getAgentName(agentId, companyId));
    if (name !== undefined) facts.agentName = name;
  }

  const wantsIssue =
    eventType === "issue.comment.created" || (needsIssue && eventType.startsWith("issue."));
  if (wantsIssue && entityId) {
    const issue = await lookup("issue", () => ports.getIssue(entityId, companyId));
    if (issue !== undefined) facts.issue = issue;
  }

  return facts;
}
