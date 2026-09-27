import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { SEVERITIES } from "@rodolphobrock/paperclip-notify-core";
import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

describe("paperclip-plugin-apprise manifest", () => {
  it("uses the package name as id and pins the host version", () => {
    expect(manifest.id).toBe("paperclip-plugin-apprise");
    expect(manifest.apiVersion).toBe(1);
    expect(manifest.minimumHostVersion).toBe("2026.916.1");
    expect(manifest.entrypoints.worker).toBe("./dist/worker.js");
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
