import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SyncAdapter, SyncResult } from '../../src/sync/types.js';

vi.mock('../../src/sync/registry.js', () => ({
  getSyncAdapter: vi.fn(),
}));

// Import after mock is registered
const { getSyncAdapter } = await import('../../src/sync/registry.js');
const { pullForRead, pushForWriteBackground } = await import('../../src/lib/auto-propagate.js');

function makeStubAdapter(overrides: Partial<SyncAdapter> = {}): SyncAdapter {
  return {
    name: 'stub',
    isAvailable: vi.fn().mockReturnValue(true),
    isReachable: vi.fn().mockResolvedValue(true),
    pull: vi.fn().mockResolvedValue({ pushed: 0, pulled: 3, errors: [] } satisfies SyncResult),
    push: vi.fn().mockResolvedValue({ pushed: 1, pulled: 0, errors: [] } satisfies SyncResult),
    sync: vi.fn().mockResolvedValue({ pushed: 1, pulled: 3, errors: [] } satisfies SyncResult),
    listRemoteCortexes: vi.fn().mockResolvedValue([]),
    createCortex: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('pullForRead', () => {
  let originalHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-ap-test-'));
    process.env.THINK_HOME = tmpHome;
    vi.mocked(getSyncAdapter).mockReset();
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('calls adapter.pull when adapter is available and reachable', async () => {
    const adapter = makeStubAdapter();
    vi.mocked(getSyncAdapter).mockReturnValue(adapter);

    await pullForRead('test-cortex');

    expect(adapter.isReachable).toHaveBeenCalledOnce();
    expect(adapter.pull).toHaveBeenCalledWith('test-cortex');
  });

  it('skips pull when opts.skip is true', async () => {
    const adapter = makeStubAdapter();
    vi.mocked(getSyncAdapter).mockReturnValue(adapter);

    await pullForRead('test-cortex', { skip: true });

    expect(adapter.pull).not.toHaveBeenCalled();
    expect(adapter.isReachable).not.toHaveBeenCalled();
  });

  it('no-ops when no adapter is configured', async () => {
    vi.mocked(getSyncAdapter).mockReturnValue(null);

    await expect(pullForRead('test-cortex')).resolves.toBeUndefined();
  });

  it('no-ops when adapter.isAvailable() returns false', async () => {
    const adapter = makeStubAdapter({ isAvailable: vi.fn().mockReturnValue(false) });
    vi.mocked(getSyncAdapter).mockReturnValue(adapter);

    await pullForRead('test-cortex');

    expect(adapter.pull).not.toHaveBeenCalled();
  });

  it('no-ops (does not call pull) when remote is unreachable', async () => {
    const adapter = makeStubAdapter({ isReachable: vi.fn().mockResolvedValue(false) });
    vi.mocked(getSyncAdapter).mockReturnValue(adapter);

    await pullForRead('test-cortex');

    expect(adapter.pull).not.toHaveBeenCalled();
  });

  it('swallows errors from adapter.pull without throwing', async () => {
    const adapter = makeStubAdapter({
      pull: vi.fn().mockRejectedValue(new Error('network timeout')),
    });
    vi.mocked(getSyncAdapter).mockReturnValue(adapter);

    await expect(pullForRead('test-cortex')).resolves.toBeUndefined();
  });

  it('swallows errors from adapter.isReachable without throwing', async () => {
    const adapter = makeStubAdapter({
      isReachable: vi.fn().mockRejectedValue(new Error('dns failure')),
    });
    vi.mocked(getSyncAdapter).mockReturnValue(adapter);

    await expect(pullForRead('test-cortex')).resolves.toBeUndefined();
  });
});

describe('pushForWriteBackground', () => {
  let originalHome: string | undefined;
  let tmpHome: string;
  let originalArgv1: string;

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-ap-bg-test-'));
    process.env.THINK_HOME = tmpHome;
    originalArgv1 = process.argv[1];
    vi.mocked(getSyncAdapter).mockReset();
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    process.argv[1] = originalArgv1;
    vi.clearAllMocks();
  });

  it('no-ops when opts.skip is true', () => {
    const adapter = makeStubAdapter();
    vi.mocked(getSyncAdapter).mockReturnValue(adapter);

    // Should not throw even with no binary set
    expect(() => pushForWriteBackground('test-cortex', { skip: true })).not.toThrow();
  });

  it('no-ops when no adapter is configured', () => {
    vi.mocked(getSyncAdapter).mockReturnValue(null);

    expect(() => pushForWriteBackground('test-cortex')).not.toThrow();
  });

  it('no-ops when adapter.isAvailable() returns false', () => {
    const adapter = makeStubAdapter({ isAvailable: vi.fn().mockReturnValue(false) });
    vi.mocked(getSyncAdapter).mockReturnValue(adapter);

    expect(() => pushForWriteBackground('test-cortex')).not.toThrow();
  });

  it('no-ops when process.argv[1] is not a valid path', () => {
    const adapter = makeStubAdapter();
    vi.mocked(getSyncAdapter).mockReturnValue(adapter);
    process.argv[1] = '/nonexistent/think-binary';

    expect(() => pushForWriteBackground('test-cortex')).not.toThrow();
  });
});
