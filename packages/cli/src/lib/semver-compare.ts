/**
 * SemVer 2.0.0 precedence, just enough of it for `think update` (AGT-1324).
 *
 * `think update` used to treat "installed !== the `latest` dist-tag" as
 * "behind", so a canary machine on `3.0.0-rc.1` was *downgraded* to `2.6.1`
 * on its next run — and hivedb's managed block runs `think update` at the
 * start of every agent session, so the rc canary undid itself within
 * minutes. Telling "behind" from "ahead on a prerelease tag" needs real
 * §11 precedence, not string equality.
 *
 * In-tree rather than the `semver` package: `semver` is present in this
 * repo's lockfile only as a transitive dependency of `sharp` and
 * `global-agent`, so depending on it here would mean importing a package we
 * do not declare and that npm is free to stop hoisting. Forty lines of
 * comparison is cheaper than a new runtime dependency on the publish path.
 *
 * Not a general-purpose semver library: no ranges, no coercion, no `v`
 * prefix. Build metadata is parsed and then ignored, per §10 ("build
 * metadata MUST be ignored when determining version precedence").
 *
 * (`lib/update-check.ts` has its own naive `isNewer`. It is left alone
 * deliberately: it only decides whether to print an "update available"
 * nag, and it already declines to nag from a prerelease install.)
 */

/** A version string parsed into its precedence-bearing parts. */
export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated prerelease identifiers; empty for a release version. */
  prerelease: string[];
}

// Strict `X.Y.Z[-prerelease][+build]`. Leading zeros are tolerated in the
// numeric core and in numeric prerelease identifiers (semver.org forbids
// them; npm would never publish one) because rejecting a version we can
// still order unambiguously would only push the caller onto its
// "unparsable" path.
const SEMVER_RE =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * Parse a version string, or return null when it is empty, malformed, or
 * anything other than a bare `X.Y.Z[-prerelease][+build]`. Callers decide
 * what an unparsable version means — see `commands/update.ts`, which
 * deliberately treats an unparsable *installed* version and an unparsable
 * *registry* version differently.
 */
export function parseVersion(raw: string | null | undefined): ParsedVersion | null {
  if (typeof raw !== 'string') return null;
  const m = SEMVER_RE.exec(raw.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : [],
  };
}

/**
 * Compare two prerelease identifiers (§11.4.1-3): numeric identifiers
 * numerically, alphanumeric ones by ASCII order, and a numeric identifier
 * always has lower precedence than an alphanumeric one.
 */
function compareIdentifiers(a: string, b: string): -1 | 0 | 1 {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) {
    // Compared as digit strings (length first, then lexically) rather than
    // via Number(), so identifiers past Number.MAX_SAFE_INTEGER still order
    // correctly and leading zeros do not change the value.
    const x = a.replace(/^0+(?=\d)/, '');
    const y = b.replace(/^0+(?=\d)/, '');
    if (x.length !== y.length) return x.length < y.length ? -1 : 1;
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * SemVer §11 precedence: -1 when `a` sorts before `b`, 1 when after, 0 when
 * they have equal precedence. A prerelease sorts *before* its own release
 * (`3.0.0-rc.1` < `3.0.0`), and when every shared identifier is equal the
 * shorter prerelease wins (`3.0.0-rc` < `3.0.0-rc.1`).
 */
export function comparePrecedence(a: ParsedVersion, b: ParsedVersion): -1 | 0 | 1 {
  for (const field of ['major', 'minor', 'patch'] as const) {
    if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1; // a release outranks any prerelease
  if (b.prerelease.length === 0) return -1;
  const shared = Math.min(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < shared; i++) {
    const cmp = compareIdentifiers(a.prerelease[i], b.prerelease[i]);
    if (cmp !== 0) return cmp;
  }
  if (a.prerelease.length === b.prerelease.length) return 0;
  return a.prerelease.length < b.prerelease.length ? -1 : 1;
}

/**
 * The npm dist-tag a prerelease version appears to track — `rc` for
 * `3.0.0-rc.1` — derived exactly as `.github/workflows/publish.yml` derives
 * it when publishing (`${VERSION#*-}` truncated at the first dot).
 *
 * Null for a release version, and also for a prerelease whose first
 * identifier is numeric (`3.0.0-1`): publish.yml would have tagged that
 * `1`, which is not a tag anyone should be told to install.
 */
export function prereleaseTag(v: ParsedVersion): string | null {
  const first = v.prerelease[0];
  if (!first || /^\d+$/.test(first)) return null;
  return first;
}
