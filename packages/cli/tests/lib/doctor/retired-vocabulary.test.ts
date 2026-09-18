/**
 * Unit tests for checkRetiredVocabulary() — AGT-1309 AC1-AC4.
 *
 * Every path is injected (homeDir, claudeMdPath, registeredFiles), so this
 * suite reads only temp files it wrote itself — never the developer's real
 * `~/CLAUDE.md`, `~/.claude/CLAUDE.md` or `~/.codex/AGENTS.md` — and writes
 * nothing back to any of them: the check is read-only regardless of `--fix`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkRetiredVocabulary,
  RETIRED_VOCABULARY_CHECK_ID,
  RETIRED_VOCABULARY_TERMS,
} from '../../../src/lib/doctor/retired-vocabulary.js';
import { WORKLOG_UPSERT, RETRO_UPSERT } from '../../../src/commands/init.js';

describe('checkRetiredVocabulary (AGT-1309)', () => {
  let dir: string;
  let homeDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'think-doctor-vocab-'));
    homeDir = join(dir, 'home');
    mkdirSync(homeDir, { recursive: true });
    claudeMdPath = join(dir, 'dot-claude', 'CLAUDE.md');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function check(registeredFiles: string[] = []) {
    return checkRetiredVocabulary({ homeDir, claudeMdPath, registeredFiles });
  }

  it('AC1: passes when none of the fixed files exist (missing files are silently skipped)', () => {
    const result = check();

    expect(result).toEqual({
      id: RETIRED_VOCABULARY_CHECK_ID,
      status: 'pass',
      detail: 'No retired vocabulary found outside managed markers.',
      fixable: false,
    });
  });

  it('AC1/AC2: reports a hit from ~/CLAUDE.md as file:line with a replacement, status warn', () => {
    const claudeMd = join(homeDir, 'CLAUDE.md');
    writeFileSync(claudeMd, 'line one\nUse think sync --decision "why" to log a call.\n', 'utf-8');

    const result = check();

    expect(result.status).toBe('warn');
    expect(result.fixable).toBe(false);
    expect(result.detail).toContain(`${claudeMd}:2:`);
    expect(result.detail).toContain('--decision');
    expect(result.detail).toContain('think event "Decided …"');
  });

  it('AC1: scans ~/AGENTS.md, $CLAUDE_CONFIG_DIR/CLAUDE.md, ~/.codex/AGENTS.md and registered files', () => {
    const agentsMd = join(homeDir, 'AGENTS.md');
    writeFileSync(agentsMd, 'run think monitor daily\n', 'utf-8');
    mkdirSync(join(dir, 'dot-claude'), { recursive: true });
    writeFileSync(claudeMdPath, 'try think curate for cleanup\n', 'utf-8');
    const codexAgents = join(homeDir, '.codex', 'AGENTS.md');
    mkdirSync(join(homeDir, '.codex'), { recursive: true });
    writeFileSync(codexAgents, 'recall --engrams for raw events\n', 'utf-8');
    const registered = join(dir, 'registered.md');
    writeFileSync(registered, 'an engram is a raw event\n', 'utf-8');

    const result = check([registered]);

    expect(result.status).toBe('warn');
    expect(result.detail).toContain(`${agentsMd}:1:`);
    expect(result.detail).toContain(`${claudeMdPath}:1:`);
    expect(result.detail).toContain(`${codexAgents}:1:`);
    expect(result.detail).toContain(`${registered}:1:`);
  });

  it('dedupes a registered file that is also one of the fixed paths', () => {
    const claudeMd = join(homeDir, 'CLAUDE.md');
    writeFileSync(claudeMd, 'think log this please\n', 'utf-8');

    const result = check([claudeMd]);

    // Exactly one hit line for the one retired term on the one line, not two.
    const hitLines = result.detail.split('\n').filter((l) => l.includes(`${claudeMd}:1:`));
    expect(hitLines).toHaveLength(1);
  });

  it('AC1: does not match `think curate-retros`, which is still live', () => {
    const claudeMd = join(homeDir, 'CLAUDE.md');
    writeFileSync(claudeMd, 'run think curate-retros --cortex foo weekly\n', 'utf-8');

    expect(check().status).toBe('pass');
  });

  it('word-boundary: `--decision` does not fire on a hypothetical `--decisions` word', () => {
    const claudeMd = join(homeDir, 'CLAUDE.md');
    writeFileSync(claudeMd, 'the --decisions flag was renamed\n', 'utf-8');

    expect(check().status).toBe('pass');
  });

  it('AC1: `engram` matches the plural `engrams` as prose, case-insensitively', () => {
    const claudeMd = join(homeDir, 'CLAUDE.md');
    writeFileSync(claudeMd, 'Engrams are stranded rows nothing reads.\n', 'utf-8');

    const result = check();

    expect(result.status).toBe('warn');
    expect(result.detail).toContain('memory/event');
  });

  it('a line matching both --engrams and engram reports only the more specific hit once', () => {
    const claudeMd = join(homeDir, 'CLAUDE.md');
    writeFileSync(claudeMd, 'recall --engrams to see raw events\n', 'utf-8');

    const result = check();
    const hitLines = result.detail.split('\n').filter((l) => l.includes(`${claudeMd}:1:`));

    expect(hitLines).toHaveLength(1);
    expect(hitLines[0]).toContain('recall searches memories');
  });

  it('AC3: reporting never writes to any scanned file', () => {
    const claudeMd = join(homeDir, 'CLAUDE.md');
    const before = 'Use --decision and think curate and engrams everywhere.\n';
    writeFileSync(claudeMd, before, 'utf-8');

    check();

    expect(readFileSync(claudeMd, 'utf-8')).toBe(before);
  });

  it('AC3: fixable is always false, even with several hits', () => {
    const claudeMd = join(homeDir, 'CLAUDE.md');
    writeFileSync(
      claudeMd,
      '--decision\n--episode\nthink curate\nthink log\nthink monitor\n--engrams\nengram\n',
      'utf-8',
    );

    const result = check();

    expect(result.status).toBe('warn');
    expect(result.fixable).toBe(false);
  });

  it('AC1: skips hits inside a managed work-log block, but still reports hits outside it', () => {
    const claudeMd = join(homeDir, 'CLAUDE.md');
    const managed = `${WORKLOG_UPSERT.beginMarker}\nUse think sync --decision "why" here.\n${WORKLOG_UPSERT.endMarker}\n`;
    const content = `Hand-written note: think curate is gone.\n${managed}Another hand-written note: engram.\n`;
    writeFileSync(claudeMd, content, 'utf-8');

    const result = check();

    expect(result.status).toBe('warn');
    expect(result.detail).not.toContain('--decision');
    expect(result.detail).toContain('think curate is gone');
    expect(result.detail).toContain('Another hand-written note: engram.');
  });

  it('AC1: skips hits inside a managed retro block too', () => {
    const claudeMd = join(homeDir, 'CLAUDE.md');
    const managed = `${RETRO_UPSERT.beginMarker}\nthink monitor the retros here.\n${RETRO_UPSERT.endMarker}\n`;
    writeFileSync(claudeMd, managed, 'utf-8');

    expect(check().status).toBe('pass');
  });

  it('AC1: skips hits between two separate managed blocks in the same file, in order', () => {
    const claudeMd = join(homeDir, 'CLAUDE.md');
    const worklog = `${WORKLOG_UPSERT.beginMarker}\nthink log inside worklog\n${WORKLOG_UPSERT.endMarker}\n`;
    const retro = `${RETRO_UPSERT.beginMarker}\nthink monitor inside retro\n${RETRO_UPSERT.endMarker}\n`;
    writeFileSync(claudeMd, `${worklog}between blocks: --engrams\n${retro}`, 'utf-8');

    const result = check();

    expect(result.status).toBe('warn');
    expect(result.detail).not.toContain('think log inside worklog');
    expect(result.detail).not.toContain('think monitor inside retro');
    expect(result.detail).toContain('between blocks: --engrams');
  });

  it('sanitizes control characters and truncates a very long matched line', () => {
    const claudeMd = join(homeDir, 'CLAUDE.md');
    const long = 'x'.repeat(300);
    writeFileSync(claudeMd, `prefix ${long} think curate suffix\n`, 'utf-8');

    const result = check();

    expect(result.status).toBe('warn');
    expect(result.detail).not.toContain('');
    // 160-char display cap plus the ellipsis marker, well short of the
    // original ~320-char line.
    expect(result.detail.split('\n').some((l) => l.length < 250)).toBe(true);
  });

  it('AC4: exports a single term list covering every term the ticket names', () => {
    const names = RETIRED_VOCABULARY_TERMS.map((t) => t.term);

    expect(names).toEqual([
      '--decision',
      '--episode',
      'think curate',
      'think log',
      'think monitor',
      '--engrams',
      'engram',
    ]);
    for (const t of RETIRED_VOCABULARY_TERMS) {
      expect(t.replacement.length).toBeGreaterThan(0);
    }
  });
});
