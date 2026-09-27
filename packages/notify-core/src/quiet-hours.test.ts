import { describe, expect, it } from "vitest";
import { isQuiet, isValidTimezone, localTime, type QuietHours } from "./quiet-hours.js";

const qh = (overrides: Partial<QuietHours> = {}): QuietHours => ({
  enabled: true,
  start: "22:00",
  end: "07:00",
  timezone: "UTC",
  allowUrgent: true,
  ...overrides,
});

const at = (iso: string) => new Date(iso);

describe("localTime", () => {
  it("formats the wall clock in a timezone", () => {
    expect(localTime(at("2026-09-27T12:05:00Z"), "UTC")).toBe("12:05");
    expect(localTime(at("2026-09-27T12:05:00Z"), "America/Sao_Paulo")).toBe("09:05");
    expect(localTime(at("2026-09-27T23:30:00Z"), "Asia/Tokyo")).toBe("08:30");
  });
});

describe("isValidTimezone", () => {
  it("accepts IANA names and rejects the rest", () => {
    expect(isValidTimezone("America/Sao_Paulo")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("Mars/Olympus")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
  });
});

describe("isQuiet", () => {
  it("is never quiet when disabled", () => {
    expect(isQuiet(at("2026-09-27T23:00:00Z"), qh({ enabled: false }))).toBe(false);
  });

  it.each([
    ["21:59", false],
    ["22:00", true],
    ["23:59", true],
    ["00:00", true],
    ["06:59", true],
    ["07:00", false],
    ["12:00", false],
  ])("handles a window crossing midnight at %s", (time, quiet) => {
    expect(isQuiet(at(`2026-09-27T${time}:00Z`), qh())).toBe(quiet);
  });

  it.each([
    ["08:59", false],
    ["09:00", true],
    ["16:59", true],
    ["17:00", false],
  ])("handles a same-day window at %s", (time, quiet) => {
    expect(isQuiet(at(`2026-09-27T${time}:00Z`), qh({ start: "09:00", end: "17:00" }))).toBe(quiet);
  });

  it("uses the configured timezone", () => {
    const saoPaulo = qh({ timezone: "America/Sao_Paulo" });
    expect(isQuiet(at("2026-09-28T01:30:00Z"), saoPaulo)).toBe(true); // 22:30 local
    expect(isQuiet(at("2026-09-27T23:30:00Z"), saoPaulo)).toBe(false); // 20:30 local
  });

  it("follows daylight saving time", () => {
    const newYork = qh({ timezone: "America/New_York", start: "22:00", end: "23:00" });
    expect(isQuiet(at("2026-01-15T03:30:00Z"), newYork)).toBe(true); // 22:30 EST
    expect(isQuiet(at("2026-07-15T02:30:00Z"), newYork)).toBe(true); // 22:30 EDT
    expect(isQuiet(at("2026-07-15T03:30:00Z"), newYork)).toBe(false); // 23:30 EDT
  });
});
