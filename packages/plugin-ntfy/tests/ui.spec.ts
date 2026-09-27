import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";

describe("manifest UI slot", () => {
  it("declares the company settings page, its export and capability", async () => {
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
    const ui = await import("../src/ui/index.js");
    expect(typeof ui.NtfySettingsPage).toBe("function");
  });
});
