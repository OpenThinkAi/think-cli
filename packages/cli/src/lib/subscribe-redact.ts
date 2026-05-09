/**
 * Connector-boundary PII strip + per-subscription redact selectors
 * (AGT-066). Two layers, applied in order to the raw payload before it
 * lands as engram content via `insertEngram`:
 *
 *   1. `stripBaselinePii` removes a hard-coded baseline of fields known
 *      to carry PII (commenter email addresses, GPG metadata, IP from
 *      webhook headers). Operates recursively on objects and arrays;
 *      the rule fires by key name (case-insensitive) so connector-
 *      specific aliases like `commenter_email` and `from_email` get the
 *      same treatment as the bare `email`.
 *
 *   2. `applyRedactSelectors` accepts a list of JSONPath selectors
 *      (subset: `$.a.b.c.d` form only — no wildcards, array indices,
 *      or filters) and strips matching fields. Configured per
 *      subscription via `subscriptions.redact[<id>]` in the CLI config;
 *      `think subscribe redact-set <id> <path1> [path2...]` writes them.
 *
 * Both produce a *new* payload — they never mutate the input — so the
 * caller can safely retain the raw value if it has a separate use.
 */

const BASELINE_PII_KEY_PATTERNS: RegExp[] = [
  // Email-bearing fields. Catches `email`, `commenter_email`, `from_email`,
  // `notification_email`, etc. — the rule is "any key whose name suggests
  // it carries an email address."
  /^email$/i,
  /_email$/i,
  /^email_/i,
  // GPG / signing identity metadata. Surfaces in some VCS webhooks.
  /^gpg$/i,
  /^gpg_/i,
  /_gpg$/i,
  // IPs from webhook delivery headers. Connector-side often surfaces
  // these as plain header dicts; the audit (#5) called these out as
  // routinely-leaking PII when payloads land verbatim.
  /^ip$/i,
  /_ip$/i,
  /^ip_/i,
  /^x-real-ip$/i,
  /^x-forwarded-for$/i,
  /^client-ip$/i,
  // Phone numbers. Same three-shape rule as email/gpg/ip: bare, suffix,
  // and prefix. The `^phone_` variant is the load-bearing one — `phone_number`
  // is the canonical field name in Stripe / Twilio / most CRM webhooks, so
  // dropping that prefix would let the most common phone shape leak.
  /^phone$/i,
  /_phone$/i,
  /^phone_/i,
];

function shouldStripKey(key: string): boolean {
  return BASELINE_PII_KEY_PATTERNS.some((re) => re.test(key));
}

/**
 * Returns a deep copy of `value` with any keys matching the baseline PII
 * patterns removed (replaced by `undefined` rather than the literal value).
 * Arrays are walked element-wise; primitives pass through unchanged.
 */
export function stripBaselinePii<T>(value: T): T {
  return walkAndFilter(value, (key) => !shouldStripKey(key)) as T;
}

function walkAndFilter(value: unknown, keep: (key: string) => boolean): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => walkAndFilter(v, keep));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (!keep(k)) continue;
      out[k] = walkAndFilter(v, keep);
    }
    return out;
  }
  return value;
}

/**
 * Parse a JSONPath-subset selector string into an array of path segments.
 * Supports `$.a.b.c` and `a.b.c` (the leading `$.` is optional). Returns
 * `null` if the selector references syntax this implementation doesn't
 * support — callers can warn at config-write time rather than silently
 * ignoring an unmatched path at poll time.
 */
export function parseSelector(selector: string): string[] | null {
  const trimmed = selector.trim();
  if (trimmed.length === 0) return null;
  // Reject unsupported syntax up front (BEFORE the `$.` strip): array
  // indices `[0]`, wildcards `*`, filters `[?(...)]`, recursive descent
  // `..` / `$..`, etc. Doing this before the prefix-strip is what makes
  // `$..email` reject — otherwise the strip would eat the first `.` and
  // leave `.email` looking like a single valid segment.
  if (/[*\[\]?()]/.test(trimmed) || trimmed.includes('..')) return null;

  // Reject the bare root selector `$` — the impl can't safely "redact
  // the entire payload" (would land empty engrams that mask the data
  // flow rather than block it), and the actual clear-all path is
  // `subscribe redact-set <id>` with zero paths. Without this, `$`
  // would silently no-op via the empty-path-array branch downstream,
  // creating a "looks like it worked but didn't" footgun for a feature
  // whose entire purpose is blocking PII leaks.
  if (trimmed === '$') return null;

  let body = trimmed;
  if (body.startsWith('$')) {
    if (!body.startsWith('$.')) return null;
    body = body.slice(2);
  }
  if (body.length === 0) return null;
  return body.split('.').filter((s) => s.length > 0);
}

/**
 * Returns a deep copy of `payload` with the field at each selector path
 * removed. Selectors that don't parse, or reference paths that don't
 * exist, are silent no-ops. The caller should validate selectors at
 * config-write time (`think subscribe redact-set`) so the no-op silence
 * here is only the "path doesn't exist on this particular payload"
 * case, not a typo in the selector.
 */
export function applyRedactSelectors<T>(payload: T, selectors: string[]): T {
  if (!selectors || selectors.length === 0) return payload;
  let working: unknown = deepClone(payload);
  for (const sel of selectors) {
    const path = parseSelector(sel);
    if (path === null || path.length === 0) continue;
    working = removePath(working, path);
  }
  return working as T;
}

function deepClone<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function removePath(value: unknown, path: string[]): unknown {
  if (path.length === 0) return undefined;
  if (value === null || typeof value !== 'object') return value;

  const [head, ...rest] = path;

  if (Array.isArray(value)) {
    // Array path traversal isn't part of the supported subset — array
    // indices were rejected at parse time. Pass through unchanged.
    return value;
  }

  const obj = value as Record<string, unknown>;
  if (!(head in obj)) return value;

  if (rest.length === 0) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k !== head) out[k] = v;
    }
    return out;
  }

  return { ...obj, [head]: removePath(obj[head], rest) };
}
