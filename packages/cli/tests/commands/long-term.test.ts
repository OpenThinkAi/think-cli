import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { closeAllCortexDbs, getCortexDb } from '../../src/db/engrams.js';
import { insertMemory } from '../../src/db/memory-queries.js';
import { saveConfig, getConfig } from '../../src/lib/config.js';

// Mock the Anthropic SDK at the module boundary so we can assert call counts
// without contacting the network. The real `query()` is an async generator;
// the mock returns a generator that yields one `result` message — but we
// also assert on the spy itself to verify --dry-run doesn't even invoke it.
const querySpy = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: querySpy,
}));

// Import the command AFTER the mock so its module-level `query` import binds
// to the spy. Top-of-file import would race the hoisted mock and bind to
// the real export.
const { longTermCommand } = await import('../../src/commands/long-term.js');

function makeProgram(): Command {
  const prog = new Command();
  prog.addCommand(longTermCommand);
  return prog;
}

// AGT-061: --dry-run was shipping memory data to Anthropic before the local
// "would write" check. The fix bails before runBackfillBatch is invoked.
// AC #1 is verified by asserting the SDK is never called on a --dry-run
// invocation.
describe('think long-term backfill — dry-run privacy (AGT-061)', () => {
  let originalHome: string | undefined;
  let tmpHome: string;
  const cortex = 'longterm-dry-run-test';

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-longterm-dryrun-'));
    process.env.THINK_HOME = tmpHome;
    closeAllCortexDbs();
    getCortexDb(cortex);
    saveConfig({
      ...getConfig(),
      cortex: { author: 'test', active: cortex },
    });
    // Seed two months of memories so a real backfill would do >1 SDK call.
    insertMemory(cortex, { ts: '2026-01-15T10:00:00Z', author: 'test', content: 'january memory 1' });
    insertMemory(cortex, { ts: '2026-01-20T10:00:00Z', author: 'test', content: 'january memory 2' });
    insertMemory(cortex, { ts: '2026-02-10T10:00:00Z', author: 'test', content: 'february memory 1' });
    querySpy.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    closeAllCortexDbs();
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  it('--dry-run makes zero Claude SDK calls (AC #1)', async () => {
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'long-term', 'backfill', '--dry-run']);

    expect(querySpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBeFalsy();
  });

  it('--dry-run output names "no data sent to Anthropic" explicitly (AC #2)', async () => {
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'long-term', 'backfill', '--dry-run']);

    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(output).toMatch(/local only.*no data sent to Anthropic/i);
    // Per-month breakdown surfaces — the user can see scope without seeing the actual prompt
    expect(output).toMatch(/2026-01.*2 memories/);
    expect(output).toMatch(/2026-02.*1 memories/);
    // Envelope description present
    expect(output).toMatch(/Prompt envelope/i);
  });

  it('--dry-run points users at --preview-prompt for the LLM-driven preview (AC #3)', async () => {
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'long-term', 'backfill', '--dry-run']);

    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(output).toMatch(/--preview-prompt/);
    expect(output).toMatch(/DOES contact Anthropic/i);
  });

  it('--dry-run and --preview-prompt are mutually exclusive', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    const prog = makeProgram();
    await expect(
      prog.parseAsync(['node', 'think', 'long-term', 'backfill', '--dry-run', '--preview-prompt']),
    ).rejects.toThrow(/process\.exit\(1\)/);

    expect(querySpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});
