import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listKnownCortexes } from '../../src/db/engrams.js';

// #78: sanitizeName() permits `/` in cortex names, so index DBs live at
// nested paths like `<index>/cortex/engineering.db` — but listKnownCortexes
// used a flat readdir and never saw them, hiding slash-named cortexes from
// the embedding-prune loop, boot-time outbox replay, and `think cortex list`.
// These tests exercise the real function against an on-disk layout (the
// prune-loop tests mock listKnownCortexes entirely, so this is its only
// direct coverage).
describe('listKnownCortexes — recursive index enumeration (#78)', () => {
  let originalHome: string | undefined;
  let tmpHome: string;
  let indexDir: string;

  const touch = (relPath: string) => {
    const full = join(indexDir, ...relPath.split('/'));
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, '');
  };

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-list-cortexes-'));
    process.env.THINK_HOME = tmpHome;
    indexDir = join(tmpHome, 'index');
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('returns [] when the index directory does not exist (fresh install)', () => {
    expect(listKnownCortexes()).toEqual([]);
  });

  it('enumerates flat and nested DBs, including two-level names, sorted with `/` separators', () => {
    touch('personal.db');
    touch('cortex/engineering.db'); // one-level slash name
    touch('teams/platform/infra.db'); // two-level slash name (a/b/c is legal per sanitizeName)

    expect(listKnownCortexes()).toEqual([
      'cortex/engineering',
      'personal',
      'teams/platform/infra',
    ]);
  });

  it('excludes WAL/SHM sidecars, non-.db junk, and empty subdirectories', () => {
    touch('personal.db');
    touch('personal.db-wal');
    touch('personal.db-shm');
    touch('cortex/engineering.db');
    touch('cortex/engineering.db-wal');
    touch('notes.txt');
    touch('cortex/README.md');
    mkdirSync(join(indexDir, 'empty', 'nested'), { recursive: true });

    expect(listKnownCortexes()).toEqual(['cortex/engineering', 'personal']);
  });
});
