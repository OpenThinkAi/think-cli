/**
 * Smoke test for embed.ts.
 *
 * Calls embed("hello") twice, verifying:
 *   1. Both results are Float32Array of length 384.
 *   2. Second call returns within 500ms (cached pipeline — no model reload).
 *   3. Output is L2-normalized (norm ≈ 1.0) and non-zero.
 *
 * The test is skipped gracefully when the model cannot be downloaded
 * (e.g., offline CI). Set SKIP_EMBED_TEST=1 to force a skip locally.
 */
import { describe, it, expect } from 'vitest';
import embed from '../../src/lib/embed.js';

describe('embed smoke test', { skip: process.env.SKIP_EMBED_TEST === '1' }, () => {
  it('returns Float32Array of length 384 and warm call is fast', async () => {
    let first: Float32Array;
    let second: Float32Array;
    let secondMs: number;

    try {
      first = await embed('hello');

      const t1 = performance.now();
      second = await embed('hello');
      secondMs = performance.now() - t1;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Skip on model-unavailable or network errors; these are expected in offline CI.
      if (
        msg.startsWith('think:') ||
        /ENOTFOUND|ETIMEDOUT|ECONNREFUSED|socket hang up|Could not load/.test(msg)
      ) {
        console.warn(`embed smoke test skipped — model unavailable: ${msg}`);
        return;
      }
      throw err;
    }

    // Shape checks
    expect(first).toBeInstanceOf(Float32Array);
    expect(first.length).toBe(384);
    expect(second).toBeInstanceOf(Float32Array);
    expect(second.length).toBe(384);

    // Warm call should complete well under 500ms (pipeline already loaded).
    expect(secondMs).toBeLessThan(500);

    // Output is L2-normalized (norm ≈ 1.0) and non-zero.
    let sumSq = 0;
    for (const v of first) sumSq += v * v;
    const norm = Math.sqrt(sumSq);
    expect(norm).toBeGreaterThan(0.99);
    expect(norm).toBeLessThan(1.01);
  }, 120_000); // allow up to 2 min for model download on first run
});
