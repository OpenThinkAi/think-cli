import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getCortexDb, closeAllCortexDbs, migrations } from '../../src/db/engrams.js';
import { runMigrations } from '../../src/db/migrate.js';
import { getPeerId } from '../../src/lib/config.js';
import { getEngramDbPath, ensureThinkDirs } from '../../src/lib/paths.js';
import {
  insertRetro,
  insertRetroIfNotExists,
  VALID_KINDS,
  getPendingRetros,
  mergeRetro,
  setRetroPromoted,
  recordCuratorRun,
  runsSince,
  searchRetros,
  bumpRecallStats,
  getRetrosBySyncVersion,
  applyRetroTombstone,
  getRetroCount,
} from '../../src/db/retro-queries.js';

describe('retro-queries', () => {
  let originalHome: string | undefined;
  let tmpHome: string;
  const cortex = 'retro-test';

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-retro-test-'));
    process.env.THINK_HOME = tmpHome;
    closeAllCortexDbs();
    getCortexDb(cortex);
  });

  afterEach(() => {
    closeAllCortexDbs();
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('inserts a retro and returns the full row', () => {
    const row = insertRetro(cortex, { content: 'use transactions for all schema migrations' });
    expect(row.id).toBeTruthy();
    expect(row.content).toBe('use transactions for all schema migrations');
    expect(row.kind).toBeNull();
    expect(row.cortex_name).toBe(cortex);
    expect(row.occurrences).toBe(1);
    expect(row.tombstoned_at).toBeNull();
    expect(row.tombstone_reason).toBeNull();
    expect(typeof row.created_at).toBe('string');
    expect(row.sync_version).toBeGreaterThan(0);
  });

  it('stores a valid kind and round-trips it', () => {
    for (const kind of VALID_KINDS) {
      const row = insertRetro(cortex, { content: `kind test: ${kind}`, kind });
      expect(row.kind).toBe(kind);
    }
  });

  it('stores null kind when omitted', () => {
    const row = insertRetro(cortex, { content: 'no kind' });
    expect(row.kind).toBeNull();
  });

  it('retros table has no expires_at column', () => {
    const db = getCortexDb(cortex);
    const cols = db.prepare('PRAGMA table_info(retros)').all() as { name: string }[];
    const colNames = cols.map(c => c.name);
    expect(colNames).not.toContain('expires_at');
    const expected = ['id', 'content', 'kind', 'cortex_name', 'created_at', 'occurrences', 'tombstoned_at', 'tombstone_reason', 'sync_version'];
    for (const col of expected) {
      expect(colNames).toContain(col);
    }
  });

  it('FTS5 index is populated on insert and supports MATCH queries (AC #5)', () => {
    insertRetro(cortex, { content: 'strategy engine type contracts should be documented' });
    insertRetro(cortex, { content: 'always run database migrations inside a transaction' });

    const db = getCortexDb(cortex);
    const results = db.prepare(
      `SELECT r.* FROM retros r JOIN retros_fts f ON r.rowid = f.rowid
       WHERE retros_fts MATCH ? ORDER BY rank LIMIT 10`
    ).all('strategy') as { content: string }[];

    expect(results.length).toBe(1);
    expect(results[0].content).toContain('strategy engine');
  });

  it('sync_version increments with each insert', () => {
    const r1 = insertRetro(cortex, { content: 'first retro' });
    const r2 = insertRetro(cortex, { content: 'second retro' });
    expect(r2.sync_version).toBeGreaterThan(r1.sync_version);
  });

  it('retros do not appear in engrams table (cross-table isolation)', () => {
    const token = 'isolation9guard';
    insertRetro(cortex, { content: token });
    const db = getCortexDb(cortex);
    const engramResults = db.prepare(
      `SELECT * FROM engrams WHERE content LIKE ? LIMIT 10`
    ).all(`%${token}%`);
    expect(engramResults.length).toBe(0);
  });

  it('retros do not appear in memories table (cross-table isolation)', () => {
    const token = 'isolation9memory9guard';
    insertRetro(cortex, { content: token });
    const db = getCortexDb(cortex);
    const memoryResults = db.prepare(
      `SELECT * FROM memories WHERE content LIKE ? LIMIT 10`
    ).all(`%${token}%`);
    expect(memoryResults.length).toBe(0);
  });

  it('migration v9 adds promoted, last_recalled_at, recalled_count columns to retros', () => {
    const db = getCortexDb(cortex);
    const cols = db.prepare('PRAGMA table_info(retros)').all() as { name: string }[];
    const colNames = cols.map(c => c.name);
    expect(colNames).toContain('promoted');
    expect(colNames).toContain('last_recalled_at');
    expect(colNames).toContain('recalled_count');
  });

  it('migration v9 creates retro_curator_runs table', () => {
    const db = getCortexDb(cortex);
    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='retro_curator_runs'`
    ).all() as { name: string }[];
    expect(tables.length).toBe(1);
  });

  it('new retro row has promoted=0, last_recalled_at=null, recalled_count=0 by default', () => {
    const row = insertRetro(cortex, { content: 'default columns check' });
    expect(row.promoted).toBe(0);
    expect(row.last_recalled_at).toBeNull();
    expect(row.recalled_count).toBe(0);
  });

  it('insertRetro with promoted: 1 round-trips that value (AGT-209 AC #1)', () => {
    const row = insertRetro(cortex, { content: 'user-attested retro', promoted: 1 });
    expect(row.promoted).toBe(1);
  });

  it('getRetroCount returns count of non-tombstoned retros (AGT-209 AC #2)', () => {
    expect(getRetroCount(cortex)).toBe(0);
    insertRetro(cortex, { content: 'first retro' });
    expect(getRetroCount(cortex)).toBe(1);
    const r2 = insertRetro(cortex, { content: 'second retro' });
    insertRetro(cortex, { content: 'third retro' });
    expect(getRetroCount(cortex)).toBe(3);

    // Tombstoning excludes the row from the count
    const db = getCortexDb(cortex);
    db.prepare('UPDATE retros SET tombstoned_at = ? WHERE id = ?')
      .run(new Date().toISOString(), r2.id);
    expect(getRetroCount(cortex)).toBe(2);
  });

  it('getPendingRetros returns non-tombstoned retros ordered by created_at', () => {
    const r1 = insertRetro(cortex, { content: 'first retro' });
    const r2 = insertRetro(cortex, { content: 'second retro' });
    const r3 = insertRetro(cortex, { content: 'third retro' });

    // Tombstone r2
    const db = getCortexDb(cortex);
    db.prepare(`UPDATE retros SET tombstoned_at = ? WHERE id = ?`).run(new Date().toISOString(), r2.id);

    const pending = getPendingRetros(cortex);
    const ids = pending.map(r => r.id);
    expect(ids).toContain(r1.id);
    expect(ids).not.toContain(r2.id);
    expect(ids).toContain(r3.id);
    expect(ids.indexOf(r1.id)).toBeLessThan(ids.indexOf(r3.id));
  });

  it('mergeRetro increments occurrences on canonical and tombstones merged entry', () => {
    const canonical = insertRetro(cortex, { content: 'run migrations in a transaction' });
    const dupe = insertRetro(cortex, { content: 'always wrap db migrations in transactions' });

    mergeRetro(cortex, canonical.id, dupe.id);

    const db = getCortexDb(cortex);
    const canonicalRow = db.prepare('SELECT * FROM retros WHERE id = ?').get(canonical.id) as { occurrences: number; tombstoned_at: string | null };
    const mergedRow = db.prepare('SELECT * FROM retros WHERE id = ?').get(dupe.id) as { tombstoned_at: string | null; tombstone_reason: string };

    expect(canonicalRow.occurrences).toBe(2);
    expect(canonicalRow.tombstoned_at).toBeNull();
    expect(mergedRow.tombstoned_at).toBeTruthy();
    expect(mergedRow.tombstone_reason).toBe(`merged_into:${canonical.id}`);
  });

  it('mergeRetro merged row still exists in DB (no deletion)', () => {
    const canonical = insertRetro(cortex, { content: 'use prepared statements' });
    const dupe = insertRetro(cortex, { content: 'always use parameterized queries' });

    mergeRetro(cortex, canonical.id, dupe.id);

    const db = getCortexDb(cortex);
    const all = db.prepare('SELECT id FROM retros').all() as { id: string }[];
    const allIds = all.map(r => r.id);
    expect(allIds).toContain(canonical.id);
    expect(allIds).toContain(dupe.id);
  });

  it('setRetroPromoted sets promoted=1 on given ids', () => {
    const r1 = insertRetro(cortex, { content: 'retro one' });
    const r2 = insertRetro(cortex, { content: 'retro two' });

    setRetroPromoted(cortex, [r1.id, r2.id], 1);

    const db = getCortexDb(cortex);
    const row1 = db.prepare('SELECT promoted FROM retros WHERE id = ?').get(r1.id) as { promoted: number };
    const row2 = db.prepare('SELECT promoted FROM retros WHERE id = ?').get(r2.id) as { promoted: number };
    expect(row1.promoted).toBe(1);
    expect(row2.promoted).toBe(1);
  });

  it('setRetroPromoted with promoted=0 demotes a previously promoted retro', () => {
    const r = insertRetro(cortex, { content: 'retro to relegate' });
    setRetroPromoted(cortex, [r.id], 1);
    setRetroPromoted(cortex, [r.id], 0);

    const db = getCortexDb(cortex);
    const row = db.prepare('SELECT promoted FROM retros WHERE id = ?').get(r.id) as { promoted: number };
    expect(row.promoted).toBe(0);
  });

  it('recordCuratorRun inserts a row into retro_curator_runs', () => {
    recordCuratorRun(cortex);
    const db = getCortexDb(cortex);
    const rows = db.prepare('SELECT * FROM retro_curator_runs').all() as { run_at: string }[];
    expect(rows.length).toBe(1);
    expect(typeof rows[0].run_at).toBe('string');
  });

  it('runsSince returns count of runs after the given timestamp', () => {
    const before = new Date(Date.now() - 5000).toISOString();
    recordCuratorRun(cortex);
    recordCuratorRun(cortex);

    const count = runsSince(cortex, before);
    // Both runs happened after `before`
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('runsSince returns 0 when no runs after the given timestamp', () => {
    recordCuratorRun(cortex);
    const after = new Date(Date.now() + 5000).toISOString();
    const count = runsSince(cortex, after);
    expect(count).toBe(0);
  });

  describe('searchRetros', () => {
    it('returns only promoted=1 retros by default', () => {
      const r1 = insertRetro(cortex, { content: 'promoted retro one' });
      const r2 = insertRetro(cortex, { content: 'relegated retro two' });
      setRetroPromoted(cortex, [r1.id], 1);
      // r2 stays promoted=0

      const results = searchRetros(cortex);
      const ids = results.map(r => r.id);
      expect(ids).toContain(r1.id);
      expect(ids).not.toContain(r2.id);
    });

    it('--all returns relegated (promoted=0) retros too', () => {
      const r1 = insertRetro(cortex, { content: 'promoted retro' });
      const r2 = insertRetro(cortex, { content: 'relegated retro' });
      setRetroPromoted(cortex, [r1.id], 1);

      const results = searchRetros(cortex, { all: true });
      const ids = results.map(r => r.id);
      expect(ids).toContain(r1.id);
      expect(ids).toContain(r2.id);
    });

    it('never returns tombstoned rows even with --all', () => {
      const r1 = insertRetro(cortex, { content: 'canonical retro' });
      const r2 = insertRetro(cortex, { content: 'tombstoned duplicate' });
      mergeRetro(cortex, r1.id, r2.id);
      setRetroPromoted(cortex, [r1.id], 1);

      const results = searchRetros(cortex, { all: true });
      const ids = results.map(r => r.id);
      expect(ids).not.toContain(r2.id);
    });

    it('orders results: promoted=1 first, then occurrences DESC, then created_at DESC', () => {
      const db = getCortexDb(cortex);

      // Insert in a known order so created_at ordering is deterministic
      const rLow = insertRetro(cortex, { content: 'low occurrence retro' });
      const rHigh = insertRetro(cortex, { content: 'high occurrence retro' });
      const rRelegated = insertRetro(cortex, { content: 'relegated retro' });

      // Promote rLow and rHigh; leave rRelegated promoted=0
      setRetroPromoted(cortex, [rLow.id, rHigh.id], 1);
      // Give rHigh more occurrences
      db.prepare('UPDATE retros SET occurrences = 5 WHERE id = ?').run(rHigh.id);

      const results = searchRetros(cortex, { all: true });
      const ids = results.map(r => r.id);

      // rHigh (promoted=1, occurrences=5) before rLow (promoted=1, occurrences=1)
      expect(ids.indexOf(rHigh.id)).toBeLessThan(ids.indexOf(rLow.id));
      // Both promoted before relegated
      expect(ids.indexOf(rHigh.id)).toBeLessThan(ids.indexOf(rRelegated.id));
      expect(ids.indexOf(rLow.id)).toBeLessThan(ids.indexOf(rRelegated.id));
    });

    it('FTS query filters results', () => {
      const r1 = insertRetro(cortex, { content: 'always use transactions for schema migrations' });
      const r2 = insertRetro(cortex, { content: 'index foreign keys in SQLite tables' });
      setRetroPromoted(cortex, [r1.id, r2.id], 1);

      const results = searchRetros(cortex, { query: 'transactions', all: true });
      const ids = results.map(r => r.id);
      expect(ids).toContain(r1.id);
      expect(ids).not.toContain(r2.id);
    });

    it('returns empty array when no promoted retros exist', () => {
      insertRetro(cortex, { content: 'not promoted retro' });
      const results = searchRetros(cortex);
      expect(results).toHaveLength(0);
    });
  });

  describe('bumpRecallStats', () => {
    it('increments recalled_count and sets last_recalled_at for each id', () => {
      const r = insertRetro(cortex, { content: 'retro to bump' });
      expect(r.recalled_count).toBe(0);
      expect(r.last_recalled_at).toBeNull();

      const before = new Date().toISOString();
      bumpRecallStats(cortex, [r.id]);

      const db = getCortexDb(cortex);
      const updated = db.prepare('SELECT recalled_count, last_recalled_at FROM retros WHERE id = ?').get(r.id) as {
        recalled_count: number;
        last_recalled_at: string;
      };
      expect(updated.recalled_count).toBe(1);
      expect(updated.last_recalled_at).not.toBeNull();
      expect(updated.last_recalled_at >= before).toBe(true);
    });

    it('increments recalled_count on each call', () => {
      const r = insertRetro(cortex, { content: 'bump twice retro' });
      bumpRecallStats(cortex, [r.id]);
      bumpRecallStats(cortex, [r.id]);

      const db = getCortexDb(cortex);
      const row = db.prepare('SELECT recalled_count FROM retros WHERE id = ?').get(r.id) as { recalled_count: number };
      expect(row.recalled_count).toBe(2);
    });

    it('batches multiple ids in a single transaction', () => {
      const r1 = insertRetro(cortex, { content: 'batch bump one' });
      const r2 = insertRetro(cortex, { content: 'batch bump two' });
      const r3 = insertRetro(cortex, { content: 'batch bump three' });

      bumpRecallStats(cortex, [r1.id, r2.id, r3.id]);

      const db = getCortexDb(cortex);
      for (const id of [r1.id, r2.id, r3.id]) {
        const row = db.prepare('SELECT recalled_count FROM retros WHERE id = ?').get(id) as { recalled_count: number };
        expect(row.recalled_count).toBe(1);
      }
    });

    it('no-ops when ids array is empty', () => {
      const r = insertRetro(cortex, { content: 'should not be touched' });
      bumpRecallStats(cortex, []);

      const db = getCortexDb(cortex);
      const row = db.prepare('SELECT recalled_count FROM retros WHERE id = ?').get(r.id) as { recalled_count: number };
      expect(row.recalled_count).toBe(0);
    });
  });

  describe('origin_peer_id (AGT-191)', () => {
    it('migration v10 adds origin_peer_id column with index', () => {
      const db = getCortexDb(cortex);
      const cols = db.prepare('PRAGMA table_info(retros)').all() as { name: string; type: string }[];
      const col = cols.find(c => c.name === 'origin_peer_id');
      expect(col).toBeDefined();
      expect(col!.type).toBe('TEXT');

      const indexes = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='retros' AND name='idx_retros_origin_peer_id'`,
      ).all() as { name: string }[];
      expect(indexes.length).toBe(1);
    });

    it('insertRetro stamps origin_peer_id from getPeerId by default', () => {
      const row = insertRetro(cortex, { content: 'default-peer-stamp' });
      expect(row.origin_peer_id).toBe(getPeerId());
    });

    it('insertRetro preserves an explicit origin_peer_id', () => {
      const externalPeer = '11111111-2222-3333-4444-555555555555';
      const row = insertRetro(cortex, { content: 'external-peer', origin_peer_id: externalPeer });
      expect(row.origin_peer_id).toBe(externalPeer);
    });

    it('insertRetro records null origin_peer_id when explicitly passed', () => {
      const row = insertRetro(cortex, { content: 'unknown-origin', origin_peer_id: null });
      expect(row.origin_peer_id).toBeNull();
    });

    it('insertRetroIfNotExists inserts a new row preserving wire-format origin_peer_id', () => {
      const externalPeer = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      const id = '01923456-789a-7bcd-8def-0123456789ab';
      const inserted = insertRetroIfNotExists(cortex, {
        id,
        content: 'wire-format-row',
        origin_peer_id: externalPeer,
      });
      expect(inserted).toBe(true);

      const db = getCortexDb(cortex);
      const row = db.prepare('SELECT origin_peer_id FROM retros WHERE id = ?').get(id) as { origin_peer_id: string };
      expect(row.origin_peer_id).toBe(externalPeer);
    });

    it('insertRetroIfNotExists is a no-op when the id already exists', () => {
      const id = '01923456-789a-7bcd-8def-0123456789cd';
      insertRetroIfNotExists(cortex, { id, content: 'first', origin_peer_id: 'peer-a' });
      const dupAttempt = insertRetroIfNotExists(cortex, {
        id,
        content: 'second',
        origin_peer_id: 'peer-b',
      });
      expect(dupAttempt).toBe(false);

      const db = getCortexDb(cortex);
      const row = db.prepare('SELECT content, origin_peer_id FROM retros WHERE id = ?').get(id) as {
        content: string;
        origin_peer_id: string;
      };
      // First-write wins; the duplicate attempt does NOT overwrite
      // origin_peer_id with the local peer or the second wire-format value.
      expect(row.content).toBe('first');
      expect(row.origin_peer_id).toBe('peer-a');
    });

    it('mergeRetro preserves canonical origin_peer_id; merged row keeps its own', () => {
      const peerA = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa';
      const peerB = 'bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb';
      const canonical = insertRetro(cortex, {
        content: 'older retro from peer A',
        origin_peer_id: peerA,
      });
      const merged = insertRetro(cortex, {
        content: 'newer near-duplicate from peer B',
        origin_peer_id: peerB,
      });

      mergeRetro(cortex, canonical.id, merged.id);

      const db = getCortexDb(cortex);
      const canonicalRow = db.prepare('SELECT origin_peer_id, occurrences, tombstoned_at FROM retros WHERE id = ?').get(canonical.id) as {
        origin_peer_id: string;
        occurrences: number;
        tombstoned_at: string | null;
      };
      const mergedRow = db.prepare('SELECT origin_peer_id, tombstoned_at, tombstone_reason FROM retros WHERE id = ?').get(merged.id) as {
        origin_peer_id: string;
        tombstoned_at: string | null;
        tombstone_reason: string;
      };

      // Canonical's origin is unchanged — never overwritten by the merged-into row's peer.
      expect(canonicalRow.origin_peer_id).toBe(peerA);
      expect(canonicalRow.occurrences).toBe(2);
      expect(canonicalRow.tombstoned_at).toBeNull();

      // Merged row is tombstoned but its origin_peer_id is preserved on the row, not transferred.
      expect(mergedRow.origin_peer_id).toBe(peerB);
      expect(mergedRow.tombstoned_at).toBeTruthy();
      expect(mergedRow.tombstone_reason).toBe(`merged_into:${canonical.id}`);
    });
  });
});

