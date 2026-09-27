import {
  type PluginCompanySettingsPageProps,
  usePluginAction,
  usePluginData,
  usePluginToast,
} from "@paperclipai/plugin-sdk/ui";
import { type FC, useState } from "react";
import type { TestResult } from "../notifier.js";
import { redact } from "../redact.js";
import type { StatusSnapshot } from "../status.js";

const row = { display: "flex", gap: "0.5rem" } as const;

export interface SettingsPageOptions {
  /** What to fill in first, e.g. "set a topic in the plugin settings". */
  setupHint?: string;
}

type ToastInput = { title: string; body?: string; tone: "success" | "error" };

/** Toast for the test button's outcome; thrown errors are redacted before display. */
export function testToast(outcome: unknown): ToastInput {
  if (isTestResult(outcome)) {
    return outcome.ok
      ? { title: "Test notification sent", tone: "success" }
      : { title: "Test notification failed", body: outcome.error, tone: "error" };
  }
  const message = outcome instanceof Error ? outcome.message : String(outcome);
  return { title: "Test notification failed", body: redact(message), tone: "error" };
}

function isTestResult(value: unknown): value is TestResult {
  return typeof value === "object" && value !== null && "ok" in value;
}

/**
 * Company settings page for a notifier plugin: delivery status and a test button. The
 * configuration itself stays in the host's form generated from the manifest schema.
 * Import from `@paperclip-plugins/notify-core/ui` in the plugin's UI entry only.
 */
export function createSettingsPage(
  serviceName: string,
  options: SettingsPageOptions = {},
): FC<PluginCompanySettingsPageProps> {
  const setupHint = options.setupHint ?? `fill in the ${serviceName} plugin settings`;
  return function NotifierSettingsPage(_props: PluginCompanySettingsPageProps) {
    const status = usePluginData<StatusSnapshot>("status");
    const sendTest = usePluginAction("send-test");
    const toast = usePluginToast();
    const [sending, setSending] = useState(false);

    if (status.loading) return <p>Loading {serviceName} status…</p>;
    const data = status.data;

    const onTest = async () => {
      setSending(true);
      try {
        toast(testToast(await sendTest()));
      } catch (error) {
        toast(testToast(error));
      } finally {
        setSending(false);
        status.refresh();
      }
    };

    const summary = status.error
      ? "Unknown (status could not be loaded)"
      : !data?.configured
        ? `Not configured — ${setupHint} (notifications are disabled)`
        : data.enabled
          ? "Enabled"
          : "Configured but disabled";

    return (
      <section style={{ display: "grid", gap: "0.75rem", maxWidth: "40rem" }}>
        <h2>{serviceName} notifications</h2>
        {status.error ? <p role="alert">Could not load status: {status.error.message}</p> : null}
        <div style={row}>
          <strong>Status:</strong>
          <span>{summary}</span>
        </div>
        {data?.configError ? (
          <p role="alert">
            <strong>Configuration error:</strong> {data.configError}
          </p>
        ) : null}
        <div style={row}>
          <strong>Last notification:</strong>
          <span>{data?.lastSentAt ?? "none yet"}</span>
        </div>
        {data?.lastError ? (
          <div style={row}>
            <strong>Last error:</strong>
            <span>
              {data.lastError.message} ({data.lastError.at})
            </span>
          </div>
        ) : null}
        <div>
          <button
            type="button"
            onClick={() => void onTest()}
            disabled={sending || !data?.configured}
          >
            {sending ? "Sending…" : "Send test notification"}
          </button>
        </div>
      </section>
    );
  };
}
