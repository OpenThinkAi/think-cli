/**
 * vocabulary-lint.ts — AGT-1315.
 *
 * Fails the build the moment retired vocabulary (AGT-1309's shared
 * `RETIRED_VOCABULARY_TERMS`) or a bare "v2"/"v3" version label resurfaces in
 * shipped documentation or a rendered `think init` template — the same drift
 * AGT-365, AGT-391 and AGT-883 each had to clean up by hand because nothing
 * failed when it reappeared (think-3 design doc, "Regression protection").
 *
 * Scope (AC1): `README.md`, `packages/cli/README.md`, `SECURITY.md`,
 * `docs/**` (excluding `docs/history/`), `packages/cli/docs/**`,
 * `packages/cli/package.json`'s `description`, the root `package.json`'s
 * `description`, and the rendered `think init` templates
 * (`buildBlock(false)`, `buildBlock(true)`, `buildRetroBlock(...)`).
 *
 * "Shipped" means git-TRACKED (r2 fix). The markdown candidates under
 * `docs/**`/`packages/cli/docs/**` are enumerated via `git ls-files`
 * (the repo INDEX — `git add` is enough, a commit is not required), never a
 * raw filesystem walk: a developer's untracked scratch file under `docs/`
 * (e.g. a private draft never meant to ship) must never trip this lint, and
 * a gitignored one certainly must not. The very first real-repo run of this
 * lint (AGT-1315 r1 -> r2) tripped on exactly that — an untracked
 * `docs/remote-mcp-exploration.md` in the primary checkout, invisible to the
 * branch's own worktree, failed `npm test` there even though the branch
 * itself was clean. A plain filesystem walk is used ONLY as a fallback when
 * `git` itself is unavailable (git binary missing, or `root` isn't a git
 * working tree at all) — see `listCandidateMarkdownFiles()`. `README.md`,
 * `packages/cli/README.md` and `SECURITY.md` go through the same
 * tracked-only enumeration. Package.json `description`s and the rendered
 * init templates are NOT git-tracking-gated — they're read straight off
 * disk / rendered in-memory, same as before.
 *
 * NOT in scope, deliberately: `CHANGELOG.md` and `docs/history/` (AC2 — the
 * ONLY two exclusions, see `VOCABULARY_LINT_EXCLUSIONS` below);
 * `packages/cli/SECURITY-serve.md` (lives at `packages/cli/`, not under
 * `packages/cli/docs/`, so it falls outside the AC's scanned set — a real gap
 * the same shape as `audits/2026-04-19-pre-distribution.md`, a dated
 * snapshot also outside it. Both are candidates for a future AC, not this
 * one, which scans exactly what AC1 names.)
 *
 * Exemptions — deliberately narrow (a whole FILE is never exempted; only
 * specific spans or specific hits are):
 *
 *  1. **The generated command-table block.** Between gen-command-table.ts's
 *     own `BEGIN_MARKER`/`END_MARKER` (imported from there, not re-typed
 *     here, so the two can't drift), a table is machine-generated from the
 *     live command registry and may legitimately name a still-live command
 *     whose name happens to contain a retired-sounding substring (the
 *     README's `think migrate-engrams` row). Drift in that block is
 *     gen-command-table's own job (AGT-1311 AC3/AC4), not this lint's.
 *  2. **A hand-written table whose header row names a "Removed" column.**
 *     The README's "Removed, and what to use instead" table, under
 *     "## Upgrading to 3.0", is the one place prose is *supposed* to name
 *     retired commands and flags verbatim so a reader can look up the
 *     replacement. Detected structurally (any markdown table block whose
 *     first `|`-delimited row matches `/\bRemoved\b/i`), not by a fixed
 *     heading string, so it also covers `packages/cli/README.md`'s copy of
 *     the same table without a second special case.
 *  3. **The generic `engram` term, only when embedded in a larger
 *     identifier-like token.** A hit for that term is dropped when the
 *     character immediately before its match is a letter, digit, underscore
 *     or hyphen — i.e. it is not a standalone word. This covers
 *     `validateEngramContent` (a real function name, `lib/sanitize.ts`,
 *     AGT-059 — camelCase, so "Engram" is glued to "Content" on the right
 *     with no boundary there either, and the shared pattern's trailing `\b`
 *     already handles that half), `insertEngram` (the deleted function,
 *     still named in historical prose — camelCase, glued on the left),
 *     `think migrate-engrams` (a still-live command name — hyphen-glued),
 *     and `--legacy-engrams` (a removed flag name mentioned for history —
 *     hyphen-glued). It does NOT cover a bare "engram"/"engrams" used as a
 *     prose noun (preceded by whitespace, a backtick, or a table pipe) —
 *     those are genuine retired-vocabulary hits and were fixed in the docs
 *     themselves rather than exempted (see AGT-1315's PR description for the
 *     list). This exemption is scoped to the `engram` term alone: every
 *     other shared term keeps the doctor check's exact behavior.
 *
 * The ` v2`/` v3` version-label check is intentionally NOT added to the
 * shared `RETIRED_VOCABULARY_TERMS` list that AGT-1309's doctor check also
 * uses — the think-3 design doc's own wording allows a user's *own*
 * instruction file to legitimately say "v2" (e.g. naming a prior design of
 * their own), so that check should not gain this rule. It lives here,
 * local to shipped docs, as a second term applied only by this lint
 * (`VERSION_LABEL_TERM`, appended by `defaultTerms()`).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RETIRED_VOCABULARY_TERMS,
  type RetiredVocabularyTerm,
} from '../src/lib/doctor/retired-vocabulary.js';
import { buildBlock, buildRetroBlock } from '../src/commands/init.js';
import {
  BEGIN_MARKER as COMMANDS_BEGIN_MARKER,
  END_MARKER as COMMANDS_END_MARKER,
} from './gen-command-table.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// packages/cli/scripts -> repo root. `VOCAB_LINT_ROOT` is a test-only seam
// (AGT-1315 r2) so the orchestrator can point a normal `vitest run` of this
// suite at a DIFFERENT checkout (e.g. the primary one, to prove it now
// passes) without editing source. Production `npm test` never sets it.
export const REPO_ROOT = process.env.VOCAB_LINT_ROOT
  ? path.resolve(process.env.VOCAB_LINT_ROOT)
  : path.resolve(__dirname, '..', '..', '..');

/**
 * AC2: the ONLY two exclusions. A trailing `/` marks a directory prefix
 * (everything under it is excluded); anything else is matched as an exact
 * repo-root-relative file path.
 */