describe('getRetrosBySyncVersion', () => {
  let originalHome: string | undefined;
  let tmpHome: string;
  const cortex = 'sync-version-test';

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-syncver-test-'));
    process.env.THINK_HOME = tmpHome;
    closeAllCortexDbs();
    getCortexDb(cortex);
  });

  afterEach(() => {
    closeAllCortexDbs();
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('returns rows with sync_version strictly greater than sinceVersion', () => {
    const r1 = insertRetro(cortex, { content: 'first' });
    const r2 = insertRetro(cortex, { content: 'second' });
    const r3 = insertRetro(cortex, { content: 'third' });

    const results = getRetrosBySyncVersion(cortex, r1.sync_version);
    const ids = results.map(r => r.id);
    expect(ids).not.toContain(r1.id);
    expect(ids).toContain(r2.id);
    expect(ids).toContain(r3.id);
  });

  it('returns an empty array when no rows exceed sinceVersion', () => {
    const r = insertRetro(cortex, { content: 'only row' });
    const results = getRetrosBySyncVersion(cortex, r.sync_version);
    expect(results).toHaveLength(0);
  });

  it('includes tombstoned rows (tombstones must propagate to peers)', () => {
    const r1 = insertRetro(cortex, { content: 'canonical' });
    const r2 = insertRetro(cortex, { content: 'duplicate' });
    mergeRetro(cortex, r1.id, r2.id); // tombstones r2 with bumped sync_version

    // r2 is tombstoned, but must appear on the wire so peers can converge.
    const allAfterZero = getRetrosBySyncVersion(cortex, 0);
    const ids = allAfterZero.map(r => r.id);
    expect(ids).toContain(r2.id);
    const tombstoned = allAfterZero.find(r => r.id === r2.id)!;
    expect(tombstoned.tombstoned_at).toBeTruthy();
    expect(tombstoned.tombstone_reason).toBe(`merged_into:${r1.id}`);
  });

  it('returns rows ordered by sync_version ascending', () => {
    const r1 = insertRetro(cortex, { content: 'first' });
    const r2 = insertRetro(cortex, { content: 'second' });
    const r3 = insertRetro(cortex, { content: 'third' });

    const results = getRetrosBySyncVersion(cortex, 0);
    const versions = results.map(r => r.sync_version);
    for (let i = 1; i < versions.length; i++) {
      expect(versions[i]).toBeGreaterThan(versions[i - 1]);
    }
    const ids = results.map(r => r.id);
    expect(ids).toContain(r1.id);
    expect(ids).toContain(r2.id);
    expect(ids).toContain(r3.id);
  });
});

