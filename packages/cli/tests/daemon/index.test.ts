/**
 * Tests for daemon startup — embedding model warmup (alpha.5).
 *
 * Verifies that warmupEmbedModel() is called as a fire-and-forget
 * immediately after the daemon binds its socket and logs "ready", so
 * the first real sync call does not block on a cold model load.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Mock @huggingface/transformers so no real model download occurs.
// ---------------------------------------------------------------------------

vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn().mockResolvedValue(
    vi.fn().mockResolvedValue({ data: new Float32Array(384).fill(0.1) }),
  ),
}));

// ---------------------------------------------------------------------------
// Mock embed module so we can spy on warmupEmbedModel without the full
// HuggingFace stack.  We replace it with a spy that resolves instantly.
// ---------------------------------------------------------------------------

const warmupSpy = vi.fn().mockResolvedValue(42);

vi.mock('../../src/lib/embed.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/lib/embed.js')>();
  return {
    ...original,
    warmupEmbedModel: warmupSpy,
  };
});

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(process.platform === 'win32')(
  'daemon startup — embed model warmup',
  () => {
    let thinkHome: string;
    let originalThinkHome: string | undefined;
    let exitSpy: ReturnType<typeof vi.spyOn>;
    let stderrSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      originalThinkHome = process.env.THINK_HOME;
      thinkHome = mkdtempSync(join(tmpdir(), 'think-daemon-warmup-'));
      process.env.THINK_HOME = thinkHome;
      vi.resetModules();
      warmupSpy.mockClear();

      exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as () => never);
    });

    afterEach(() => {
      exitSpy.mockRestore();
      stderrSpy?.mockRestore();
      if (originalThinkHome === undefined) delete process.env.THINK_HOME;
      else process.env.THINK_HOME = originalThinkHome;
      rmSync(thinkHome, { recursive: true, force: true });
    });

    it('warmupEmbedModel is called after daemon binds socket and logs ready', async () => {
      // Re-import after resetModules so the mock is in effect for this module instance.
      const embedMod = await import('../../src/lib/embed.js');
      const localWarmupSpy = vi.spyOn(embedMod, 'warmupEmbedModel').mockResolvedValue(42);

      const { runDaemon } = await import('../../src/daemon/index.js');
      const socketPath = join(thinkHome, 'daemon.sock');

      // Resolve when the daemon logs "ready".
      let resolveReady!: () => void;
      const ready = new Promise<void>((r) => { resolveReady = r; });

      const origWrite = process.stderr.write.bind(process.stderr);
      stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        if (String(chunk).includes('think daemon ready')) resolveReady();
        return origWrite(chunk);
      });

      const daemonPromise = runDaemon({ socketPath, foreground: true });

      // Wait for ready signal.
      await ready;

      // Give the fire-and-forget warmup a tick to be called.
      await new Promise<void>((r) => setTimeout(r, 50));

      expect(localWarmupSpy).toHaveBeenCalledTimes(1);

      // Shut down cleanly.
      process.emit('SIGTERM');
      await daemonPromise.catch(() => {});

      localWarmupSpy.mockRestore();
    }, 15_000);
  },
);
