/**
 * Tests for daemon startup — embedding model warmup (alpha.6).
 *
 * Verifies that:
 *  1. warmupEmbedModel() is AWAITED before the daemon logs "ready", so the
 *     first sync call never blocks on a cold model load (the alpha.5 bug).
 *  2. If warmupEmbedModel() rejects (optional dep missing, ONNX error), the
 *     daemon still becomes "ready" in FTS-only mode and logs a warning.
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
// Mock embed module so we can control warmupEmbedModel timing and outcome.
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

    it('warmupEmbedModel is awaited BEFORE daemon logs "ready"', async () => {
      // Use a controlled delay so we can observe that "ready" is not logged
      // until warmup resolves.
      let resolveWarmup!: (ms: number) => void;
      const warmupPromise = new Promise<number>((r) => { resolveWarmup = r; });

      // Re-import after resetModules so the mock is in effect for this module instance.
      const embedMod = await import('../../src/lib/embed.js');
      const localWarmupSpy = vi.spyOn(embedMod, 'warmupEmbedModel').mockReturnValue(warmupPromise);

      const { runDaemon } = await import('../../src/daemon/index.js');
      const socketPath = join(thinkHome, 'daemon.sock');

      const logLines: string[] = [];
      let resolveReady!: () => void;
      const readyPromise = new Promise<void>((r) => { resolveReady = r; });

      const origWrite = process.stderr.write.bind(process.stderr);
      stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        const s = String(chunk);
        logLines.push(s);
        if (s.includes('think daemon ready')) resolveReady();
        return origWrite(chunk);
      });

      const daemonPromise = runDaemon({ socketPath, foreground: true });

      // Let the daemon get to the warmup await point, but don't let warmup complete.
      await new Promise<void>((r) => setTimeout(r, 100));

      // "ready" must NOT have been logged yet.
      const readyLoggedBeforeWarmup = logLines.some((l) => l.includes('think daemon ready'));
      expect(readyLoggedBeforeWarmup).toBe(false);

      // Now resolve warmup — this should unblock the "ready" log.
      resolveWarmup(34259);
      await readyPromise;

      // Confirm "loaded" was logged before "ready".
      const loadedIdx = logLines.findIndex((l) => l.includes('embed-model: loaded'));
      const readyIdx  = logLines.findIndex((l) => l.includes('think daemon ready'));
      expect(loadedIdx).toBeGreaterThanOrEqual(0);
      expect(readyIdx).toBeGreaterThanOrEqual(0);
      expect(loadedIdx).toBeLessThan(readyIdx);

      // Shut down cleanly.
      process.emit('SIGTERM');
      await daemonPromise.catch(() => {});

      localWarmupSpy.mockRestore();
    }, 15_000);

    it('daemon still reaches "ready" (FTS-only mode) when warmup fails', async () => {
      const warmupError = new Error('onnxruntime ABI mismatch');

      const embedMod = await import('../../src/lib/embed.js');
      const localWarmupSpy = vi.spyOn(embedMod, 'warmupEmbedModel').mockRejectedValue(warmupError);

      const { runDaemon } = await import('../../src/daemon/index.js');
      const socketPath = join(thinkHome, 'daemon.sock');

      const logLines: string[] = [];
      let resolveReady!: () => void;
      const readyPromise = new Promise<void>((r) => { resolveReady = r; });

      const origWrite = process.stderr.write.bind(process.stderr);
      stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        const s = String(chunk);
        logLines.push(s);
        if (s.includes('think daemon ready')) resolveReady();
        return origWrite(chunk);
      });

      const daemonPromise = runDaemon({ socketPath, foreground: true });

      // Should still reach "ready" even though warmup rejected.
      await readyPromise;

      // A warning log must have been emitted.
      const warnLogged = logLines.some((l) => l.includes('embed-model: WARN warmup failed'));
      expect(warnLogged).toBe(true);

      // "ready" must appear.
      const readyLogged = logLines.some((l) => l.includes('think daemon ready'));
      expect(readyLogged).toBe(true);

      // Shut down cleanly.
      process.emit('SIGTERM');
      await daemonPromise.catch(() => {});

      localWarmupSpy.mockRestore();
    }, 15_000);
  },
);
