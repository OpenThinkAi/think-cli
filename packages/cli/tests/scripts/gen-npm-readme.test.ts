/**
 * AGT-1313 — packages/cli/README.md (npm's package-page copy) is generated
 * from the repo-root README.md, with relative links rewritten to absolute
 * GitHub URLs. This test fails, with a readable diff, the moment the
 * committed copy drifts from what the generator would produce right now.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  generateNpmReadme,
  GITHUB_BLOB_BASE,
  NPM_README,
  rewriteRelativeLinks,
} from '../../scripts/gen-npm-readme.js';

describe('gen-npm-readme — drift (AGT-1313 AC2)', () => {
  it('packages/cli/README.md matches the generated content', () => {
    const committed = readFileSync(NPM_README, 'utf-8');
    const fresh = generateNpmReadme();

    // A plain `toBe` gives vitest's own unified-diff output on failure,
    // without hand-rolling a differ.
    expect(committed, 'packages/cli/README.md is stale — run `npm run gen:npm-readme`').toBe(fresh);
  });

  it('regenerating is a no-op (idempotent)', () => {
    const once = generateNpmReadme();
    // rewriteRelativeLinks on already-absolute-or-anchor targets must be a
    // no-op, so applying the link rewrite a second time changes nothing.
    expect(rewriteRelativeLinks(once)).toBe(once);
  });

  it('has no unrewritten relative markdown links left', () => {
    const fresh = generateNpmReadme();
    const relativeLinks = [...fresh.matchAll(/\]\(([^)]+)\)/g)]
      .map((m) => m[1])
      .filter((target) => !target.startsWith('#') && !/^[a-z][a-z0-9+.-]*:/i.test(target));

    expect(relativeLinks, `unrewritten relative link(s) found: ${relativeLinks.join(', ')}`).toEqual([]);
  });

  it('carries the generated-file header comment', () => {
    const fresh = generateNpmReadme();
    expect(fresh.startsWith('<!--\n  GENERATED FILE — do not hand-edit.')).toBe(true);
  });
});

describe('rewriteRelativeLinks (AGT-1313 unit)', () => {
  it('rewrites a relative doc link to an absolute GitHub blob URL', () => {
    const input = 'See [docs/architecture.md](docs/architecture.md) for more.';
    expect(rewriteRelativeLinks(input)).toBe(
      `See [docs/architecture.md](${GITHUB_BLOB_BASE}docs/architecture.md) for more.`,
    );
  });

  it('rewrites a packages/cli-relative link (repo-root-relative path)', () => {
    const input = '[serve.md](packages/cli/docs/serve.md)';
    expect(rewriteRelativeLinks(input)).toBe(`[serve.md](${GITHUB_BLOB_BASE}packages/cli/docs/serve.md)`);
  });

  it('leaves an anchor-only link untouched', () => {
    const input = 'See [Upgrading to 3.0](#upgrading-to-30).';
    expect(rewriteRelativeLinks(input)).toBe(input);
  });

  it('leaves an already-absolute https link untouched', () => {
    const input = '[Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)';
    expect(rewriteRelativeLinks(input)).toBe(input);
  });

  it('leaves an absolute mailto link untouched', () => {
    const input = '[contact](mailto:hello@example.com)';
    expect(rewriteRelativeLinks(input)).toBe(input);
  });
});
