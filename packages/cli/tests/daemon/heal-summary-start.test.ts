/**
 * A daemon start that self-heals is picked up by the next CLI command —
 * AGT-1307 AC1/AC3.
 *
 * Combines the two self-heal fixtures the ticket calls for in one real
 * `runDaemon()` start inside the suite's isolated HOME/THINK_HOME (AGT-1322):
 * a reapable `ai.openthink.curate.*` LaunchAgent plist (AGT-1301) and a
 * stranded `engrams` row (AGT-1302). Both write through `recordHealAction`
 * (daemon/index.ts), landing one pending record under THINK_HOME. This test
 * then plays the role of "the next interactive `think` command" by calling
 * `reportPendingHeal` — exactly what the CLI entry point's `preAction` hook
 * calls — and asserts it prints once and never again.
 *
 * Nothing here touches the real home: HOME and THINK_HOME are the isolated
 * temp directories `tests/setup/home-isolation.ts` sets up before this file's
 * module graph is even imported.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';

const MOCK_EMBEDDING = Float32Array.from({ length: 384 }, (_, i) => i / 384);
vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn().mockResolvedValue(
    vi.fn().mockResolvedValue({ data: MOCK_EMBEDDING }),
  ),
}));
vi.mock('../../src/lib/embed.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/lib/embed.js')>();
  return { ...original, warmupEmbedModel: vi.fn().mockResolvedValue(1) };
});

const CORTEX = 'heal-summary-e2e';
const OLD_TS = '2026-05-02T09:00:00.000Z';

/** A reapable curate-agent plist — same fixture shape as
 *  tests/lib/launch-agent-reaper.test.ts / launch-agent-reap-isolation.test.ts. */
const REAP_LABEL = 'ai.openthink.curate.aaaaaaaa';
function reapablePlistXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${REAP_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>/usr/bin/true</string>
    </array>
    <key>StartInterval</key>
    <integer>300</integer>
    <key>RunAtLoad</key>
    <false/>
  </dict>
</plist>
`;
}

function fakeInteractiveCommand(): Command {
  return new Command('sync');
}

describe.skipIf(process.platform !== 'darwin')(
  'daemon start self-heal → heal-summary picked up by the next command (AGT-1307)',
  () => {
    let exitSpy: ReturnType<typeof vi.spyOn>;
    let logSpy: ReturnType<typeof vi.spyOn>;
    let prevIsTTY: boolean | undefined;

    beforeEach(async () => {
      vi.resetModules();

      const configDir = join(process.env.THINK_HOME!, 'config');
      mkdirSync(configDir, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(configDir, 'config.json'),
        JSON.stringify({
          peerId: 'heal-summary-e2e-peer',
          cortex: { author: 'e2e-author', active: CORTEX },
        }),
        { mode: 0o600 },
      );

      // Fixture 1 — a stale LaunchAgent the reaper (AGT-1301) removes.
      const { getLaunchAgentsDir } = await import('../../src/lib/launch-agent.js');
      const agentsDir = getLaunchAgentsDir();
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(join(agentsDir, `${REAP_LABEL}.plist`), reapablePlistXml(), { mode: 0o644 });

      // Fixture 2 — a stranded engram row the migration (AGT-1302) rescues.
      const { getCortexDb, closeAllCortexDbs } = await import('../../src/db/engrams.js');
      const db = getCortexDb(CORTEX);
      db.prepare(
        `INSERT INTO engrams (id, content, created_at, expires_at, episode_key, context, decisions)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('row-1', 'stranded memory for the heal summary test', OLD_TS, '2099-01-01T00:00:00.000Z', null, null, null);
      closeAllCortexDbs();

      exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as () => never);
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      prevIsTTY = process.stdout.isTTY;
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    });

    afterEach(async () => {
      const { closeAllCortexDbs } = await import('../../src/db/engrams.js');
      closeAllCortexDbs();
      exitSpy.mockRestore();
      logSpy.mockRestore();
      Object.defineProperty(process.stdout, 'isTTY', { value: prevIsTTY, configurable: true });
      vi.restoreAllMocks();
      vi.resetModules();
      process.exitCode = 0;
    });

    it('records both actions and the next command prints the summary exactly once', async () => {
      const { compactionQueue } = await import('../../src/daemon/compaction/queue.js');
      compactionQueue._setPipelineForTest(async () => {});

      const { runDaemon } = await import('../../src/daemon/index.js');
      const socketPath = join(process.env.THINK_HOME!, 'daemon.sock');

      let resolveReady!: () => void;
      const ready = new Promise<void>((r) => { resolveReady = r; });
      const origWrite = process.stderr.write.bind(process.stderr);
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        if (String(chunk).includes('think daemon ready')) resolveReady();
        return origWrite(chunk);
      });

      const daemonPromise = runDaemon({ socketPath, foreground: true });
      try {
        await ready;
      } finally {
        process.emit('SIGTERM');
        await daemonPromise.catch(() => {});
        compactionQueue._setPipelineForTest(undefined);
        stderrSpy.mockRestore();
      }

      // The record landed under THINK_HOME with both counts folded in.
      const recordPath = join(process.env.THINK_HOME!, 'heal-summary.json');
      expect(existsSync(recordPath)).toBe(true);
      const record = JSON.parse(readFileSync(recordPath, 'utf-8'));
      expect(record.shown).toBe(false);
      expect(record.counts).toEqual({ migratedRows: 1, removedLaunchAgents: 1, refreshedBlocks: 0 });

      // "The next interactive `think` command" — the exact call the CLI
      // entry point's preAction hook makes.
      const { reportPendingHeal } = await import('../../src/lib/heal-summary.js');
      reportPendingHeal(fakeInteractiveCommand());

      expect(logSpy).toHaveBeenCalled();
      const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(printed).toContain('healed itself');
      expect(printed).toContain('migrated 1 stranded row');
      expect(printed).toContain('removed 1 stale launch agent');
      expect(printed).toContain('think doctor');

      // AC1 — prints once, never again for this heal.
      logSpy.mockClear();
      reportPendingHeal(fakeInteractiveCommand());
      expect(logSpy).not.toHaveBeenCalled();

      const recordAfter = JSON.parse(readFileSync(recordPath, 'utf-8'));
      expect(recordAfter.shown).toBe(true);
    }, 30_000);
  },
);