export const VOCABULARY_LINT_EXCLUSIONS: readonly string[] = ['CHANGELOG.md', 'docs/history/'];

/**
 * Local to this lint — see the file header for why this is not folded into
 * the shared `RETIRED_VOCABULARY_TERMS` list. Bounded on both sides by
 * neither a word character nor a hyphen, so it fires on a standalone label
 * (`v2 `, `(v2)`, `v3.`) but not a semver-ish `v0.2.0`, a filename/branch
 * slug (`iterative-learning-v2.md`, `retro-locality-v3`), or a longer token
 * (`v20`).
 */
export const VERSION_LABEL_TERM: RetiredVocabularyTerm = {
  term: 'v2/v3 label',
  pattern: /(?<![\w-])v[23](?![\w-])/g,
  replacement: 'drop the version label — user-facing text just says "think" (think-3 decision 5)',
};

/** The shared AGT-1309 list plus this lint's own version-label term. */
export function defaultTerms(): RetiredVocabularyTerm[] {
  return [...RETIRED_VOCABULARY_TERMS, VERSION_LABEL_TERM];
}

export interface Hit {
  file: string;
  line: number;
  text: string;
  replacement: string;
}

/** `file:line: <text>  ->  <replacement>` — the same shape as AGT-1309's doctor check. */
export function formatHit(hit: Hit): string {
  return `${hit.file}:${hit.line}: ${hit.text.trim()}  ->  ${hit.replacement}`;
}

/** A hit is "embedded" when it isn't a standalone word — see exemption 3 above. */
function isEmbeddedInIdentifier(line: string, start: number): boolean {
  return start > 0 && /[A-Za-z0-9_-]/.test(line[start - 1]);
}

/**
 * Marks every line index that exemptions 1 and 2 (above) cover, over one
 * file's lines. Structural: no per-file special-casing.
 */