describe('applyRetroTombstone', () => {
  let originalHome: string | undefined;
  let tmpHome: string;
  const cortex = 'tombstone-apply-test';

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-tombstone-test-'));
    process.env.THINK_HOME = tmpHome;
    closeAllCortexDbs();
    getCortexDb(cortex);
  });

  afterEach(() => {
    closeAllCortexDbs();
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('applies tombstone fields to a live local row', () => {
    const r = insertRetro(cortex, { content: 'will be tombstoned from peer' });
    const tombstonedAt = '2026-05-01T10:00:00Z';
    const reason = 'merged_into:other-id';

    applyRetroTombstone(cortex, r.id, tombstonedAt, reason);

    const db = getCortexDb(cortex);
    const row = db.prepare('SELECT tombstoned_at, tombstone_reason FROM retros WHERE id = ?').get(r.id) as {
      tombstoned_at: string;
      tombstone_reason: string;
    };
    expect(row.tombstoned_at).toBe(tombstonedAt);
    expect(row.tombstone_reason).toBe(reason);
  });

  it('is idempotent — a second call on an already-tombstoned row is a no-op', () => {
    const r = insertRetro(cortex, { content: 'already tombstoned' });
    const firstAt = '2026-05-01T10:00:00Z';
    const firstReason = 'merged_into:original';

    applyRetroTombstone(cortex, r.id, firstAt, firstReason);
    applyRetroTombstone(cortex, r.id, '2026-05-02T12:00:00Z', 'merged_into:other');

    const db = getCortexDb(cortex);
    const row = db.prepare('SELECT tombstoned_at, tombstone_reason FROM retros WHERE id = ?').get(r.id) as {
      tombstoned_at: string;
      tombstone_reason: string;
    };
    expect(row.tombstoned_at).toBe(firstAt);
    expect(row.tombstone_reason).toBe(firstReason);
  });

  it('no-ops when the id does not exist', () => {
    expect(() => applyRetroTombstone(cortex, 'nonexistent-id', '2026-05-01T00:00:00Z', 'reason')).not.toThrow();
  });
});

