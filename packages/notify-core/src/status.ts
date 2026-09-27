import type { StatePort } from "./dedupe.js";
import { isRecord } from "./guards.js";
import { redact } from "./redact.js";

/** What the settings page shows for a company. */
export interface StatusSnapshot {
  configured: boolean;
  enabled: boolean;
  lastSentAt?: string;
  lastError?: { at: string; message: string };
  /** Present when the saved config does not parse. */
  configError?: string;
}

interface StoredStatus {
  lastSentAt?: string;
  lastError?: { at: string; message: string };
}

/** Last delivery and last error per company, persisted in plugin state. */
export class StatusStore {
  readonly #state: StatePort;

  constructor(state: StatePort) {
    this.#state = state;
  }

  async read(): Promise<StoredStatus> {
    const raw = await this.#state.get();
    if (!isRecord(raw)) return {};
    const stored: StoredStatus = {};
    if (typeof raw.lastSentAt === "string") stored.lastSentAt = raw.lastSentAt;
    const error = raw.lastError;
    if (isRecord(error) && typeof error.at === "string" && typeof error.message === "string") {
      stored.lastError = { at: error.at, message: error.message };
    }
    return stored;
  }

  async recordSuccess(at: Date): Promise<void> {
    const { lastError } = await this.read();
    const next: StoredStatus = { lastSentAt: at.toISOString() };
    if (lastError !== undefined) next.lastError = lastError;
    await this.#state.set(next);
  }

  async recordError(at: Date, message: string): Promise<void> {
    const { lastSentAt } = await this.read();
    const next: StoredStatus = { lastError: { at: at.toISOString(), message: redact(message) } };
    if (lastSentAt !== undefined) next.lastSentAt = lastSentAt;
    await this.#state.set(next);
  }
}
