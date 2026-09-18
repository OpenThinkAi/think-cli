/**
 * Tests for vocabulary-lint.ts — AGT-1315.
 *
 * AC3 (live scan, must pass): scans the actual shipped surfaces named in
 * AC1 — README.md, packages/cli/README.md, SECURITY.md, docs/** (excluding
 * docs/history/), packages/cli/docs/**, both package.json `description`
 * fields, and the three rendered `think init` templates — and asserts zero
 * hits on the real, current tree.
 *
 * The rest are unit tests of the scanner itself against planted fixtures in
 * a temp dir (never the real repo), covering exactly the cases AGT-1315
 * calls out: a plain hit, a hit inside a code identifier (no hit),
 * `curate-retros` (no hit), a `v2` label (hit) vs `v20` (no hit), an exempt
 * "Removed" table span (no hit), the generated command-table span (no hit),
 * that the exclusion list is exactly the two AC2 entries, and (r2) that
 * scanning is git-TRACKED-only — an untracked docs/*.md is never scanned,
 * `git add` (no commit needed) is what makes it count, and a non-git root
 * falls back to scanning everything on disk.
 *
 * No THINK_HOME / real-home interaction: every fixture lives under
 * `os.tmpdir()` (AGT-1322), and `gatherTargets`/`scanForRetiredVocabulary`
 * only ever read the paths they're explicitly given.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  scanForRetiredVocabulary,
  scanContent,
  gatherTargets,
  formatHit,
  defaultTerms,
  VOCABULARY_LINT_EXCLUSIONS,
  VERSION_LABEL_TERM,
  REPO_ROOT,
} from '../../scripts/vocabulary-lint.js';
import {
  BEGIN_MARKER as COMMANDS_BEGIN_MARKER,
  END_MARKER as COMMANDS_END_MARKER,
} from '../../scripts/gen-command-table.js';

describe('vocabulary-lint — live scan over the real tree (AGT-1315 AC1/AC3)', () => {
  it('finds zero retired-vocabulary or v2/v3-label hits in the shipped docs + init templates', () => {
    const hits = scanForRetiredVocabulary(REPO_ROOT);
    const rendered = hits.map(formatHit).join('\n');
    expect(hits, `retired-vocabulary hit(s) found:\n${rendered}`).toEqual([]);
  });

  it('the scanned set is non-trivial (sanity — a broken gatherTargets() would silently pass with zero targets)', () => {
    const targets = gatherTargets(REPO_ROOT);
    // README.md, packages/cli/README.md, SECURITY.md, >=1 docs/** file,
    // >=1 packages/cli/docs/** file, 2 package.json descriptions, 3 init
    // templates — comfortably more than 10 regardless of doc-count drift.
    expect(targets.length).toBeGreaterThan(10);
  });
});

describe('vocabulary-lint — exclusion list (AGT-1315 AC2)', () => {
  it('is exactly the two named exclusions, nothing else', () => {
    expect(VOCABULARY_LINT_EXCLUSIONS).toEqual(['CHANGELOG.md', 'docs/history/']);
  });
});

describe('vocabulary-lint — formatHit (AGT-1309-style output)', () => {
  it('renders as `file:line: <text>  ->  <replacement>`', () => {
    const hit = { file: 'docs/foo.md', line: 12, text: '  use --decision here  ', replacement: 'think event "Decided …"' };
    expect(formatHit(hit)).toBe('docs/foo.md:12: use --decision here  ->  think event "Decided …"');
  });
});

describe('vocabulary-lint — scanContent unit tests on planted content (AGT-1315)', () => {
  it('a plain hit is reported at the right file:line', () => {
    const hits = scanContent('docs/foo.md', 'line one\nUse think sync --decision "why" to log it.\n');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ file: 'docs/foo.md', line: 2, replacement: 'think event "Decided …"' });
  });

  it('a hit inside a code identifier is NOT reported (validateEngramContent, insertEngram)', () => {
    const hits = scanContent(
      'SECURITY.md',
      '`validateEngramContent` runs at every write edge.\nHistorically `insertEngram` did the write.\n',
    );
    expect(hits).toEqual([]);
  });

  it('a hit inside a hyphenated compound identifier is NOT reported (think migrate-engrams, --legacy-engrams)', () => {
    const hits = scanContent(
      'docs/architecture.md',
      'Run `think migrate-engrams` to rescue stranded rows.\nThe removed `--legacy-engrams` flag used to bypass this.\n',
    );
    expect(hits).toEqual([]);
  });

  it('a bare "engram" prose word IS reported (not embedded in any identifier)', () => {
    const hits = scanContent('docs/architecture.md', 'The engram write tier is gone.\n');
    expect(hits).toHaveLength(1);
    expect(hits[0].replacement).toBe('memory/event');
  });

  it('`think curate-retros` never matches `think curate`', () => {
    const hits = scanContent('README.md', 'The daemon runs `think curate-retros` on a schedule.\n');
    expect(hits).toEqual([]);
  });

  it('a `v2` label is a hit', () => {
    const hits = scanContent('docs/x.md', 'v2 chose Option B.\n');
    expect(hits).toHaveLength(1);
    expect(hits[0].replacement).toBe(VERSION_LABEL_TERM.replacement);
  });

  it('a `v3` label in parens is a hit', () => {
    const hits = scanContent('docs/x.md', 'Locked in the redesign (v3).\n');
    expect(hits).toHaveLength(1);
  });

  it('`v20` is NOT a hit (longer token, not the label)', () => {
    const hits = scanContent('docs/x.md', 'Supports up to v20 of the format.\n');
    expect(hits).toEqual([]);
  });

  it('`v0.2.0` (semver) is NOT a hit', () => {
    const hits = scanContent('docs/x.md', 'v0.2.0 retired the storage role.\n');
    expect(hits).toEqual([]);
  });

  it('a `v2`/`v3` inside a filename or branch slug is NOT a hit (hyphen-joined, not a standalone label)', () => {
    const hits = scanContent(
      'docs/x.md',
      'See `docs/history/iterative-learning-v2.md` and branch `feat/retro-locality-v3`.\n',
    );
    expect(hits).toEqual([]);
  });

  it('an exempt "Removed" table span reports no hits, even for multiple retired terms', () => {
    const content = [
      '## Upgrading to 3.0',
      '',
      '| Removed | Use instead |',
      '| --- | --- |',
      '| `think sync -d` / `--decision` | `think event "Decided …"` |',
      '| `think curate` | nothing — gone. |',
      '| `think monitor` | `think recall` |',
      '',
      'Prose after the table still gets scanned: --decision here should hit.',
      '',
    ].join('\n');
    const hits = scanContent('README.md', content);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(9); // the prose line after the table, 1-indexed
  });

  it('a table WITHOUT a "Removed" header is NOT exempt — the exemption is structural, not "any table"', () => {
    const content = ['| Command | Notes |', '| --- | --- |', '| `--decision` | still flagged |', ''].join('\n');
    const hits = scanContent('README.md', content);
    expect(hits).toHaveLength(1);
  });

  it('the generated command-table block is exempt end to end (marker-delimited)', () => {
    const content = [
      '## All commands',
      '',
      COMMANDS_BEGIN_MARKER,
      '| Command | Args | Description |',
      '| --- | --- | --- |',
      '| `think migrate-engrams` |  | Re-submit stranded engrams |',
      COMMANDS_END_MARKER,
      '',
      'Outside the block, engram still hits.',
      '',
    ].join('\n');
    const hits = scanContent('README.md', content);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(9);
  });

  it('claims overlapping ranges once: `--engrams` beats the generic `engram` on the same span', () => {
    const hits = scanContent('docs/x.md', 'recall --engrams for raw rows\n');
    expect(hits).toHaveLength(1);
    expect(hits[0].replacement).toBe('removed (recall searches memories)');
  });
});

describe('vocabulary-lint — gatherTargets()/scanForRetiredVocabulary() over a planted temp-dir fixture (AGT-1315)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'think-vocab-lint-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('scans README.md, SECURITY.md and docs/** at the given root', () => {
    writeFileSync(join(root, 'README.md'), 'Use --decision to log a decision.\n', 'utf-8');
    writeFileSync(join(root, 'SECURITY.md'), 'engrams are untrusted.\n', 'utf-8');
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'x.md'), 'think monitor daily.\n', 'utf-8');

    const hits = scanForRetiredVocabulary(root, { includeInitTemplates: false });
    expect(hits).toHaveLength(3);
    expect(hits.map((h) => h.file).sort()).toEqual(['README.md', 'SECURITY.md', 'docs/x.md']);
  });

  it('scans packages/cli/README.md and packages/cli/docs/**', () => {
    mkdirSync(join(root, 'packages', 'cli', 'docs'), { recursive: true });
    writeFileSync(join(root, 'packages', 'cli', 'README.md'), '--episode is gone.\n', 'utf-8');
    writeFileSync(join(root, 'packages', 'cli', 'docs', 'serve.md'), 'think log this.\n', 'utf-8');

    const hits = scanForRetiredVocabulary(root, { includeInitTemplates: false });
    expect(hits.map((h) => h.file).sort()).toEqual(['packages/cli/README.md', 'packages/cli/docs/serve.md']);
  });

  it('scans only the `description` field of each package.json, at the real line', () => {
    mkdirSync(join(root, 'packages', 'cli'), { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      '{\n  "name": "x",\n  "description": "uses --decision internally",\n  "version": "1.0.0"\n}\n',
      'utf-8',
    );
    writeFileSync(join(root, 'packages', 'cli', 'package.json'), '{\n  "description": "no retired terms here"\n}\n', 'utf-8');

    const hits = scanForRetiredVocabulary(root, { includeInitTemplates: false });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ file: 'package.json', line: 3 });
  });

  it('excludes CHANGELOG.md and docs/history/** — the ONLY two exclusions', () => {
    writeFileSync(join(root, 'CHANGELOG.md'), 'Removed --decision and think curate.\n', 'utf-8');
    mkdirSync(join(root, 'docs', 'history'), { recursive: true });
    writeFileSync(join(root, 'docs', 'history', 'old.md'), 'think monitor was here. engram everywhere.\n', 'utf-8');
    // A sibling docs file, NOT under history/, still gets scanned — proves
    // the exclusion is scoped to the history/ prefix, not all of docs/.
    writeFileSync(join(root, 'docs', 'current.md'), 'think monitor still teaches a dead command.\n', 'utf-8');

    const hits = scanForRetiredVocabulary(root, { includeInitTemplates: false });
    expect(hits).toHaveLength(1);
    expect(hits[0].file).toBe('docs/current.md');
  });

  it('includes the three rendered init templates by default, and they are clean on the real tree', () => {
    const withTemplates = scanForRetiredVocabulary(root); // includeInitTemplates defaults true
    // Nothing else exists at `root`, so any hit here can only come from the
    // rendered templates — proving they were included — and there should be
    // none, since the real init.ts templates carry no retired vocabulary.
    expect(withTemplates).toEqual([]);
  });

  it('a missing production file (no README.md, no SECURITY.md, no docs/) is silently skipped, not an error', () => {
    expect(() => scanForRetiredVocabulary(root, { includeInitTemplates: false })).not.toThrow();
    expect(scanForRetiredVocabulary(root, { includeInitTemplates: false })).toEqual([]);
  });
});

describe('vocabulary-lint — term list is imported, not copied (AGT-1315 shares AGT-1309)', () => {
  it('defaultTerms() = the shared RETIRED_VOCABULARY_TERMS plus exactly one local version-label term', () => {
    const terms = defaultTerms();
    expect(terms[terms.length - 1]).toBe(VERSION_LABEL_TERM);
    expect(terms.some((t) => t.term === 'engram')).toBe(true);
    expect(terms.some((t) => t.term === '--decision')).toBe(true);
  });
});

/**
 * AGT-1315 r2 — "shipped" means git-TRACKED. The r1 lint walked docs/** on
 * disk, so an untracked scratch file (a developer's private draft, never
 * meant to ship — the real-world case was `docs/remote-mcp-exploration.md`
 * in the primary checkout) tripped `npm test` there even though the branch
 * itself was clean, and the branch's own worktree never had the file so
 * couldn't see the failure coming. These tests drive a REAL temp git repo
 * (never the actual project repo) to prove: untracked docs markdown is
 * never scanned, `git add` (no commit needed) is what makes it count as
 * tracked, and a root that isn't a git working tree at all still falls back
 * to scanning everything (documented, not silent).
 */
