const OPAQUE_MIN_LENGTH = 32;

/**
 * Best-effort removal of credentials from free text (error messages, adapter output)
 * before it reaches logs or an external notification service (spec decision 13).
 */
export function redact(text: string): string {
  return (
    text
      // Credentials inside URLs: scheme://user:pass@host
      .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@")
      // Authorization schemes
      .replace(/\b(bearer|basic)\s+[^\s,;]+/gi, "$1 ***")
      // key=value / key: value pairs with secret-looking names
      .replace(
        /\b([a-z_-]*(?:token|key|secret|password|passwd|pwd)[a-z_-]*)(\s*[=:]\s*)[^\s,;&]+/gi,
        "$1$2***",
      )
      // Long opaque strings mixing letters and digits (API keys, hashes)
      .replace(/[a-z0-9_-]+/gi, (word) =>
        word.length >= OPAQUE_MIN_LENGTH && /\d/.test(word) && /[a-z]/i.test(word) ? "***" : word,
      )
  );
}
