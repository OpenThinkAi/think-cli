import { describe, it, expect, afterEach } from 'vitest';
import { createTestCortex } from './cortex.js';

describe('createTestCortex', () => {
  let cortex: ReturnType<typeof createTestCortex> | null = null;

  afterEach(() => {
    cortex?.cleanup();
    cortex = null;
  });

  it('creates an isolated cortex DB with the full migration set applied', () => {
    cortex = createTestCortex();

    const tables = cortex.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const tableNames = tables.map(t => t.name);

    expect(tableNames).toContain('engrams');
    expect(tableNames).toContain('memories');
    expect(tableNames).toContain('long_term_events');
    expect(tableNames).toContain('sync_cursors');
  });

  it('places the DB inside the test thinkHome', () => {
    cortex = createTestCortex();
    expect(process.env.THINK_HOME).toBe(cortex.thinkHome);
  });

  it('uses a unique cortex name when none is provided', () => {
    const a = createTestCortex();
    const b = createTestCortex();
    expect(a.name).not.toBe(b.name);
    a.cleanup();
    b.cleanup();
  });
});
