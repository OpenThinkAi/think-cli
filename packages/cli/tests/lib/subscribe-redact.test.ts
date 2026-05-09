import { describe, it, expect } from 'vitest';
import {
  stripBaselinePii,
  applyRedactSelectors,
  parseSelector,
} from '../../src/lib/subscribe-redact.js';

// AGT-066: connector-boundary PII strip + JSONPath-subset redact selectors.
// The two layers run in order during `think subscribe poll` before the
// payload lands as engram content. Both must be deep-copy producers — the
// caller may keep a reference to the raw payload for other uses.
describe('stripBaselinePii — baseline PII strip (AGT-066 AC #2)', () => {
  it('removes top-level email, gpg, ip, phone fields', () => {
    const payload = { id: 1, email: 'a@example.com', gpg: 'KEY', ip: '203.0.113.1', phone: '555' };
    const stripped = stripBaselinePii(payload);
    expect(stripped).toEqual({ id: 1 });
  });

  it('removes nested *_email / *_ip / *_gpg / *_phone fields', () => {
    const payload = {
      user: {
        login: 'octocat',
        commenter_email: 'octocat@example.com',
        signing_gpg: 'KEY',
        last_phone: '555',
      },
      headers: { 'x-real-ip': '203.0.113.1', 'x-forwarded-for': '198.51.100.5', 'content-type': 'application/json' },
    };
    const stripped = stripBaselinePii(payload) as Record<string, Record<string, unknown>>;
    expect(stripped.user).toEqual({ login: 'octocat' });
    expect(stripped.headers).toEqual({ 'content-type': 'application/json' });
  });

  it('removes phone_*-prefixed fields (Stripe / Twilio / CRM canonical shapes)', () => {
    // Round 2 fix: the original phone pattern was asymmetric vs. email/gpg/ip.
    // Lock in symmetry so `phone_number`, `phone_primary`, `phone_country`,
    // `phone_mobile` — the most common real-world phone field shapes —
    // get stripped alongside `phone` and `*_phone`.
    const payload = {
      contact: {
        phone_number: '+1-555-0100',
        phone_primary: '+1-555-0101',
        phone_country: 'US',
        phone_mobile: '+1-555-0102',
      },
    };
    const stripped = stripBaselinePii(payload) as { contact: Record<string, unknown> };
    expect(stripped.contact).toEqual({});
  });

  it('walks arrays element-wise', () => {
    const payload = {
      reviewers: [
        { login: 'a', email: 'a@example.com' },
        { login: 'b', email: 'b@example.com' },
      ],
    };
    const stripped = stripBaselinePii(payload) as { reviewers: Array<{ login: string; email?: string }> };
    expect(stripped.reviewers).toEqual([{ login: 'a' }, { login: 'b' }]);
  });

  it('does not mutate the input', () => {
    const payload = { email: 'a@example.com', login: 'octocat' };
    const before = JSON.stringify(payload);
    stripBaselinePii(payload);
    expect(JSON.stringify(payload)).toBe(before);
  });

  it('passes primitives and strings through unchanged', () => {
    expect(stripBaselinePii('a string event')).toBe('a string event');
    expect(stripBaselinePii(42)).toBe(42);
    expect(stripBaselinePii(null)).toBe(null);
  });

  it('matches case-insensitively', () => {
    // Hyphenated header names are the standard shape (`X-Forwarded-For`,
    // not `X_Forwarded_For`); the rule is case-insensitive on the
    // standard form, not separator-flexible on non-standard ones.
    const payload = { Email: 'a@example.com', 'X-Forwarded-For': '203.0.113.1', PHONE: '555' };
    const stripped = stripBaselinePii(payload);
    expect(stripped).toEqual({});
  });
});

describe('parseSelector — JSONPath-subset parser (AGT-066 AC #3)', () => {
  it.each([
    ['$.user.email', ['user', 'email']],
    ['user.email', ['user', 'email']],
    ['$.body.repository.private_url', ['body', 'repository', 'private_url']],
    ['user', ['user']],
  ])('accepts %s and parses to %o', (input, expected) => {
    expect(parseSelector(input)).toEqual(expected);
  });

  it.each([
    '$.users[0].email',          // array index
    '$..email',                   // recursive descent
    '$.users[?(@.id==1)].email',  // filter
    '$.users[*].email',           // wildcard
    '',                            // empty
    '   ',                         // whitespace only
    '$',                           // bare root — would be a footgun (silent no-op masquerading as clear-all)
  ])('rejects unsupported syntax: %s', (input) => {
    expect(parseSelector(input)).toBeNull();
  });
});

describe('applyRedactSelectors — per-subscription redact (AGT-066 AC #3)', () => {
  it('removes a top-level field', () => {
    const payload = { id: 1, secret: 'sssh', other: 'ok' };
    const redacted = applyRedactSelectors(payload, ['$.secret']);
    expect(redacted).toEqual({ id: 1, other: 'ok' });
  });

  it('removes a nested field', () => {
    const payload = { user: { login: 'octocat', token: 'gho_xxx' } };
    const redacted = applyRedactSelectors(payload, ['$.user.token']) as { user: Record<string, unknown> };
    expect(redacted.user).toEqual({ login: 'octocat' });
  });

  it('handles multiple selectors', () => {
    const payload = { a: 1, b: 2, c: 3 };
    const redacted = applyRedactSelectors(payload, ['$.a', '$.c']);
    expect(redacted).toEqual({ b: 2 });
  });

  it('no-ops for selectors that do not match the payload', () => {
    const payload = { id: 1 };
    const redacted = applyRedactSelectors(payload, ['$.notpresent']);
    expect(redacted).toEqual({ id: 1 });
  });

  it('no-ops on empty selector list', () => {
    const payload = { id: 1 };
    expect(applyRedactSelectors(payload, [])).toEqual({ id: 1 });
  });

  it('does not mutate the input', () => {
    const payload = { secret: 'sssh', other: 'ok' };
    const before = JSON.stringify(payload);
    applyRedactSelectors(payload, ['$.secret']);
    expect(JSON.stringify(payload)).toBe(before);
  });

  it('representative GitHub webhook payload — strips baseline + redact in tandem (AC #3)', () => {
    // Mirrors the AC's worked example: a GitHub-style payload with PII
    // fields the baseline strip catches, plus a private repo URL the user
    // explicitly redacts via selector.
    const payload = {
      action: 'opened',
      pull_request: {
        title: 'Fix the auth bug',
        user: { login: 'octocat', email: 'octocat@example.com' },
      },
      repository: {
        name: 'open-think',
        private_url: 'https://internal.example/things',
      },
      headers: { 'x-real-ip': '203.0.113.1' },
    };

    const stripped = stripBaselinePii(payload);
    const redacted = applyRedactSelectors(stripped, ['$.repository.private_url']);
    const json = JSON.stringify(redacted);

    expect(json).not.toContain('octocat@example.com');     // baseline strip
    expect(json).not.toContain('203.0.113.1');             // baseline strip
    expect(json).not.toContain('internal.example/things'); // redact selector
    expect(json).toContain('Fix the auth bug');            // unrelated content survives
    expect(json).toContain('open-think');                  // unrelated content survives
  });
});
