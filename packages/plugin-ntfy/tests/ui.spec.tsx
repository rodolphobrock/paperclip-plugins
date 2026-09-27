import type { StatusSnapshot } from "@paperclip-plugins/notify-core";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import manifest from "../src/manifest.js";

const hooks = vi.hoisted(() => ({
  status: null as StatusSnapshot | null,
  loading: false,
}));

vi.mock("@paperclipai/plugin-sdk/ui", () => ({
  usePluginData: () => ({
    data: hooks.status,
    loading: hooks.loading,
    error: null,
    refresh: () => {},
  }),
  usePluginAction: () => async () => ({ ok: true }),
  usePluginToast: () => () => null,
}));

const { NtfySettingsPage } = await import("../src/ui/index.js");

const context = {
  companyId: "co-1",
  companyPrefix: "PAP",
  projectId: null,
  entityId: null,
  entityType: null,
  userId: "u-1",
};

function render(): string {
  return renderToStaticMarkup(<NtfySettingsPage context={context} />);
}

beforeEach(() => {
  hooks.status = null;
  hooks.loading = false;
});

describe("manifest UI slot", () => {
  it("declares the company settings page and its capability", () => {
    expect(manifest.entrypoints.ui).toBe("./dist/ui");
    expect(manifest.capabilities).toContain("instance.settings.register");
    expect(manifest.ui?.slots).toEqual([
      {
        type: "companySettingsPage",
        id: "ntfy-settings",
        displayName: "ntfy",
        exportName: "NtfySettingsPage",
        routePath: "ntfy",
      },
    ]);
  });
});

describe("NtfySettingsPage", () => {
  it("shows loading", () => {
    hooks.loading = true;
    expect(render()).toContain("Loading");
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
});
