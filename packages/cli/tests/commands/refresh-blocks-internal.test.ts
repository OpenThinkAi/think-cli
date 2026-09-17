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
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { refreshBlocksInternalCommand } from '../../src/commands/refresh-blocks-internal.js';
import { initCommand } from '../../src/commands/init.js';

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

  it('is registered with { hidden: true } in index.ts, so it never surfaces in --help', () => {
    // index.ts unconditionally calls `program.parse()` at module scope, so it
    // can't be imported directly in tests — assert the registration in its
    // source instead. `program.addCommand(cmd, { hidden: true })` is the only
    // supported way (this commander version) to hide a prepared Command; see
    // node_modules/commander/lib/command.js's addCommand.
    const indexPath = fileURLToPath(new URL('../../src/index.ts', import.meta.url));
    const source = readFileSync(indexPath, 'utf-8');
    expect(source).toMatch(
      /addCommand\(refreshBlocksInternalCommand,\s*\{\s*hidden:\s*true\s*\}\)/,
    );
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
