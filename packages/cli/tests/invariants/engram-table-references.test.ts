/**
 * Invariant: nothing under `packages/cli/src` reads or writes the `engrams`
 * table except the schema/migration file and the AGT-1302 rescue module —
 * AGT-1304.
 *
 * AGT-293 already tried "engrams are gone" once and it didn't stick, because
 * nothing enforced it — the tier survived, half-dead, until AGT-1303 deleted
 * the rest of it. This test is the enforcement: it scans every `.ts` file
 * under `src` for the shapes that read or write the `engrams` table and fails
 * (naming every offending `file:line`, not just the first) on anything found
 * outside an explicit two-entry allow-list:
 *
 *   - `db/engrams.ts`            — the table's schema + migrations live here.
 *   - `lib/engram-migration.ts`  — the AGT-1302 rescue module; its own header
 *     comment states the same invariant this test enforces and says "if you
 *     need engram data elsewhere, export a function from here" — i.e. this
 *     allow-list is meant to stay exactly two entries, not grow.
 *
 * Detected tokens (AC1 names four; two more are added and documented below):
 *   - `insertEngram`        the write-path function name. Exact identifier,
 *                            case-sensitive — it's camelCase, not SQL.
 *   - `FROM engrams`        SQL read. Case-insensitive: SQLite doesn't care
 *                            about keyword case and neither should the guard.
 *   - `INTO engrams`        SQL write (`INSERT INTO engrams`). Case-insensitive.
 *   - `engrams_fts`         the FTS shadow table. Case-insensitive.
 *   - `UPDATE engrams`      SQL write. Not one of the AC's four named tokens,
 *                            but the same shape as `FROM`/`INTO`, and the
 *                            allowed migration module contains exactly this
 *                            statement (`UPDATE engrams SET evaluated_at = ...`)
 *                            — a scanner that didn't recognize it couldn't
 *                            prove AC2 (the allow-list is exhaustive for what
 *                            the allowed files actually do), and dropping it
 *                            would leave a reintroduced `UPDATE engrams`
 *                            elsewhere undetected. Added deliberately, not a
 *                            silent widening.
 *   - `DELETE FROM engrams` SQL write. Added for the same reason as `UPDATE`
 *                            — a scanner that catches reads and inserts but
 *                            not deletes/updates isn't actually the invariant
 *                            the ticket asks for.
 *
 * Table-name tokens use a negative lookahead for an immediately-following
 * `/`, so `.think/engrams/` — the legacy on-disk directory the v2 tier lived
 * in, unrelated to the SQL table — never false-positives (see
 * `lib/paths.ts`'s db-directory-consolidation prompt, which talks about
 * migrating *files* "from engrams/ into index/"; that sentence contains the
 * literal substring "from engrams" but is not a query). A real table
 * reference is never followed by a path separator.
 *
 * Comments (`//...` and `/* ... *\/`, including JSDoc) are stripped before
 * scanning, matching the AC's "comments/docs that mention the word 'engrams'
 * in prose are not hits" — a doc comment that mentions the historical
 * `insertEngram` name while explaining *why* a value is redacted before it
 * would have reached that path (see `lib/subscribe-redact.ts`'s header) is
 * documentation, not a live reference to the table.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, relative, extname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Resolved relative to *this file*, not process.cwd() — so the scan finds
// packages/cli/src whether vitest is invoked from the repo root or from
// packages/cli itself (`npm test` at the repo root delegates to the latter).
const CLI_SRC = fileURLToPath(new URL('../../src', import.meta.url));

/**
 * The only two files allowed to contain the tokens below. Paths are relative
 * to `packages/cli/src`, forward-slashed. Keep this list at exactly these
 * two entries — see the module doc comment above.
 */
const ALLOWED_ENGRAM_TABLE_REFERENCES = ['db/engrams.ts', 'lib/engram-migration.ts'];

interface EngramTableReference {
  /** Path relative to the scanned root, forward-slashed. */
  file: string;
  /** 1-based line number in the original (non-comment-stripped) source. */
  line: number;
  /** The offending line, trimmed, for the failure message. */
  text: string;
}

// Table-name forms: word-boundaried, case-insensitive, and never followed by
// `/` (which would make it a directory path, not a table reference).
const TOKEN_PATTERNS: RegExp[] = [
  /\binsertEngram\b/,
  /\bFROM\s+engrams\b(?!\/)/i,
  /\bINTO\s+engrams\b(?!\/)/i,
  /\bUPDATE\s+engrams\b(?!\/)/i,
  /\bDELETE\s+FROM\s+engrams\b(?!\/)/i,
  /\bengrams_fts\b/i,
];

/**
 * Blanks out `//` and `/* *\/` comments (including JSDoc) while preserving
 * line count and column positions, so prose mentions of a token don't count
 * as hits and line numbers reported for real hits stay accurate.
 */
function stripComments(source: string): string {
  let out = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  out = out.replace(/\/\/.*$/gm, (m) => ' '.repeat(m.length));
  return out;
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.isFile() && extname(entry.name) === '.ts') {
      // Skip test files that happen to live under src (none do today, but
      // the scanner shouldn't start flagging its own future test fixtures).
      if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.spec.ts')) continue;
      out.push(full);
    }
  }
  return out;
}