describe('insertRetroIfNotExists with tombstone fields', () => {
  let originalHome: string | undefined;
  let tmpHome: string;
  const cortex = 'insert-tombstone-test';

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-insert-ts-'));
    process.env.THINK_HOME = tmpHome;
    closeAllCortexDbs();
    getCortexDb(cortex);
  });

  afterEach(() => {
    closeAllCortexDbs();
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('inserts a tombstoned row when the row is new', () => {
    const id = '01923456-789a-7bcd-8def-012345678999';
    const tombstonedAt = '2026-04-30T08:00:00Z';
    const inserted = insertRetroIfNotExists(cortex, {
      id,
      content: 'tombstone arrives first',
      tombstoned_at: tombstonedAt,
      tombstone_reason: 'merged_into:canonical',
    });
    expect(inserted).toBe(true);

    const db = getCortexDb(cortex);
    const row = db.prepare('SELECT tombstoned_at, tombstone_reason FROM retros WHERE id = ?').get(id) as {
      tombstoned_at: string;
      tombstone_reason: string;
    };
    expect(row.tombstoned_at).toBe(tombstonedAt);
    expect(row.tombstone_reason).toBe('merged_into:canonical');
  });

  it('preserves existing row if id already exists (first-write wins)', () => {
    const id = '01923456-789a-7bcd-8def-012345678aba';
    insertRetroIfNotExists(cortex, { id, content: 'original' });
    const again = insertRetroIfNotExists(cortex, {
      id,
      content: 'should not overwrite',
      tombstoned_at: '2026-05-01T00:00:00Z',
      tombstone_reason: 'merged_into:x',
    });
    expect(again).toBe(false);

    const db = getCortexDb(cortex);
    const row = db.prepare('SELECT content, tombstoned_at FROM retros WHERE id = ?').get(id) as {
      content: string;
      tombstoned_at: string | null;
    };
    expect(row.content).toBe('original');
    expect(row.tombstoned_at).toBeNull();
  });
});

