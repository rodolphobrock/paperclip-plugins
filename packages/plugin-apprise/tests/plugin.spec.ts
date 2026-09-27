import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { SEVERITIES } from "@rodolphobrock/paperclip-notify-core";
import { describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

describe("paperclip-plugin-apprise manifest", () => {
  it("uses the package name as id and the package version", () => {
    expect(manifest.id).toBe(pkg.name);
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.apiVersion).toBe(1);
    expect(manifest.entrypoints.worker).toBe("./dist/worker.js");
  });

  // The Paperclip server passes hostVersion "0.0.0" to the plugin loader (server/src/app.ts),
  // so any minimumHostVersion makes installation fail on a stock host.
  it("does not declare minimumHostVersion", () => {
    expect(manifest).not.toHaveProperty("minimumHostVersion");
  });
});

describe("paperclip-plugin-apprise worker", () => {
  it("sets up in the SDK harness and reports healthy", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);

    const health = await plugin.definition.onHealth?.();
    expect(health?.status).toBe("ok");
    expect(health?.message).toContain(SEVERITIES.join(", "));
  });
});
