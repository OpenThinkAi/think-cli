/**
 * Tests for lib/semver-compare.ts (AGT-1324).
 *
 * Pure functions over strings — no filesystem, no npm, no home directory.
 * The cases that matter for `think update` are the prerelease ones: a
 * canary on `3.0.0-rc.1` must read as AHEAD of `latest` = `2.6.1` and
 * BEHIND `3.0.0`.
 */

import { describe, it, expect } from 'vitest';
import { parseVersion, comparePrecedence, prereleaseTag } from '../../src/lib/semver-compare.js';

/** Compare two version strings, failing the test if either does not parse. */
function cmp(a: string, b: string): -1 | 0 | 1 {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new Error(`expected both to parse: ${a} / ${b}`);
  return comparePrecedence(pa, pb);
}

describe('parseVersion', () => {
  it('parses a release version', () => {
    expect(parseVersion('2.6.1')).toEqual({ major: 2, minor: 6, patch: 1, prerelease: [] });
  });

  it('parses a prerelease into its dot-separated identifiers', () => {
    expect(parseVersion('3.0.0-rc.1')).toEqual({ major: 3, minor: 0, patch: 0, prerelease: ['rc', '1'] });
  });

  it('keeps build metadata out of the parse (§10: ignored for precedence)', () => {
    expect(parseVersion('3.0.0+build.5')).toEqual({ major: 3, minor: 0, patch: 0, prerelease: [] });
    expect(parseVersion('3.0.0-rc.1+build.5')?.prerelease).toEqual(['rc', '1']);
  });

  it('tolerates surrounding whitespace, as `npm view` output can carry it', () => {
    expect(parseVersion('  2.6.1\n')?.patch).toBe(1);
  });

  it.each([
    ['', 'empty string'],
    ['   ', 'whitespace only'],
    ['2.6', 'missing patch'],
    ['2.6.1.4', 'four components'],
    ['v2.6.1', 'leading v'],
    ['latest', 'a dist-tag, not a version'],
    ['2.6.x', 'a range-ish string'],
    ['^2.6.1', 'a range'],
    ['2.6.1-', 'empty prerelease'],
    ['2.6.1-rc..1', 'empty prerelease identifier'],
    ['npm ERR! code E404', 'an error line'],
  ])('rejects %j (%s)', (raw) => {
    expect(parseVersion(raw)).toBeNull();
  });

  it('rejects non-strings', () => {
    expect(parseVersion(null)).toBeNull();
    expect(parseVersion(undefined)).toBeNull();
  });
});

describe('comparePrecedence', () => {
  it('orders by major, then minor, then patch', () => {
    expect(cmp('2.6.0', '2.6.1')).toBe(-1);
    expect(cmp('2.6.1', '2.6.0')).toBe(1);
    expect(cmp('2.6.1', '2.6.1')).toBe(0);
    expect(cmp('2.7.0', '3.0.0')).toBe(-1);
    expect(cmp('1.99.99', '2.0.0')).toBe(-1);
  });

  it('compares numeric components numerically, not as strings', () => {
    expect(cmp('2.10.0', '2.9.0')).toBe(1);
    expect(cmp('10.0.0', '9.9.9')).toBe(1);
  });

  it('the exact AGT-1324 case: 3.0.0-rc.1 is ahead of latest 2.6.1', () => {
    expect(cmp('3.0.0-rc.1', '2.6.1')).toBe(1);
  });

  it('a prerelease sorts before its own release (§11.3)', () => {
    expect(cmp('3.0.0-rc.1', '3.0.0')).toBe(-1);
    expect(cmp('3.0.0', '3.0.0-rc.1')).toBe(1);
  });

  it('a shorter prerelease wins when every shared identifier is equal (§11.4.4)', () => {
    expect(cmp('3.0.0-rc', '3.0.0-rc.1')).toBe(-1);
    expect(cmp('3.0.0-rc.1', '3.0.0-rc')).toBe(1);
    expect(cmp('3.0.0-rc.1', '3.0.0-rc.1')).toBe(0);
  });

  it('compares numeric prerelease identifiers numerically', () => {
    expect(cmp('3.0.0-rc.2', '3.0.0-rc.10')).toBe(-1);
    expect(cmp('3.0.0-rc.10', '3.0.0-rc.9')).toBe(1);
  });

  it('a numeric identifier has lower precedence than an alphanumeric one (§11.4.3)', () => {
    expect(cmp('3.0.0-1', '3.0.0-alpha')).toBe(-1);
    expect(cmp('3.0.0-alpha', '3.0.0-1')).toBe(1);
  });

  it('compares alphanumeric identifiers in ASCII order', () => {
    expect(cmp('3.0.0-alpha', '3.0.0-beta')).toBe(-1);
    expect(cmp('3.0.0-beta', '3.0.0-rc')).toBe(-1);
    expect(cmp('3.0.0-rc', '3.0.0-alpha')).toBe(1);
  });

  it('ignores build metadata (§10)', () => {
    expect(cmp('3.0.0+a', '3.0.0+b')).toBe(0);
    expect(cmp('3.0.0-rc.1+a', '3.0.0-rc.1+zzz')).toBe(0);
  });

  it('ignores leading zeros and handles identifiers past MAX_SAFE_INTEGER', () => {
    expect(cmp('3.0.0-rc.01', '3.0.0-rc.1')).toBe(0);
    expect(cmp('3.0.0-rc.9007199254740993', '3.0.0-rc.9007199254740992')).toBe(1);
  });

  it('reproduces the spec example chain end to end (§11.4)', () => {
    const chain = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
    ];
    for (let i = 0; i < chain.length - 1; i++) {
      expect(cmp(chain[i], chain[i + 1])).toBe(-1);
      expect(cmp(chain[i + 1], chain[i])).toBe(1);
    }
    // Sorting by the comparator reproduces the same order.
    const shuffled = [...chain].reverse();
    const sorted = shuffled.sort((a, b) => cmp(a, b));
    expect(sorted).toEqual(chain);
  });
});

describe('prereleaseTag', () => {
  it('derives the dist-tag publish.yml would have used', () => {
    expect(prereleaseTag(parseVersion('3.0.0-rc.1')!)).toBe('rc');
    expect(prereleaseTag(parseVersion('3.0.0-alpha.2')!)).toBe('alpha');
    expect(prereleaseTag(parseVersion('3.0.0-beta')!)).toBe('beta');
  });

  it('is null for a release version', () => {
    expect(prereleaseTag(parseVersion('2.6.1')!)).toBeNull();
  });

  it('is null when the first identifier is numeric — `@1` is not a tag to suggest', () => {
    expect(prereleaseTag(parseVersion('3.0.0-1.2')!)).toBeNull();
  });
});
