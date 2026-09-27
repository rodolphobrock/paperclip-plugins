import type { LinkTarget } from "./types.js";

const DEFAULT_TTL_MS = 10 * 60_000;

/** Paperclip UI route for a target, or undefined when no base URL is configured. */
export function buildDeepLink(
  baseUrl: string | undefined,
  issuePrefix: string,
  target: LinkTarget,
): string | undefined {
  if (!baseUrl) return undefined;
  const base = baseUrl.replace(/\/+$/, "");
  const segments = [issuePrefix, ...routeSegments(target)].map(encodeURIComponent);
  return `${base}/${segments.join("/")}`;
}

function routeSegments(target: LinkTarget): string[] {
  switch (target.kind) {
    case "issue":
      return ["issues", target.identifier];
    case "approval":
      return ["approvals", target.approvalId];
    case "run":
      return ["agents", target.agentId, "runs", target.runId];
    case "inbox":
      return ["inbox"];
  }
}

/** Company issue prefixes, cached in memory; failures are not cached. */
export class PrefixCache {
  readonly #load: (companyId: string) => Promise<string | null>;
  readonly #clock: () => number;
  readonly #ttlMs: number;
  readonly #entries = new Map<string, { prefix: string | null; at: number }>();

  constructor(
    load: (companyId: string) => Promise<string | null>,
    clock: () => number,
    ttlMs: number = DEFAULT_TTL_MS,
  ) {
    this.#load = load;
    this.#clock = clock;
    this.#ttlMs = ttlMs;
  }

  async get(companyId: string): Promise<string | null> {
    const now = this.#clock();
    const cached = this.#entries.get(companyId);
    if (cached !== undefined && now - cached.at < this.#ttlMs) return cached.prefix;

    const prefix = await this.#load(companyId);
    this.#entries.set(companyId, { prefix, at: now });
    return prefix;
  }
}