describe('migration v10 backfill', () => {
  // Exercises the migration runner: open a fresh DB pinned at v9, write a
  // retro row (no origin_peer_id column exists yet), then run the full
  // migrations array and assert the v10 backfill stamped the row.
  let originalHome: string | undefined;
  let tmpHome: string;
  const cortex = 'v10-backfill-test';

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-v10-backfill-'));
    process.env.THINK_HOME = tmpHome;
    closeAllCortexDbs();
  });

  afterEach(() => {
    closeAllCortexDbs();
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('backfills pre-v10 retro rows to the local peer', () => {
    ensureThinkDirs();
    const dbPath = getEngramDbPath(cortex);
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');

    // Apply migrations up to (but not including) v10.
    const preV10 = migrations.filter(m => m.version < 10);
    runMigrations(db, preV10);

    // Pre-v10 schema has no origin_peer_id column on retros.
    const colsBefore = db.prepare('PRAGMA table_info(retros)').all() as { name: string }[];
    expect(colsBefore.some(c => c.name === 'origin_peer_id')).toBe(false);

    db.prepare(
      `INSERT INTO retros (id, content, kind, cortex_name, created_at, occurrences, sync_version)
       VALUES (?, ?, ?, ?, ?, 1, 1)`,
    ).run('legacy-retro-id', 'legacy-content', null, cortex, new Date().toISOString());

    // Now run the full set, including v10.
    runMigrations(db, migrations);

    const row = db.prepare('SELECT origin_peer_id FROM retros WHERE id = ?').get('legacy-retro-id') as {
      origin_peer_id: string;
    };
    expect(row.origin_peer_id).toBe(getPeerId());

    db.close();
  });
});
