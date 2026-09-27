import { Ajv } from "ajv";
import formats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { appriseConfigSchema } from "../src/config.js";

const addFormats = formats.default;

// Mirrors the host's validateInstanceConfig (server/src/services/plugin-config-validator.ts).
function hostValidator() {
  const ajv = new Ajv({ allErrors: true, strictTypes: false });
  addFormats(ajv);
  ajv.addFormat("secret-ref", { validate: () => true });
  return ajv.compile(appriseConfigSchema);
}

const ref = { type: "secret_ref", secretId: "11111111-1111-1111-1111-111111111111" };

describe("host config validation", () => {
  it.each([
    ["stateful", { apiUrl: "http://apprise:8000", configKey: ref }],
    [
      "stateless",
      {
        apiUrl: "http://apprise:8000",
        mode: "stateless",
        destinations: [{ url: ref, minSeverity: "high" }],
        auth: { mode: "basic", username: "u", password: ref },
        extraHeaders: [{ name: "X-Apprise-Config-ID", value: ref }],
      },
    ],
    [
      "cleared optional fields",
      {
        apiUrl: "http://apprise:8000",
        configKey: ref,
        paperclipBaseUrl: "",
        tagsBySeverity: { low: "", high: " ops " },
      },
    ],
  ])("accepts a saved %s config", (_label, config) => {
    const validate = hostValidator();
    expect(validate(config), JSON.stringify(validate.errors)).toBe(true);
  });

  it("rejects a config without apiUrl", () => {
    expect(hostValidator()({})).toBe(false);
  });
});

describe("host schema compilation", () => {
  it("compiles in the host's Ajv with only the known secret-ref warning", () => {
    const warnings: unknown[] = [];
    const logger = { log() {}, warn: (...args: unknown[]) => warnings.push(args), error() {} };
    const ajv = new Ajv({ allErrors: true, logger });
    addFormats(ajv);
    ajv.addFormat("secret-ref", { validate: () => true });
    ajv.compile(appriseConfigSchema);
    // Host limitation: format on a non-string field (secret refs are objects). See fields.ts.
    const unexpected = warnings.filter(
      (w) => !String(w).includes('missing type "number,string" for keyword "format"'),
    );
    expect(unexpected).toEqual([]);
  });
});
