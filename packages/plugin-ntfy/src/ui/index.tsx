import type { StatusSnapshot, TestResult } from "@paperclip-plugins/notify-core";
import {
  type PluginCompanySettingsPageProps,
  usePluginAction,
  usePluginData,
  usePluginToast,
} from "@paperclipai/plugin-sdk/ui";
import { useState } from "react";

const row = { display: "flex", gap: "0.5rem" } as const;

/**
 * Company settings page: delivery status and a test button. The configuration itself stays in
 * the host's form generated from the manifest schema (Settings → Plugins → ntfy).
 */
export function NtfySettingsPage(_props: PluginCompanySettingsPageProps) {
  const status = usePluginData<StatusSnapshot>("status");
  const sendTest = usePluginAction("send-test");
  const toast = usePluginToast();
  const [sending, setSending] = useState(false);

  if (status.loading) return <p>Loading ntfy status…</p>;
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

  return (
    <section style={{ display: "grid", gap: "0.75rem", maxWidth: "40rem" }}>
      <h2>ntfy notifications</h2>
      {status.error ? <p role="alert">Could not load status: {status.error.message}</p> : null}
      <div style={row}>
        <strong>Status:</strong>
        <span>
          {!data?.configured
            ? "Not configured — set a topic in the plugin settings (notifications are disabled)"
            : data.enabled
              ? "Enabled"
              : "Configured but disabled"}
        </span>
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
        <button type="button" onClick={() => void onTest()} disabled={sending || !data?.configured}>
          {sending ? "Sending…" : "Send test notification"}
        </button>
      </div>
    </section>
  );
}
