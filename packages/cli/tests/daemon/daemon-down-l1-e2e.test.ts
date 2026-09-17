/**
 * End-to-end: write with the daemon down, start the daemon, recall it — AGT-1298 AC5.
 *
 * Stop the daemon, write one entry of each kind, restart, and assert `recall`
 * returns all three with the right `kind` — the round trip the old
 * `insertEngram` fallback could never complete (the engrams table has no kind
 * column and nothing drains it).
 *
 * Everything runs inside a throwaway THINK_HOME: the daemon binds its socket
 * under that directory, so the real daemon, socket and cortexes are never
 * touched. The fixture has no git repo, which is deliberate — recall must work
 * off L2 regardless of what the push-debouncer's git drain manages to do with
 * the same rows.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';

// Mock the embedding pipeline so tests don't download the 150MB model. One
// constant vector: every entry is maximally similar to the query, so recall
// ranking cannot hide a row that was indexed.
const MOCK_EMBEDDING = Float32Array.from({ length: 384 }, (_, i) => i / 384);
vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn().mockResolvedValue(
    vi.fn().mockResolvedValue({ data: MOCK_EMBEDDING }),
  ),
}));

const CORTEX = 'e2e';

let thinkHome: string;
let originalHome: string | undefined;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  originalHome = process.env.THINK_HOME;
  thinkHome = mkdtempSync(join(tmpdir(), 'think-daemon-down-e2e-'));
  process.env.THINK_HOME = thinkHome;

  const configDir = join(thinkHome, 'config');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({
      peerId: 'e2e-test-peer',
      cortex: { author: 'e2e-author', active: CORTEX },
    }),
    { mode: 0o600 },
  );

  // The daemon's SIGTERM drain calls process.exit(0); keep it from killing
  // the test runner (same seam as tests/daemon/index.test.ts).
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as () => never);

  vi.resetModules();
  const { getCortexDb, closeAllCortexDbs } = await import('../../src/db/engrams.js');
  closeAllCortexDbs();
  getCortexDb(CORTEX); // the cortex exists (its L2 file is on disk)
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

describe.skipIf(process.platform === 'win32')(
  'daemon down → write → daemon start → recall (AGT-1298 AC5)',
  () => {
    it('finds all three kinds after the daemon starts, with no manual reindex', async () => {
      // ── 1. daemon stopped ────────────────────────────────────────────────
      // `connectDaemon()` would try to SPAWN a daemon here (the commands call
      // it with no options, so the `_spawnOverride` seam is out of reach);
      // we inject the error a stopped daemon that cannot be spawned produces.
      const daemonClient = await import('../../src/lib/daemon-client.js');
      const { DaemonUnavailableError } = daemonClient;
      const connectSpy = vi
        .spyOn(daemonClient, 'connectDaemon')
        .mockRejectedValue(
          new DaemonUnavailableError('daemon failed to start', join(thinkHome, 'daemon.log')),
        );
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const { makeSyncCommand } = await import('../../src/commands/log.js');
      const { makeEventCommand } = await import('../../src/commands/event.js');
      const { retroCommand } = await import('../../src/commands/retro.js');
      const workingContext = await import('../../src/lib/working-context.js');
      // Deterministic topics: the suite runs inside the think-cli repo, which
      // would otherwise auto-tag the retro with repo:think-cli.
      vi.spyOn(workingContext, 'detectWorkingContext').mockReturnValue(null);

      const run = async (cmd: Command, argv: string[]): Promise<void> => {
        const prog = new Command();
        prog.option('-C, --cortex <name>', 'Use a specific cortex for this command');
        prog.addCommand(cmd);
        await prog.parseAsync(['node', 'think', '-C', CORTEX, ...argv]);
      };

      await run(makeSyncCommand(), ['sync', 'offline memory: rebased the auth migration']);
      await run(makeEventCommand(), ['event', 'offline event: cut the 3.0.0 release candidate']);
      await run(retroCommand, [
        'retro',
        'offline retro: the daemon-down path must write to L1, never to the engrams table',
      ]);

      expect(process.exitCode).toBeFalsy();

      const { getCortexDb, closeAllCortexDbs } = await import('../../src/db/engrams.js');
      const db = getCortexDb(CORTEX);
      expect(
        (db.prepare('SELECT COUNT(*) as n FROM l1_outbox').get() as { n: number }).n,
      ).toBe(3);
      // Nothing in the tier nothing drains.
      expect(
        (db.prepare('SELECT COUNT(*) as n FROM engrams').get() as { n: number }).n,
      ).toBe(0);
      // Nothing in L2 yet either — the CLI cannot embed.
      expect(
        (db.prepare('SELECT COUNT(*) as n FROM memories').get() as { n: number }).n,
      ).toBe(0);
      closeAllCortexDbs();

      // ── 2. daemon start ──────────────────────────────────────────────────
      connectSpy.mockRestore();

      // Keep the compaction worker off the LLM: this test is about indexing,
      // and a kind=memory entry is enqueued for compaction exactly as a live
      // daemon write would be.
      const { compactionQueue } = await import('../../src/daemon/compaction/queue.js');
      compactionQueue._setPipelineForTest(async () => {});

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

        // Indexing is awaited BEFORE the socket is bound, so anything that can
        // connect at all is already looking at an indexed L2.
        expect(logLines.join('')).toContain('outbox-index: indexed 3');

        // ── 3. recall over the live daemon socket ──────────────────────────
        const client = await daemonClient.connectDaemon();
        let entries: { id: string; kind: string; content: string }[];
        try {
          entries = (await client.call('recall', {
            query: 'offline',
            cortex: CORTEX,
            limit: 10,
          })) as { id: string; kind: string; content: string }[];
        } finally {
          client.close();
        }

        const byKind = new Map(entries.map((e) => [e.kind, e.content]));
        expect(byKind.get('memory')).toContain('offline memory');
        expect(byKind.get('event')).toContain('offline event');
        expect(byKind.get('retro')).toContain('offline retro');
      } finally {
        process.emit('SIGTERM');
        await daemonPromise.catch(() => {});
        compactionQueue._setPipelineForTest(undefined);
      }
    }, 30_000);
  },
);