/**
 * Scans every `.ts` file under `root` (recursively, skipping
 * `node_modules`, `dist`, and `*.test.ts`/`*.spec.ts`) for the engram-table
 * tokens and returns every hit whose path relative to `root` is not in
 * `allowlist`.
 */
function scanForEngramTableReferences(
  root: string,
  allowlist: readonly string[],
): EngramTableReference[] {
  const hits: EngramTableReference[] = [];
  for (const file of listTsFiles(root)) {
    const rel = relative(root, file).split(sep).join('/');
    if (allowlist.includes(rel)) continue;

    const raw = readFileSync(file, 'utf8');
    const scanned = stripComments(raw);
    const scannedLines = scanned.split('\n');
    const rawLines = raw.split('\n');

    scannedLines.forEach((line, idx) => {
      if (TOKEN_PATTERNS.some((re) => re.test(line))) {
        hits.push({ file: rel, line: idx + 1, text: rawLines[idx].trim() });
      }
    });
  }
  return hits;
}

function formatHits(hits: EngramTableReference[]): string {
  return hits.map((h) => `  ${h.file}:${h.line}: ${h.text}`).join('\n');
}

describe('no source file references the engrams table outside the allow-list (AGT-1304)', () => {
  it('packages/cli/src has no engram-table reference outside db/engrams.ts and lib/engram-migration.ts', () => {
    // Guard against a vacuous pass: if CLI_SRC's path resolution ever breaks
    // (a moved directory, a broken relative URL), listTsFiles would silently
    // scan nothing and this test would pass green with zero hits found. Fail
    // loudly instead, and prove the walk actually saw real source files.
    expect(existsSync(CLI_SRC), `expected packages/cli/src to exist at ${CLI_SRC}`).toBe(true);
    const scannedFiles = listTsFiles(CLI_SRC);
    expect(scannedFiles.length, 'expected to scan at least one .ts file under packages/cli/src').toBeGreaterThan(0);

    const hits = scanForEngramTableReferences(CLI_SRC, ALLOWED_ENGRAM_TABLE_REFERENCES);

    expect(
      hits,
      hits.length > 0
        ? `found ${hits.length} engram-table reference(s) outside the allow-list:\n${formatHits(hits)}`
        : undefined,
    ).toEqual([]);
  });
});

describe('scanForEngramTableReferences detects reintroduction (AGT-1304 AC3)', () => {
  let scratchDir: string | undefined;

  afterEach(() => {
    if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
    scratchDir = undefined;
  });

  it('reports a planted `INSERT INTO engrams` outside the allow-list', () => {
    scratchDir = mkdtempSync(join(tmpdir(), 'think-agt1304-scan-'));
    mkdirSync(join(scratchDir, 'commands'), { recursive: true });

    const plantedFile = join(scratchDir, 'commands', 'sneaky-write.ts');
    writeFileSync(
      plantedFile,
      [
        'export function sneak(db: unknown): void {',
        "  (db as { exec: (s: string) => void }).exec('INSERT INTO engrams (id, content) VALUES (?, ?)');",
        '}',
        '',
      ].join('\n'),
    );

    const hits = scanForEngramTableReferences(scratchDir, ALLOWED_ENGRAM_TABLE_REFERENCES);

    expect(hits).toHaveLength(1);
    expect(hits[0]!.file).toBe('commands/sneaky-write.ts');
    expect(hits[0]!.line).toBe(2);
    expect(hits[0]!.text).toContain('INTO engrams');
  });

  it('does not report a file on the allow-list even if it contains the tokens', () => {
    scratchDir = mkdtempSync(join(tmpdir(), 'think-agt1304-scan-allowed-'));
    mkdirSync(join(scratchDir, 'lib'), { recursive: true });
    writeFileSync(
      join(scratchDir, 'lib', 'engram-migration.ts'),
      "export const q = 'UPDATE engrams SET evaluated_at = ? WHERE id = ?';\n",
    );

    const hits = scanForEngramTableReferences(scratchDir, ALLOWED_ENGRAM_TABLE_REFERENCES);
    expect(hits).toEqual([]);
  });

  it('does not report a comment mentioning insertEngram in prose, or a directory path like engrams/', () => {
    scratchDir = mkdtempSync(join(tmpdir(), 'think-agt1304-scan-falsepos-'));
    mkdirSync(join(scratchDir, 'lib'), { recursive: true });
    writeFileSync(
      join(scratchDir, 'lib', 'harmless.ts'),
      [
        '/**',
        ' * PII is stripped before it lands as engram content via `insertEngram`.',
        ' */',
        "export function consolidate(): string {",
        "  return 'consolidate all .db files from engrams/ into index/';",
        '}',
        '',
      ].join('\n'),
    );

    const hits = scanForEngramTableReferences(scratchDir, ALLOWED_ENGRAM_TABLE_REFERENCES);
    expect(hits).toEqual([]);
  });
});