function computeExemptLines(lines: string[]): Set<number> {
  const exempt = new Set<number>();

  let inCommandsBlock = false;
  let inTable = false;
  let tableIsRemoved = false;
  let tableBuf: number[] = [];

  const flushTable = () => {
    if (tableIsRemoved) for (const idx of tableBuf) exempt.add(idx);
    inTable = false;
    tableIsRemoved = false;
    tableBuf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.includes(COMMANDS_BEGIN_MARKER)) {
      inCommandsBlock = true;
      exempt.add(i);
      continue;
    }
    if (line.includes(COMMANDS_END_MARKER)) {
      inCommandsBlock = false;
      exempt.add(i);
      continue;
    }
    if (inCommandsBlock) {
      exempt.add(i);
      continue;
    }

    const isTableLine = /^\s*\|.*\|\s*$/.test(line);
    if (isTableLine && !inTable) {
      inTable = true;
      tableIsRemoved = /\bRemoved\b/i.test(line); // the table's header row
    }
    if (isTableLine) tableBuf.push(i);
    if (!isTableLine && inTable) flushTable();
  }
  if (inTable) flushTable();

  return exempt;
}

/**
 * Scans one already-read file's content. `lineOffset` shifts reported line
 * numbers — used for a `package.json` `description`, where `content` is
 * just that one extracted line, not the whole file.
 */
export function scanContent(
  file: string,
  content: string,
  terms: RetiredVocabularyTerm[] = defaultTerms(),
  lineOffset = 0,
): Hit[] {
  const lines = content.split('\n');
  const exemptLines = computeExemptLines(lines);
  const hits: Hit[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (exemptLines.has(i)) continue;
    const line = lines[i];

    // Claim ranges so a more specific term and a broader one below it never
    // both report the same characters (mirrors retired-vocabulary.ts).
    const claimed: Array<[number, number]> = [];
    for (const term of terms) {
      term.pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = term.pattern.exec(line)) !== null) {
        const start = m.index;
        const end = start + m[0].length;
        if (m[0].length === 0) term.pattern.lastIndex++; // guard zero-width matches
        if (term.term === 'engram' && isEmbeddedInIdentifier(line, start)) continue;
        if (claimed.some(([s, e]) => start < e && end > s)) continue;
        claimed.push([start, end]);
        hits.push({ file, line: i + 1 + lineOffset, text: line, replacement: term.replacement });
      }
    }
  }

  return hits;
}

function isExcludedRelPath(relPath: string): boolean {
  const norm = relPath.split(path.sep).join('/');
  return VOCABULARY_LINT_EXCLUSIONS.some((ex) => norm === ex || norm.startsWith(ex));
}

/** Recursively collects `.md` files under `dir`, skipping AC2's exclusions. Fallback-path only (see `listCandidateMarkdownFiles`). */
export function walkMarkdownFiles(dir: string, root: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const relPath = path.relative(root, full);
    if (isExcludedRelPath(entry.isDirectory() ? `${relPath}/` : relPath)) continue;

    if (entry.isDirectory()) {
      out.push(...walkMarkdownFiles(full, root));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out.sort();
}

/** The exact AC1 pathspecs passed to `git ls-files` — restricts the index listing to what this lint is allowed to scan. */
const DOC_PATHSPECS = ['README.md', path.join('packages', 'cli', 'README.md'), 'SECURITY.md', 'docs', path.join('packages', 'cli', 'docs')];

/**
 * Enumerates AC1's markdown candidates as git-root-relative, forward-slash
 * paths — TRACKED ONLY (in the index; `git add` suffices, no commit
 * required). Falls back to a plain filesystem walk, scanning untracked
 * files too, ONLY when `git` itself can't answer (missing binary, or `root`
 * isn't a git working tree) — see the file header for why tracked-only is
 * the rule, not the exception.
 */
function listCandidateMarkdownFiles(root: string): string[] {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--', ...DOC_PATHSPECS], {
      cwd: root,
      encoding: 'utf-8',
      // Suppress git's own "not a git repository" noise on stderr — the
      // catch block below prints exactly one clear line instead.
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split('\0')
      .filter((f) => f.length > 0 && f.endsWith('.md'))
      .map((f) => f.split(path.sep).join('/'))
      .sort();
  } catch {
    // Fallback: git unavailable at this root. Untracked/gitignored markdown
    // WILL be scanned here — there is no tracked/untracked distinction to
    // make without git — hence the explicit note.
    console.error(
      'vocabulary-lint: `git ls-files` unavailable at this root (not a git working tree, or git is not installed) — ' +
        'falling back to a filesystem walk. Untracked or gitignored markdown under docs/ will also be scanned.',
    );
    const relPaths: string[] = [];
    for (const rel of ['README.md', path.join('packages', 'cli', 'README.md'), 'SECURITY.md']) {
      if (fs.existsSync(path.join(root, rel))) relPaths.push(rel.split(path.sep).join('/'));
    }
    for (const full of walkMarkdownFiles(path.join(root, 'docs'), root)) {
      relPaths.push(path.relative(root, full).split(path.sep).join('/'));
    }
    for (const full of walkMarkdownFiles(path.join(root, 'packages', 'cli', 'docs'), root)) {
      relPaths.push(path.relative(root, full).split(path.sep).join('/'));
    }
    return relPaths.sort();
  }
}

