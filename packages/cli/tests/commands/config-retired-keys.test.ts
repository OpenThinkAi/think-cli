/**
 * AGT-1303 AC6 — setting a key the engram tier removal orphaned prints a
 * "no longer used" note; it does not fail.
 *
 * This exists because the failure mode is invisible by inspection: if a key is
 * in `RETIRED_KEYS` but not in `ALLOWED_KEYS`, `think config set` rejects it
 * with "Unknown config key" and exits 1 *before* the advisory branch runs —
 * which is precisely the failure AC6 forbids, produced by code that reads as
 * though it handles the key. config-cmd.ts now derives ALLOWED_KEYS from
 * RETIRED_KEYS so the two cannot drift; this test pins the behaviour end to
 * end for every key rather than trusting that derivation stays in place.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { configCommand } from '../../src/commands/config-cmd.js';
import { getConfigDir } from '../../src/lib/config.js';

// Every key AGT-1303 orphaned. Kept as a literal list, not imported from the
// source, so that deleting a key from RETIRED_KEYS fails this test instead of
// silently shrinking what it checks.
const RETIRED = [
  'cortex.curateEveryN',
  'cortex.engramTTLDays',
  'cortex.curatorPromptCharCap',
  'cortex.selectivity',
  'cortex.granularity',
  'cortex.maxMemoriesPerRun',
  'cortex.confirmBeforeCommit',
  'cortex.idleWindowMinutes',
  'cortex.staleWindowMinutes',
];

describe('think config set — retired engram-tier keys (AGT-1303 AC6)', () => {
  let originalHome: string | undefined;
  let tmpHome: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderr: ReturnType<typeof vi.spyOn>;
  let logs: string[];

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-retired-keys-'));
    process.env.THINK_HOME = tmpHome;

    logs = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { logs.push(String(line)); });
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => { logs.push(String(line)); });
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // `config set` calls process.exit(1) on a rejected key — turn that into a
    // throw so a regression surfaces as a failed assertion, not a dead worker.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function makeProgram(): Command {
    const prog = new Command();
    prog.addCommand(configCommand);
    return prog;
  }

  for (const key of RETIRED) {
    it(`accepts ${key} with a note instead of rejecting it`, async () => {
      await makeProgram().parseAsync(['node', 'think', 'config', 'set', key, '5']);

      // Not a failure: no process.exit, and the write is confirmed on stdout.
      expect(exitSpy).not.toHaveBeenCalled();
      expect(logs.join('\n')).toContain(`${key} = 5`);

      // ...and the user is told it will have no effect.
      const notes = stderr.mock.calls.flat().join('');
      expect(notes).toContain(key);
      expect(notes).toContain('no longer used');

      // The value really landed in the config file — "accepted" means written,
      // not swallowed.
      const configPath = join(getConfigDir(), 'config.json');
      expect(existsSync(configPath)).toBe(true);
      const persisted = JSON.parse(readFileSync(configPath, 'utf-8')) as {
        cortex?: Record<string, unknown>;
      };
      expect(persisted.cortex?.[key.slice('cortex.'.length)]).toBe(5);
    });
  }

  it('still rejects a genuinely unknown key', async () => {
    // The retired-key allowance must not have widened into "accept anything".
    await expect(
      makeProgram().parseAsync(['node', 'think', 'config', 'set', 'cortex.notARealKey', '5']),
    ).rejects.toThrow(/process\.exit\(1\)/);
    expect(logs.join('\n')).toMatch(/Unknown config key/);
  });
});
