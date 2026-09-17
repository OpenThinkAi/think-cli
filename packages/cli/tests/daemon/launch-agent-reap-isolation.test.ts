/**
 * AGT-1322 AC2 — the daemon's LaunchAgent reaper cannot reach the real home.
 *
 * On 2026-09-17 a full `npm test` unloaded and deleted the runner's real
 * `ai.openthink.curate.*` / `ai.openthink.sync.*` agents: AGT-1301 wired
 * `reapStaleLaunchAgents()` into `runDaemon()` with a default directory of
 * `$HOME/Library/LaunchAgents`, and six test files started a real daemon with
 * a temp THINK_HOME but the inherited real HOME.
 *
 * This starts the daemon exactly the way tests/daemon/index.test.ts and
 * graceful-shutdown.test.ts do — `runDaemon({ socketPath, foreground: true })`,
 * default reaper options, no injected directory, no injected unload — and
 * proves two things at once:
 *
 *   1. the reaper DID run and DID reap, against the temp HOME's
 *      Library/LaunchAgents (so this isn't passing because the reaper silently
 *      no-opped on a missing directory), and
 *   2. the sentinel directory standing in for the real ~/Library/LaunchAgents
 *      is untouched, as is every non-matching plist beside the fixture.
 *
 * The fixture is only ever written under the temp HOME. Nothing here writes to,
 * or reads a fixture out of, the real ~/Library/LaunchAgents.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  SENTINEL_DIR_ENV,
  SENTINEL_PLIST_NAME,
  SENTINEL_PLIST_LABEL,
  canonicalPath,
  isInsideOsTmpdir,
  sentinelPlistXml,
} from '../setup/home-isolation-paths.js';

// ---------------------------------------------------------------------------
// Keep the daemon's embedding warmup off the network, exactly as
// tests/daemon/index.test.ts does — the reap happens before warmup, but the
// daemon won't log "ready" until warmup settles.
// ---------------------------------------------------------------------------

vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn().mockResolvedValue(
    vi.fn().mockResolvedValue({ data: new Float32Array(384).fill(0.1) }),
  ),
}));

vi.mock('../../src/lib/embed.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/lib/embed.js')>();
  return { ...original, warmupEmbedModel: vi.fn().mockResolvedValue(1) };
});

/** A plist the reaper must NOT touch — wrong label prefix. */
const BYSTANDER_NAME = 'ai.openthink.subscribe.bystander.plist';
const BYSTANDER_XML = sentinelPlistXml().replace(
  new RegExp(SENTINEL_PLIST_LABEL, 'g'),
  'ai.openthink.subscribe.bystander',
);

describe.skipIf(process.platform !== 'darwin')(
  'AGT-1322 — daemon start reaps only inside the isolated HOME',
  () => {
    let thinkHome: string;
    let originalThinkHome: string | undefined;
    let exitSpy: ReturnType<typeof vi.spyOn>;
    let stderrSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      originalThinkHome = process.env.THINK_HOME;
      thinkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'think-reap-isolation-'));
      process.env.THINK_HOME = thinkHome;
      vi.resetModules();
      exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as () => never);
    });

    afterEach(() => {
      exitSpy.mockRestore();
      stderrSpy?.mockRestore();
      if (originalThinkHome === undefined) delete process.env.THINK_HOME;
      else process.env.THINK_HOME = originalThinkHome;
      fs.rmSync(thinkHome, { recursive: true, force: true });
    });

    it('reaps the fixture under the temp HOME and leaves the sentinel alone', async () => {
      const { getLaunchAgentsDir } = await import('../../src/lib/launch-agent.js');
      const agentsDir = getLaunchAgentsDir();

      // Precondition: the directory the daemon is about to reap from is the
      // temp HOME's, not the real one. If this ever fails, the rest of the
      // test is about to delete real agents — so it is an assertion, not a
      // comment.
      expect(isInsideOsTmpdir(agentsDir), `getLaunchAgentsDir() = ${agentsDir}`).toBe(true);
      expect(canonicalPath(agentsDir)).not.toBe(
        canonicalPath(path.join(os.userInfo().homedir, 'Library', 'LaunchAgents')),
      );

      fs.mkdirSync(agentsDir, { recursive: true });
      const fixturePath = path.join(agentsDir, SENTINEL_PLIST_NAME);
      const bystanderPath = path.join(agentsDir, BYSTANDER_NAME);
      fs.writeFileSync(fixturePath, sentinelPlistXml(), { mode: 0o644 });
      fs.writeFileSync(bystanderPath, BYSTANDER_XML, { mode: 0o644 });

      const sentinelDir = process.env[SENTINEL_DIR_ENV] as string;
      expect(sentinelDir, `${SENTINEL_DIR_ENV} unset — globalSetup did not run`).toBeDefined();
      const sentinelPath = path.join(sentinelDir, SENTINEL_PLIST_NAME);
      const sentinelBefore = fs.readFileSync(sentinelPath, 'utf-8');
      const sentinelMtimeBefore = fs.statSync(sentinelPath).mtimeMs;

      const { runDaemon } = await import('../../src/daemon/index.js');
      const socketPath = path.join(thinkHome, 'daemon.sock');

      let resolveReady!: () => void;
      const ready = new Promise<void>((r) => { resolveReady = r; });
      const reapLines: string[] = [];

      const origWrite = process.stderr.write.bind(process.stderr);
      stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        const line = String(chunk);
        if (line.includes('launch-agent reap')) reapLines.push(line);
        if (line.includes('think daemon ready')) resolveReady();
        return origWrite(chunk);
      });

      const daemonPromise = runDaemon({ socketPath, foreground: true });
      await ready;

      // 1. The reaper ran against the temp HOME and removed the fixture.
      expect(fs.existsSync(fixturePath)).toBe(false);
      expect(reapLines.join('')).toContain(SENTINEL_PLIST_LABEL);

      // 2. A non-matching agent in the same directory survived — the reaper is
      //    prefix-scoped, not "delete everything in the temp home".
      expect(fs.existsSync(bystanderPath)).toBe(true);
      expect(fs.readFileSync(bystanderPath, 'utf-8')).toBe(BYSTANDER_XML);

      // 3. The sentinel — standing in for the real ~/Library/LaunchAgents —
      //    is byte-identical and its mtime is unchanged.
      expect(fs.existsSync(sentinelPath)).toBe(true);
      expect(fs.readFileSync(sentinelPath, 'utf-8')).toBe(sentinelBefore);
      expect(fs.statSync(sentinelPath).mtimeMs).toBe(sentinelMtimeBefore);

      // Shut the daemon down so the socket/pid files don't leak into the next
      // test file (house pattern from index.test.ts / graceful-shutdown.test.ts).
      process.emit('SIGTERM');
      await daemonPromise.catch(() => {});
    }, 30_000);
  },
);