export interface ScanTarget {
  file: string;
  content: string;
  lineOffset?: number;
}

/** Extracts just the line carrying `"description"`, so a hit reports the real file:line. */
function descriptionTarget(pkgJsonPath: string, root: string): ScanTarget | null {
  if (!fs.existsSync(pkgJsonPath)) return null;
  const content = fs.readFileSync(pkgJsonPath, 'utf-8');
  const lines = content.split('\n');
  const idx = lines.findIndex((l) => /"description"\s*:/.test(l));
  if (idx === -1) return null;
  return { file: path.relative(root, pkgJsonPath), content: lines[idx], lineOffset: idx };
}

/** The three rendered `think init` templates AC1 calls out — never on disk, always in-memory. */
export function renderedInitTemplateTargets(): ScanTarget[] {
  return [
    { file: '<think init --yes template>', content: buildBlock(false) },
    { file: '<think init --minimal template>', content: buildBlock(true) },
    { file: '<think init --retro template>', content: buildRetroBlock('think-cli') },
  ];
}

export interface GatherOptions {
  /** Include the three rendered init templates. Default true; unit tests isolating a planted doc fixture pass false. */
  includeInitTemplates?: boolean;
}

/** Assembles AC1's exact scanned set, rooted at `root` (production default: the real repo root). */
export function gatherTargets(root: string = REPO_ROOT, options: GatherOptions = {}): ScanTarget[] {
  const targets: ScanTarget[] = [];

  for (const relPath of listCandidateMarkdownFiles(root)) {
    if (isExcludedRelPath(relPath)) continue;
    const full = path.join(root, relPath);
    if (fs.existsSync(full)) targets.push({ file: relPath, content: fs.readFileSync(full, 'utf-8') });
  }

  for (const pkg of [path.join(root, 'package.json'), path.join(root, 'packages', 'cli', 'package.json')]) {
    const t = descriptionTarget(pkg, root);
    if (t) targets.push(t);
  }

  if (options.includeInitTemplates ?? true) {
    targets.push(...renderedInitTemplateTargets());
  }

  return targets;
}

/** Runs the full lint over `root` (production default: the real repo root) and returns every hit. */
export function scanForRetiredVocabulary(
  root: string = REPO_ROOT,
  options: GatherOptions & { terms?: RetiredVocabularyTerm[] } = {},
): Hit[] {
  const terms = options.terms ?? defaultTerms();
  const hits: Hit[] = [];
  for (const target of gatherTargets(root, options)) {
    hits.push(...scanContent(target.file, target.content, terms, target.lineOffset ?? 0));
  }
  return hits;
}

function main(): void {
  const hits = scanForRetiredVocabulary();
  if (hits.length === 0) {
    console.log('vocabulary-lint: no retired vocabulary found in shipped docs or the init templates.');
    return;
  }
  console.error(`vocabulary-lint: ${hits.length} retired-vocabulary hit(s):`);
  for (const hit of hits) console.error(formatHit(hit));
  process.exitCode = 1;
}

// Only run when invoked directly (`tsx scripts/vocabulary-lint.ts`), not when
// imported by the test suite for its pure functions.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
