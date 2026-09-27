import { Ajv } from "ajv";
import formats from "ajv-formats";
import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";

const addFormats = formats.default;

// Mirrors the host's validateInstanceConfig (server/src/services/plugin-config-validator.ts),
// which runs on every config save.
function hostValidator() {
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  ajv.addFormat("secret-ref", { validate: () => true });
  return ajv.compile(manifest.instanceConfigSchema ?? {});
}

// The host UI stores secret fields as bindings, and the server rejects legacy UUID strings.
const ref = { type: "secret_ref", secretId: "11111111-1111-1111-1111-111111111111" };

describe("host config validation", () => {
  it.each([
    ["minimal", { topic: "alerts" }],
    ["token auth", { topic: "alerts", auth: { mode: "token", token: ref } }],
    ["basic auth", { topic: "alerts", auth: { mode: "basic", username: "u", password: ref } }],
    [
      "extra headers",
      { topic: "alerts", extraHeaders: [{ name: "CF-Access-Client-Id", value: ref }] },
    ],
    [
      "shared fields",
      {
        topic: "alerts",
        paperclipBaseUrl: "https://pc.example.com",
        events: { "issue.created": { enabled: true, severity: "normal" } },
        filters: { agentIds: ["a"] },
        network: { allowPrivateNetwork: true },
      },
    ],
  ])("accepts a saved %s config", (_label, config) => {
    const validate = hostValidator();
    expect(validate(config), JSON.stringify(validate.errors)).toBe(true);
  });

  it("rejects a config without topic", () => {
    expect(hostValidator()({})).toBe(false);
  });
});
