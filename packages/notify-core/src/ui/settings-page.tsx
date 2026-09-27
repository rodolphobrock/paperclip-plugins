import {
  type PluginCompanySettingsPageProps,
  usePluginAction,
  usePluginData,
  usePluginToast,
} from "@paperclipai/plugin-sdk/ui";
import { type FC, useState } from "react";
import type { TestResult } from "../notifier.js";
import type { StatusSnapshot } from "../status.js";

const row = { display: "flex", gap: "0.5rem" } as const;

/**
 * Company settings page for a notifier plugin: delivery status and a test button. The
 * configuration itself stays in the host's form generated from the manifest schema.
 * Import from `@paperclip-plugins/notify-core/ui` in the plugin's UI entry only.
 */
export function createSettingsPage(serviceName: string): FC<PluginCompanySettingsPageProps> {
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
        const result = (await sendTest()) as TestResult;
        toast(
          result.ok
            ? { title: "Test notification sent", tone: "success" }
            : { title: "Test notification failed", body: result.error, tone: "error" },
        );
      } catch (error) {
        toast({ title: "Test notification failed", body: String(error), tone: "error" });
      } finally {
        setSending(false);
        status.refresh();
      }
    };

    const summary = status.error
      ? "Unknown (status could not be loaded)"
      : !data?.configured
        ? `Not configured — fill in the ${serviceName} plugin settings (notifications are disabled)`
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
