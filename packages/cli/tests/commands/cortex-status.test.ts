import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cortexCommand } from '../../src/commands/cortex.js';
import { createTestCortex, type TestCortex } from '../fixtures/cortex.js';
import { saveConfig, getConfig } from '../../src/lib/config.js';
import { insertRetro } from '../../src/db/retro-queries.js';
import { setSyncCursor } from '../../src/db/memory-queries.js';

// AGT-209 / GH#47: `cortex status` previously printed `Memories: 0` and
// `(never synced)` for cortexes that had retros and a successful retro
// push, because it counted only the memories table and only read the
// memories push cursor. Tests below pin the new shape.
describe('think cortex status — retro counters and cursors (AGT-209 AC #2)', () => {
  let cortex: TestCortex | null = null;

  function captureLogs(): string[] {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    return lines;
  }

  beforeEach(() => {
    cortex = createTestCortex();
    const baseConfig = getConfig();
    saveConfig({
      ...baseConfig,
      cortex: {
        active: cortex.name,
        author: 'test',
        repo: 'git@example.invalid:org/cortex.git',
      },
    });
  });

  afterEach(() => {
    cortex?.cleanup();
    cortex = null;
    vi.restoreAllMocks();
  });

  it('reports a non-zero retro count after retros are inserted', async () => {
    insertRetro(cortex!.name, { content: 'first observation', promoted: 1 });
    insertRetro(cortex!.name, { content: 'second observation', promoted: 1 });

    const lines = captureLogs();
    await cortexCommand.parseAsync(['status'], { from: 'user' });

    const retroLine = lines.find(l => l.includes('Retros:'));
    expect(retroLine).toBeDefined();
    expect(retroLine).toMatch(/Retros:\s*2/);
  });

  it('reports the retro push cursor separately from the memories push cursor', async () => {
    insertRetro(cortex!.name, { content: 'retro that was pushed', promoted: 1 });
    setSyncCursor(cortex!.name, 'git', 'push_retros', '7');

    const lines = captureLogs();
    await cortexCommand.parseAsync(['status'], { from: 'user' });

    const memoryLine = lines.find(l => l.includes('Last memory push'));
    const retroLine = lines.find(l => l.includes('Last retro push'));

    expect(memoryLine).toBeDefined();
    expect(retroLine).toBeDefined();
    // Memories never pushed → still shows the dim placeholder
    expect(memoryLine).toMatch(/Last memory push:\s*\(never synced\)/);
    // Retros DID push → cursor shows the value, not the (never synced) placeholder
    expect(retroLine).toMatch(/Last retro push:\s*7/);
    expect(retroLine).not.toMatch(/never synced/);
  });

  it('does not regress when only memories have synced', async () => {
    setSyncCursor(cortex!.name, 'git', 'push', '42');

    const lines = captureLogs();
    await cortexCommand.parseAsync(['status'], { from: 'user' });

    const memoryLine = lines.find(l => l.includes('Last memory push'));
    const retroLine = lines.find(l => l.includes('Last retro push'));

    expect(memoryLine).toMatch(/Last memory push:\s*42/);
    expect(retroLine).toMatch(/Last retro push:\s*\(never synced\)/);
  });
});
