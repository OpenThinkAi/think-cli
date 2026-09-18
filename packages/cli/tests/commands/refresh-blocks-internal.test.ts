/**
 * Tests for commands/refresh-blocks-internal.ts (AGT-1306) — the hidden CLI
 * entry point `think update` re-execs into so the block refresh always runs
 * against the newly installed template. Covers: it is hidden from --help,
 * and it prints exactly one machine-readable JSON line for the parent
 * process to parse.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { refreshBlocksInternalCommand } from '../../src/commands/refresh-blocks-internal.js';
import { initCommand } from '../../src/commands/init.js';
import { buildProgram } from '../../src/program.js';

describe('refresh-blocks-internal', () => {
  let homeRoot: string;
  let projectDir: string;
  let prevHome: string | undefined;
  let stdoutWrites: string[];

  beforeEach(() => {
    homeRoot = mkdtempSync(path.join(tmpdir(), 'think-refresh-internal-home-'));
    projectDir = mkdtempSync(path.join(tmpdir(), 'think-refresh-internal-project-'));
    prevHome = process.env.HOME;
    process.env.HOME = homeRoot;
    stdoutWrites = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    rmSync(homeRoot, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    vi.restoreAllMocks();
  });

  it('command name matches the subcommand refreshBlocksViaBin spawns', () => {
    expect(refreshBlocksInternalCommand.name()).toBe('refresh-blocks-internal');
  });

  it('is registered with { hidden: true } in the program, so it never surfaces in --help', () => {
    // AGT-1311 factored program assembly out of src/index.ts (which
    // unconditionally calls `.parse()` at module scope, so it can't be
    // imported directly in tests) into src/program.ts's buildProgram(),
    // which both index.ts and the generated-command-table script call. That
    // makes the real registered Command inspectable here directly, instead
    // of regex-matching index.ts's source text for the addCommand call.
    const program = buildProgram();
    const cmd = program.commands.find((c) => c.name() === 'refresh-blocks-internal');
    expect(cmd).toBeDefined();
    // `_hidden` is commander's own (unprefixed-by-`#`, so accessible, but not
    // part of the public typings) flag set by `addCommand(cmd, { hidden: true })`
    // — see node_modules/commander/lib/command.js's addCommand.
    expect((cmd as unknown as { _hidden?: boolean })._hidden).toBe(true);
  });

  it('prints exactly one JSON line describing the refresh result', async () => {
    await initCommand.parseAsync(['--dir', projectDir, '--yes'], { from: 'user' });
    stdoutWrites = []; // clear init's own output (none expected on stdout, but be safe)

    await refreshBlocksInternalCommand.parseAsync([], { from: 'user' });

    expect(stdoutWrites).toHaveLength(1);
    const parsed = JSON.parse(stdoutWrites[0]);
    expect(parsed).toHaveProperty('refreshed');
    expect(parsed).toHaveProperty('failures');
    expect(Array.isArray(parsed.refreshed)).toBe(true);
    expect(Array.isArray(parsed.failures)).toBe(true);
  });

  it('prints an empty result when nothing is registered', async () => {
    await refreshBlocksInternalCommand.parseAsync([], { from: 'user' });
    expect(JSON.parse(stdoutWrites[0])).toEqual({ refreshed: [], failures: [] });
  });
});
