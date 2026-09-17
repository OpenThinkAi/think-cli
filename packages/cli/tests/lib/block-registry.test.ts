/**
 * Tests for lib/block-registry.ts (AGT-1305) — the registry of files
 * `think init` has written a managed block into.
 *
 * Covers: idempotent recording (no duplicate entries on re-run or on
 * kind-switch within the same slot), coexistence of independent slots
 * (work-log + retro on the same file), stale-entry pruning (file deleted,
 * or markers removed by hand), atomic writes, and tolerance of a missing
 * or corrupt registry file.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordBlockWrite, listRegisteredBlocks } from '../../src/lib/block-registry.js';
import { getBlockRegistryPath } from '../../src/lib/paths.js';

const BEGIN_A = '<!-- think:begin -->';
const END_A = '<!-- think:end -->';
const BEGIN_B = '<!-- think:retro:begin -->';
const END_B = '<!-- think:retro:end -->';

describe('block-registry', () => {
  let thinkHome: string;
  let prevThinkHome: string | undefined;
  let projectDir: string;

  beforeEach(() => {
    thinkHome = mkdtempSync(join(tmpdir(), 'think-block-registry-home-'));
    prevThinkHome = process.env.THINK_HOME;
    process.env.THINK_HOME = thinkHome;
    projectDir = mkdtempSync(join(tmpdir(), 'think-block-registry-project-'));
  });

  afterEach(() => {
    rmSync(thinkHome, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
    if (prevThinkHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = prevThinkHome;
  });

  function claudeMdWithMarkers(begin: string, end: string): string {
    const p = join(projectDir, 'CLAUDE.md');
    writeFileSync(p, `${begin}\nbody\n${end}\n`, 'utf-8');
    return p;
  }

  it('records a new entry and lists it back', () => {
    const claudePath = claudeMdWithMarkers(BEGIN_A, END_A);

    recordBlockWrite(claudePath, 'work-log', BEGIN_A, END_A);

    const entries = listRegisteredBlocks();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ path: claudePath, kind: 'work-log' });
  });

  it('re-running for the same file/slot does not duplicate — it updates in place', () => {
    const claudePath = claudeMdWithMarkers(BEGIN_A, END_A);

    recordBlockWrite(claudePath, 'work-log', BEGIN_A, END_A);
    recordBlockWrite(claudePath, 'work-log', BEGIN_A, END_A);
    recordBlockWrite(claudePath, 'work-log', BEGIN_A, END_A);

    expect(listRegisteredBlocks()).toHaveLength(1);
  });

  it('switching kind within the same slot (minimal <-> work-log) replaces the entry, not adds one', () => {
    const claudePath = claudeMdWithMarkers(BEGIN_A, END_A);

    recordBlockWrite(claudePath, 'minimal', BEGIN_A, END_A);
    expect(listRegisteredBlocks()).toEqual([
      { path: claudePath, kind: 'minimal', beginMarker: BEGIN_A, endMarker: END_A },
    ]);

    recordBlockWrite(claudePath, 'work-log', BEGIN_A, END_A);
    const entries = listRegisteredBlocks();
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('work-log');
  });

  it('work-log and retro blocks on the same file are independent entries (both slots coexist)', () => {
    const claudePath = join(projectDir, 'CLAUDE.md');
    writeFileSync(
      claudePath,
      `${BEGIN_A}\nworklog body\n${END_A}\n${BEGIN_B}\nretro body\n${END_B}\n`,
      'utf-8',
    );

    recordBlockWrite(claudePath, 'work-log', BEGIN_A, END_A);
    recordBlockWrite(claudePath, 'retro', BEGIN_B, END_B);

    const entries = listRegisteredBlocks();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.kind).sort()).toEqual(['retro', 'work-log']);
  });

  it('two files (CLAUDE.md and AGENTS.md) register as two independent entries', () => {
    const claudePath = claudeMdWithMarkers(BEGIN_A, END_A);
    const agentsPath = join(projectDir, 'AGENTS.md');
    writeFileSync(agentsPath, `${BEGIN_A}\nbody\n${END_A}\n`, 'utf-8');

    recordBlockWrite(claudePath, 'work-log', BEGIN_A, END_A);
    recordBlockWrite(agentsPath, 'work-log', BEGIN_A, END_A);

    expect(listRegisteredBlocks().map((e) => e.path).sort()).toEqual([agentsPath, claudePath].sort());
  });

  it('drops an entry once its file is deleted (pruned on next write)', () => {
    const claudePath = claudeMdWithMarkers(BEGIN_A, END_A);
    const agentsPath = join(projectDir, 'AGENTS.md');
    writeFileSync(agentsPath, `${BEGIN_A}\nbody\n${END_A}\n`, 'utf-8');

    recordBlockWrite(claudePath, 'work-log', BEGIN_A, END_A);
    recordBlockWrite(agentsPath, 'work-log', BEGIN_A, END_A);
    expect(listRegisteredBlocks()).toHaveLength(2);

    rmSync(claudePath);

    // A write elsewhere triggers the prune-on-write guarantee.
    recordBlockWrite(agentsPath, 'work-log', BEGIN_A, END_A);
    const entries = listRegisteredBlocks();
    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe(agentsPath);
  });

  it('drops an entry once its markers are hand-removed from the file (pruned on next write)', () => {
    const claudePath = claudeMdWithMarkers(BEGIN_A, END_A);
    recordBlockWrite(claudePath, 'work-log', BEGIN_A, END_A);
    expect(listRegisteredBlocks()).toHaveLength(1);

    // Hand-edit the file to remove the markers entirely.
    writeFileSync(claudePath, '# just my own notes\n', 'utf-8');

    const otherPath = join(projectDir, 'AGENTS.md');
    writeFileSync(otherPath, `${BEGIN_A}\nbody\n${END_A}\n`, 'utf-8');
    recordBlockWrite(otherPath, 'work-log', BEGIN_A, END_A);

    const entries = listRegisteredBlocks();
    expect(entries.map((e) => e.path)).toEqual([otherPath]);
  });

  it('listRegisteredBlocks prunes for display without persisting the pruned result', () => {
    const claudePath = claudeMdWithMarkers(BEGIN_A, END_A);
    recordBlockWrite(claudePath, 'work-log', BEGIN_A, END_A);

    rmSync(claudePath);
    expect(listRegisteredBlocks()).toHaveLength(0); // pruned for display

    // The underlying file was not rewritten by the read-only list call.
    const raw = JSON.parse(readFileSync(getBlockRegistryPath(), 'utf-8'));
    expect(raw).toHaveLength(1); // still there on disk — only a write prunes it
  });

  it('tolerates a missing registry file', () => {
    expect(listRegisteredBlocks()).toEqual([]);
  });

  it('tolerates a corrupt (non-JSON) registry file without throwing', () => {
    const registryPath = getBlockRegistryPath();
    // No directory exists yet — recordBlockWrite must create it.
    const claudePath = claudeMdWithMarkers(BEGIN_A, END_A);
    recordBlockWrite(claudePath, 'work-log', BEGIN_A, END_A);

    // Corrupt it.
    writeFileSync(registryPath, '{ this is not valid json', 'utf-8');
    expect(listRegisteredBlocks()).toEqual([]);

    // A subsequent write recovers cleanly (doesn't throw, and produces a
    // fresh valid registry containing just the new entry).
    expect(() => recordBlockWrite(claudePath, 'work-log', BEGIN_A, END_A)).not.toThrow();
    expect(listRegisteredBlocks()).toHaveLength(1);
  });

  it('tolerates a registry file containing something other than a JSON array', () => {
    const claudePath = claudeMdWithMarkers(BEGIN_A, END_A);
    recordBlockWrite(claudePath, 'work-log', BEGIN_A, END_A);

    writeFileSync(getBlockRegistryPath(), JSON.stringify({ not: 'an array' }), 'utf-8');
    expect(listRegisteredBlocks()).toEqual([]);
  });

  it('writes the registry atomically (no leftover temp files after a write)', () => {
    const claudePath = claudeMdWithMarkers(BEGIN_A, END_A);

    recordBlockWrite(claudePath, 'work-log', BEGIN_A, END_A);

    const registryPath = getBlockRegistryPath();
    expect(existsSync(registryPath)).toBe(true);
    const siblings = readdirSync(join(registryPath, '..'));
    expect(siblings.some((f) => f.includes('.tmp-'))).toBe(false);
  });
});
