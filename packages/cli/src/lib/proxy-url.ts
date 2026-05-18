/**
 * Utility functions for working with WebSocket proxy URLs.
 * Used by both config-cmd (validation at write time) and
 * daemon/proxy-subscribe (validation + log redaction at runtime).
 */

/**
 * Returns true when `url` is a valid ws:// or wss:// URL.
 * Rejects anything else (http://, ftp://, malformed, etc.).
 */
export function isValidProxyUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'ws:' || parsed.protocol === 'wss:';
}

/**
 * Return a log-safe representation of a WS URL with any embedded
 * username/password replaced by '***'. Prevents credential leakage when
 * users set `ws://token:x@host/` style URLs.
 */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.username || u.password) {
      u.username = '***';
      u.password = '***';
    }
    return u.toString();
  } catch {
    return '(invalid url)';
  }
}
