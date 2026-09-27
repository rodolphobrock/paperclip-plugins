import type { SecretRef } from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-empty string field, or undefined. */
export function readString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

/** A finite number field, or undefined. */
export function readNumber(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

export function isSecretRef(value: unknown): value is SecretRef {
  return (
    isRecord(value) && value.type === "secret_ref" && readString(value, "secretId") !== undefined
  );
}
