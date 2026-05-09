import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  __testing__,
  logAudit,
  pruneAuditLog,
  readAuditLog,
  type AuditEntry,
} from '../../src/lib/audit.js';

// AGT-063: rotate the active log when it crosses the threshold; expose
// `audit prune` to drop pre-cutoff entries; read across the rotated
// archive transparently.

function makeEntry(ts: string): AuditEntry {
  return {
    timestamp: ts,
    type: 'export',
    peer: 'self',
    entryIds: [],
    count: 1,
  };
}

describe('audit log rotation + prune (AGT-063)', () => {
  let originalHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-audit-test-'));
    process.env.THINK_HOME = tmpHome;
    // Ensure the data dir exists so direct writeFileSync calls don't ENOENT.
    // logAudit() in production lands inside the broader CLI flow which has
    // already mkdir'd the dir via getCortexDb()/ensureThinkDirs(); the
    // unit test bypasses that, so we set it up here.
    mkdirSync(dirname(__testing__.auditLogPath()), { recursive: true });
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('rotates the active log to .1 when size crosses the threshold (AC #1)', () => {
    const activePath = __testing__.auditLogPath();
    const archivePath = __testing__.archivedLogPath();

    // Pre-fill the active log past the threshold by writing one fat line.
    // Using one line keeps the test fast — rotation is byte-size based.
    const filler = 'x'.repeat(__testing__.ROTATION_THRESHOLD_BYTES + 1024);
    writeFileSync(activePath, filler + '\n', 'utf-8');
    expect(statSync(activePath).size).toBeGreaterThan(__testing__.ROTATION_THRESHOLD_BYTES);
    expect(existsSync(archivePath)).toBe(false);

    // The next logAudit() call should rotate before appending.
    logAudit(makeEntry('2026-05-09T00:00:00.000Z'));

    expect(existsSync(archivePath)).toBe(true);
    // Active log is fresh — only contains the new entry, not the filler.
    const liveContents = readFileSync(activePath, 'utf-8');
    expect(liveContents.split('\n').filter(Boolean).length).toBe(1);
    expect(liveContents).toContain('2026-05-09T00:00:00.000Z');
    // Archive carries the original fat content.
    expect(readFileSync(archivePath, 'utf-8')).toContain('xxx');
  });

  it('does not rotate when size is below the threshold', () => {
    const archivePath = __testing__.archivedLogPath();
    logAudit(makeEntry('2026-05-09T01:00:00.000Z'));
    logAudit(makeEntry('2026-05-09T02:00:00.000Z'));
    expect(existsSync(archivePath)).toBe(false);
  });

  it('readAuditLog reads across rotated archive + active log in chronological order (AC #3)', () => {
    const activePath = __testing__.auditLogPath();
    const archivePath = __testing__.archivedLogPath();

    // Simulate a post-rotation state: older entries in archive, newer in active.
    writeFileSync(archivePath, JSON.stringify(makeEntry('2026-04-01T00:00:00.000Z')) + '\n', 'utf-8');
    writeFileSync(activePath, JSON.stringify(makeEntry('2026-05-01T00:00:00.000Z')) + '\n', 'utf-8');

    const entries = readAuditLog();
    expect(entries.map(e => e.timestamp)).toEqual([
      '2026-04-01T00:00:00.000Z',
      '2026-05-01T00:00:00.000Z',
    ]);
  });

  it('readAuditLog returns [] when neither file exists', () => {
    expect(readAuditLog()).toEqual([]);
  });

  it('pruneAuditLog drops entries strictly before the cutoff in the active log (AC #2)', () => {
    const activePath = __testing__.auditLogPath();
    const lines = [
      makeEntry('2026-04-01T00:00:00.000Z'),
      makeEntry('2026-05-01T00:00:00.000Z'),
      makeEntry('2026-06-01T00:00:00.000Z'),
    ].map(e => JSON.stringify(e)).join('\n') + '\n';
    writeFileSync(activePath, lines, 'utf-8');

    const pruned = pruneAuditLog('2026-05-01T00:00:00.000Z');
    expect(pruned).toBe(1); // April dropped; May matches cutoff (kept) and June.
    const remaining = readAuditLog().map(e => e.timestamp);
    expect(remaining).toEqual([
      '2026-05-01T00:00:00.000Z',
      '2026-06-01T00:00:00.000Z',
    ]);
  });

  it('pruneAuditLog removes the active log entirely when every line is pre-cutoff', () => {
    const activePath = __testing__.auditLogPath();
    writeFileSync(activePath, JSON.stringify(makeEntry('2026-04-01T00:00:00.000Z')) + '\n', 'utf-8');

    const pruned = pruneAuditLog('2026-05-01T00:00:00.000Z');
    expect(pruned).toBe(1);
    expect(existsSync(activePath)).toBe(false);
  });

  it('pruneAuditLog --include-archive also trims the rotated archive (AC #2)', () => {
    const activePath = __testing__.auditLogPath();
    const archivePath = __testing__.archivedLogPath();
    writeFileSync(archivePath, [
      JSON.stringify(makeEntry('2026-03-01T00:00:00.000Z')),
      JSON.stringify(makeEntry('2026-04-01T00:00:00.000Z')),
    ].join('\n') + '\n', 'utf-8');
    writeFileSync(activePath, [
      JSON.stringify(makeEntry('2026-05-01T00:00:00.000Z')),
      JSON.stringify(makeEntry('2026-06-01T00:00:00.000Z')),
    ].join('\n') + '\n', 'utf-8');

    // Without --include-archive: only the active log is touched.
    const prunedActiveOnly = pruneAuditLog('2026-04-15T00:00:00.000Z');
    expect(prunedActiveOnly).toBe(0); // active starts at May; nothing strictly before mid-April.
    expect(readAuditLog().length).toBe(4); // archive still has 2, active still has 2.

    // With --include-archive: pre-mid-April archive entries drop too.
    const prunedAll = pruneAuditLog('2026-04-15T00:00:00.000Z', { includeArchive: true });
    expect(prunedAll).toBe(2); // March + April from archive.
    const remaining = readAuditLog().map(e => e.timestamp);
    expect(remaining).toEqual([
      '2026-05-01T00:00:00.000Z',
      '2026-06-01T00:00:00.000Z',
    ]);
  });
});
