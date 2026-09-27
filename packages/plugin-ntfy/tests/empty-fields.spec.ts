import { Ajv } from "ajv";
import formats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { parseNtfyConfig } from "../src/config.js";
import manifest from "../src/manifest.js";

const addFormats = formats.default;

// The host form saves "" when a user clears an optional text field.
describe("cleared optional fields", () => {
  const cleared = {
    topic: "alerts",
    serverUrl: "",
    iconUrl: "",
    paperclipBaseUrl: "",
    topicsBySeverity: { urgent: "" },
  };

  it("pass the host validation", () => {
    const ajv = new Ajv({ allErrors: true, strictTypes: false });
    addFormats(ajv);
    ajv.addFormat("secret-ref", { validate: () => true });
    const validate = ajv.compile(manifest.instanceConfigSchema ?? {});
    expect(validate(cleared), JSON.stringify(validate.errors)).toBe(true);
  });

  it("are treated as absent by the plugin", () => {
    const config = parseNtfyConfig(cleared);
    expect(config.serverUrl).toBe("https://ntfy.sh");
    expect(config.topicsBySeverity).toEqual({});
    expect(config).not.toHaveProperty("iconUrl");
    expect(config).not.toHaveProperty("paperclipBaseUrl");
  });
});
