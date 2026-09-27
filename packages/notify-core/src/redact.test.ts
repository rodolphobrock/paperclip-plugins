import { describe, expect, it } from "vitest";
import { redact } from "./redact.js";

describe("redact", () => {
  it("hides URL credentials", () => {
    expect(redact("GET https://bob:hunter2@ntfy.example.com/x failed")).toBe(
      "GET https://***@ntfy.example.com/x failed",
    );
  });

  it("hides bearer and basic tokens", () => {
    expect(redact("Authorization: Bearer tk_abc.def-123")).toBe("Authorization: Bearer ***");
    expect(redact("basic dXNlcjpwYXNz")).toBe("basic ***");
  });

  it("hides key=value style secrets", () => {
    expect(redact("token=abc123 api_key: xyz password=p@ss secret=s1")).toBe(
      "token=*** api_key: *** password=*** secret=***",
    );
  });

  it("hides long opaque strings", () => {
    expect(redact("key sk-ant-0123456789abcdefghijklmnopqrstuv end")).toBe("key *** end");
    expect(redact(`hash ${"a1".repeat(20)}`)).toBe("hash ***");
  });

  it("keeps ordinary text", () => {
    const text = "Process exited with code 1 after 30s (E_EXIT)";
    expect(redact(text)).toBe(text);
  });
});