describe('vocabulary-lint — tracked-only scanning (AGT-1315 r2)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'think-vocab-lint-git-'));
    execFileSync('git', ['init', '-q'], { cwd: root });
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'a.md'), 'nothing retired here.\n', 'utf-8');
    execFileSync('git', ['add', 'docs/a.md'], { cwd: root });
    execFileSync(
      'git',
      ['-c', 'user.name=think-cli-tests', '-c', 'user.email=tests@think-cli.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init'],
      { cwd: root },
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('an untracked docs/draft.md is NOT scanned, even with retired vocabulary in it', () => {
    writeFileSync(join(root, 'docs', 'draft.md'), 'an engram is stranded here.\n', 'utf-8');

    const hits = scanForRetiredVocabulary(root, { includeInitTemplates: false });
    expect(hits).toEqual([]);
  });

  it('the same file IS scanned once `git add`ed — tracked means "in the index", no commit required', () => {
    writeFileSync(join(root, 'docs', 'draft.md'), 'an engram is stranded here.\n', 'utf-8');
    execFileSync('git', ['add', 'docs/draft.md'], { cwd: root });

    const hits = scanForRetiredVocabulary(root, { includeInitTemplates: false });
    expect(hits).toHaveLength(1);
    expect(hits[0].file).toBe('docs/draft.md');
  });

  it('an untracked README.md at the repo root is also NOT scanned', () => {
    writeFileSync(join(root, 'README.md'), 'Use --decision to log a decision.\n', 'utf-8');

    const hits = scanForRetiredVocabulary(root, { includeInitTemplates: false });
    expect(hits).toEqual([]);
  });

  it('a committed docs/history/old.md stays excluded even though it is tracked', () => {
    mkdirSync(join(root, 'docs', 'history'), { recursive: true });
    writeFileSync(join(root, 'docs', 'history', 'old.md'), 'think monitor was here.\n', 'utf-8');
    execFileSync('git', ['add', 'docs/history/old.md'], { cwd: root });

    const hits = scanForRetiredVocabulary(root, { includeInitTemplates: false });
    expect(hits).toEqual([]);
  });
});

describe('vocabulary-lint — fallback when `root` is not a git working tree at all (AGT-1315 r2)', () => {
  it('falls back to scanning everything on disk, tracked or not, when git is unavailable', () => {
    const root = mkdtempSync(join(tmpdir(), 'think-vocab-lint-nogit-'));
    try {
      mkdirSync(join(root, 'docs'), { recursive: true });
      writeFileSync(join(root, 'docs', 'x.md'), 'think monitor daily.\n', 'utf-8');

      // No `git init` at all — listCandidateMarkdownFiles() must still find
      // the file via its filesystem-walk fallback, not silently return [].
      const hits = scanForRetiredVocabulary(root, { includeInitTemplates: false });
      expect(hits).toHaveLength(1);
      expect(hits[0].file).toBe('docs/x.md');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
