/**
 * AGT-1311 — the README command table is generated from the commander
 * registry (`src/program.ts`), and this test fails, with a readable diff,
 * the moment either committed README drifts from it.
 *
 * AC3 (drift): for every file in TABLE_TARGETS, regenerate the block in
 * memory from the live registry and diff it against the committed one.
 * AC4 (vocabulary/length): every visible command's one-line description is
 * under 80 characters and carries none of the retired-vocabulary terms.
 *
 * No THINK_HOME / real-home interaction: `buildProgram()` (via
 * `getCommandRows()`/`generateCommandTable()`) only constructs the commander
 * object graph — it never touches disk beyond `readPackageVersion()`'s
 * package.json lookups, and never touches `~/.think*`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  applyToContent,
  BEGIN_MARKER,
  END_MARKER,
  generateCommandTable,
  getCommandRows,
  TABLE_TARGETS,
} from '../../scripts/gen-command-table.js';

function extractBlock(content: string): string {
  const begin = content.indexOf(BEGIN_MARKER);
  const end = content.indexOf(END_MARKER);
  expect(begin, `${BEGIN_MARKER} not found`).toBeGreaterThanOrEqual(0);
  expect(end, `${END_MARKER} not found`).toBeGreaterThanOrEqual(0);
  return content.slice(begin, end + END_MARKER.length);
}

describe('gen-command-table — drift (AGT-1311 AC2/AC3)', () => {
  for (const file of TABLE_TARGETS) {
    it(`${file} matches the generated command table`, () => {
      const current = readFileSync(file, 'utf-8');
      const committedBlock = extractBlock(current);
      const freshBlock = `${BEGIN_MARKER}\n${generateCommandTable()}\n${END_MARKER}`;

      // A plain `toBe` gives vitest's own unified-diff output on failure —
      // exactly what AC3 asks for — without hand-rolling a differ.
      expect(committedBlock, `${file} is stale — run \`npm run gen:commands\``).toBe(freshBlock);
    });

    it(`${file}: regenerating is a no-op (AC2 idempotency)`, () => {
      const current = readFileSync(file, 'utf-8');
      const regenerated = applyToContent(current);
      expect(regenerated).toBe(current);
    });
  }
});

describe('gen-command-table — retired vocabulary + length (AGT-1311 AC4)', () => {
  // `curate` is retired everywhere except the `curate-retros` command name
  // itself, which is a deliberate, still-shipping command (retro curation,
  // not the deleted engram curator).
  const RETIRED_TERMS: { pattern: RegExp; label: string }[] = [
    { pattern: /engram/i, label: 'engram' },
    { pattern: /\bcurate\b/i, label: 'curate' },
    { pattern: /--decision\b/i, label: '--decision' },
    { pattern: /\bthink log\b/i, label: 'think log' },
    { pattern: /\bv2\b/i, label: 'v2' },
    { pattern: /\bv3\b/i, label: 'v3' },
  ];

  const rows = getCommandRows();

  it('the registry actually has commands to check (sanity)', () => {
    // Guards against a broken buildProgram() import silently checking zero
    // rows and reporting green.
    expect(rows.length).toBeGreaterThan(20);
  });

  for (const row of rows) {
    it(`\`${row.path}\` description is under 80 characters`, () => {
      expect(
        row.description.length,
        `\`${row.path}\` description is ${row.description.length} chars: "${row.description}"`,
      ).toBeLessThan(80);
    });

    it(`\`${row.path}\` description has no retired vocabulary`, () => {
      for (const { pattern, label } of RETIRED_TERMS) {
        if (label === 'curate' && row.path === 'think curate-retros') continue;
        expect(
          pattern.test(row.description),
          `\`${row.path}\` description still contains retired term "${label}": "${row.description}"`,
        ).toBe(false);
      }
    });
  }
});
