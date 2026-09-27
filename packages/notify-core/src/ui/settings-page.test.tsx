import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StatusSnapshot } from "../status.js";

const hooks = vi.hoisted(() => ({
  status: null as StatusSnapshot | null,
  loading: false,
  error: null as { message: string } | null,
}));

vi.mock("@paperclipai/plugin-sdk/ui", () => ({
  usePluginData: () => ({
    data: hooks.status,
    loading: hooks.loading,
    error: hooks.error,
    refresh: () => {},
  }),
  usePluginAction: () => async () => ({ ok: true }),
  usePluginToast: () => () => null,
}));

const { createSettingsPage } = await import("./settings-page.js");
const Page = createSettingsPage("ntfy");

const context = {
  companyId: "co-1",
  companyPrefix: "PAP",
  projectId: null,
  entityId: null,
  entityType: null,
  userId: "u-1",
};

function render(): string {
  return renderToStaticMarkup(<Page context={context} />);
}

beforeEach(() => {
  hooks.status = null;
  hooks.loading = false;
  hooks.error = null;
});

describe("createSettingsPage", () => {
  it("shows loading", () => {
    hooks.loading = true;
    expect(render()).toContain("Loading ntfy status");
  });

  it("asks to configure an unconfigured company", () => {
    hooks.status = { configured: false, enabled: false };
    const html = render();
    expect(html).toContain("Not configured");
    expect(html).toContain("disabled");
  });

  it("shows last delivery, last error and the test button", () => {
    hooks.status = {
      configured: true,
      enabled: true,
      lastSentAt: "2026-09-27T12:00:00.000Z",
      lastError: { at: "2026-09-27T11:00:00.000Z", message: "HTTP 401" },
    };
    const html = render();
    expect(html).toContain("Enabled");
    expect(html).toContain("2026-09-27T12:00:00.000Z");
    expect(html).toContain("HTTP 401");
    expect(html).toContain("Send test notification");
  });

  it("shows config errors", () => {
    hooks.status = { configured: true, enabled: false, configError: "topic is required" };
    expect(render()).toContain("topic is required");
  });

  it("does not claim the company is unconfigured when status failed to load", () => {
    hooks.error = { message: "network" };
    const html = render();
    expect(html).toContain("Could not load status");
    expect(html).not.toContain("Not configured");
  });
});
