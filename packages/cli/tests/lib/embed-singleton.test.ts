/**
 * Concurrent-load test for the embed.ts singleton.
 *
 * Verifies that 10 parallel embed() calls during model load trigger exactly
 * ONE underlying pipeline() invocation (i.e., no duplicate model instantiations).
 *
 * Strategy: vi.mock('@huggingface/transformers') intercepts the lazy import
 * inside getPipeline(); vi.resetModules() + dynamic import gives a fresh module
 * state so pipelinePromise starts as null for each test run.
 *
 * Actual model download is never triggered — the mock resolves immediately.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EMBEDDING_MODEL_NAME } from '../../src/lib/embed.js';

// ---------------------------------------------------------------------------
// Mock @huggingface/transformers BEFORE any module under test is imported.
// The mock factory must be hoisted to module scope (vitest does this via
// static analysis of vi.mock calls at the top level).
// ---------------------------------------------------------------------------

vi.mock('@huggingface/transformers', () => {
  const pipelineMock = vi.fn(async (_task: string, _model: string, _opts?: unknown) => {
    // Simulate a brief async load (10ms) so concurrent callers truly race.
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    // Return a minimal Pipeline function that produces a fake 384-dim Float32Array.
    const fakePipeline = async (
      _input: string,
      _callOpts: { pooling: 'mean'; normalize: boolean }
    ): Promise<{ data: Float32Array }> => ({
      data: new Float32Array(384).fill(0.1),
    });
    return fakePipeline;
  });

  return { pipeline: pipelineMock };
});

describe('embed singleton — concurrent load dedup', () => {
  beforeEach(() => {
    // Reset the module registry so pipelinePromise resets to null for every test.
    vi.resetModules();
    // Clear call counts on all mocks so tests are independent.
    vi.clearAllMocks();
  });

  it('triggers exactly one pipeline() call when 10 embed() calls race on cold start', async () => {
    // Dynamic import AFTER resetModules gives a fresh embed.ts with pipelinePromise=null.
    const { default: embed } = await import('../../src/lib/embed.js');

    // Fire 10 concurrent embed calls before the first pipeline load settles.
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => embed(`text ${i}`))
    );

    // All 10 should return 384-dim Float32Arrays.
    for (const result of results) {
      expect(result).toBeInstanceOf(Float32Array);
      expect(result.length).toBe(384);
    }

    // Retrieve the mock from the module registry.
    const transformers = await import('@huggingface/transformers');
    const pipelineMock = transformers.pipeline as ReturnType<typeof vi.fn>;

    // The critical assertion: pipeline() was called EXACTLY ONCE despite 10 concurrent embed() calls.
    expect(pipelineMock).toHaveBeenCalledTimes(1);
    expect(pipelineMock).toHaveBeenCalledWith(
      'feature-extraction',
      EMBEDDING_MODEL_NAME,
      expect.objectContaining({ progress_callback: expect.any(Function) })
    );
  });

  it('does not call pipeline() again on a second warm batch after cold load', async () => {
    const { default: embed } = await import('../../src/lib/embed.js');

    // Cold batch
    await Promise.all(Array.from({ length: 5 }, (_, i) => embed(`cold ${i}`)));

    // Warm batch
    await Promise.all(Array.from({ length: 5 }, (_, i) => embed(`warm ${i}`)));

    const transformers = await import('@huggingface/transformers');
    const pipelineMock = transformers.pipeline as ReturnType<typeof vi.fn>;

    // Still only one load across both batches.
    expect(pipelineMock).toHaveBeenCalledTimes(1);
  });
});
