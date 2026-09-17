/**
 * Daemon start rescues stranded engram rows — AGT-1302 AC5.
 *
 * Seeds the engrams table the way a year of `think sync -d` / daemon-down
 * writes left it, starts a real daemon in a throwaway THINK_HOME, and asserts
 * the round trip the old tier could never complete: the rows come back from
 * `recall` over the live socket, with their kinds and their original
 * timestamps, with no manual `think reindex`.
 *
 * Also pins the ordering the ticket is about — the rescue runs before anything
 * that prunes engrams, and before the socket is bound.
 *
 * Everything runs inside a throwaway THINK_HOME. Nothing here may open a real
 * cortex: these rows are only migratable once.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// One constant vector: every entry is maximally similar to the query, so
// ranking cannot hide a row that was indexed.
const MOCK_EMBEDDING = Float32Array.from({ length: 384 }, (_, i) => i / 384);
vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn().mockResolvedValue(
    vi.fn().mockResolvedValue({ data: MOCK_EMBEDDING }),
  ),
}));

const CORTEX = 'e2e';
const OLD_TS = '2026-05-02T09:00:00.000Z';
const EXPIRED_AT = '2026-05-16T09:00:00.000Z';

let thinkHome: string;
let originalHome: string | undefined;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  originalHome = process.env.THINK_HOME;
  thinkHome = mkdtempSync(join(tmpdir(), 'think-engram-migration-start-'));
  process.env.THINK_HOME = thinkHome;

  const configDir = join(thinkHome, 'config');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({
      peerId: 'migration-e2e-peer',
      cortex: { author: 'e2e-author', active: CORTEX },
    }),
    { mode: 0o600 },
  );

  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as () => never);

  vi.resetModules();
  const { closeAllCortexDbs } = await import('../../src/db/engrams.js');
  closeAllCortexDbs();
});

afterEach(async () => {
  exitSpy.mockRestore();
  const { closeAllCortexDbs } = await import('../../src/db/engrams.js');
  closeAllCortexDbs();
  if (originalHome === undefined) delete process.env.THINK_HOME;
  else process.env.THINK_HOME = originalHome;
  rmSync(thinkHome, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
  process.exitCode = 0;
});

/** The rows the Studio actually has: live, expired, decision-bearing, subscribe. */
async function seedStrandedRows(): Promise<void> {
  const { getCortexDb, closeAllCortexDbs } = await import('../../src/db/engrams.js');
  const db = getCortexDb(CORTEX);
  const stmt = db.prepare(
    `INSERT INTO engrams (id, content, created_at, expires_at, episode_key, context, decisions)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  stmt.run('row-live', 'stranded memory: rebased the auth migration', OLD_TS, '2099-01-01T00:00:00.000Z', null, null, null);
  stmt.run('row-expired', 'stranded memory: past its TTL and never read', OLD_TS, EXPIRED_AT, null, null, null);
  stmt.run(
    'row-decision',
    'stranded decision: weighed the two sync backends',
    OLD_TS,
    EXPIRED_AT,
    null,
    null,
    JSON.stringify(['Decided the git-remote backend is first-class']),
  );
  stmt.run('row-subscribe', 'stranded feed item', OLD_TS, '2099-01-01T00:00:00.000Z', 'subscribe:teammate', null, null);
  closeAllCortexDbs();
}

describe.skipIf(process.platform === 'win32')(
  'daemon start → stranded engrams rescued → recall (AGT-1302 AC5)',
  () => {
    it('migrates before pruning and before the bind, and the entries are recallable', async () => {
      await seedStrandedRows();

      const { compactionQueue } = await import('../../src/daemon/compaction/queue.js');
      compactionQueue._setPipelineForTest(async () => {});

      const daemonClient = await import('../../src/lib/daemon-client.js');
      const { runDaemon } = await import('../../src/daemon/index.js');
      const socketPath = join(thinkHome, 'daemon.sock');
      const logLines: string[] = [];
      let resolveReady!: () => void;
      const readyPromise = new Promise<void>((r) => { resolveReady = r; });
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        const s = String(chunk);
        logLines.push(s);
        if (s.includes('think daemon ready')) resolveReady();
        return true;
      });

      const daemonPromise = runDaemon({ socketPath, foreground: true });
      try {
        await readyPromise;
        const log = logLines.join('');

        // Ran, and ran before the socket was bound — anything that can connect
        // at all is already looking at the rescued entries.
        expect(log).toContain('engram-migration: rescued 3');
        expect(log.indexOf('engram-migration: rescued')).toBeLessThan(
          log.indexOf('think daemon ready'),
        );
        // …and before the push-debouncer drain is scheduled, which deletes the
        // outbox rows the rescue just enqueued.
        expect(log.indexOf('engram-migration: rescued')).toBeLessThan(log.indexOf('outbox:'));

        // ── recall over the live daemon socket ────────────────────────────
        const client = await daemonClient.connectDaemon();
        let entries: { id: string; kind: string; content: string; ts: string }[];
        try {
          entries = (await client.call('recall', {
            query: 'stranded',
            cortex: CORTEX,
            limit: 10,
          })) as { id: string; kind: string; content: string; ts: string }[];
        } finally {
          client.close();
        }

        // Three rescued, the subscribe row left where it was.
        expect(entries).toHaveLength(3);
        const byKind = new Map(entries.map((e) => [e.kind, e]));
        expect(byKind.get('memory')!.content).toContain('stranded memory');
        expect(byKind.get('event')!.content).toBe(
          'stranded decision: weighed the two sync backends — ' +
            'Decisions: Decided the git-remote backend is first-class',
        );
        expect(entries.every((e) => e.ts === OLD_TS)).toBe(true);
        expect(entries.some((e) => e.content.includes('feed item'))).toBe(false);
      } finally {
        process.emit('SIGTERM');
        await daemonPromise.catch(() => {});
        compactionQueue._setPipelineForTest(undefined);
      }

      // ── the expired rows survived to be migrated, and only then become
      //    prunable — the ordering AC5 is about, from the prune's side.
      const { getCortexDb } = await import('../../src/db/engrams.js');
      const db = getCortexDb(CORTEX);
      const stamped = db
        .prepare('SELECT id, evaluated_at, promoted FROM engrams ORDER BY id')
        .all() as unknown as { id: string; evaluated_at: string | null; promoted: number | null }[];
      expect(stamped.filter((r) => r.evaluated_at !== null).map((r) => r.id)).toEqual([
        'row-decision', 'row-expired', 'row-live',
      ]);
      expect(stamped.find((r) => r.id === 'row-subscribe')!.evaluated_at).toBeNull();

      const { pruneExpiredEngrams } = await import('../../src/db/engram-queries.js');
      expect(pruneExpiredEngrams(CORTEX)).toBe(2); // the two expired, now-migrated rows
    }, 30_000);
  },
);
