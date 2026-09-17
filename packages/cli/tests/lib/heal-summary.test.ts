/**
 * Tests for lib/heal-summary.ts (AGT-1307) — the first interactive command
 * after a self-heal prints a one-time summary of what was migrated, removed
 * and refreshed.
 *
 * Covers AC2/AC3 directly: print-once behaviour, zero-count silence, and the
 * `--silent` / non-TTY routing to `daemon.log`. The daemon-driven end-to-end
 * path (a real `runDaemon()` writing the record, picked up by the next CLI
 * command) lives in tests/daemon/heal-summary-start.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import {
  recordHealAction,
  consumeHealSummary,
  formatHealSummaryLines,
  reportPendingHeal,
} from '../../src/lib/heal-summary.js';
import { getThinkDir } from '../../src/lib/paths.js';

function daemonLogPath(): string {
  return join(getThinkDir(), 'daemon.log');
}

/** A minimal actionCommand shaped the way commander hands one to preAction:
 *  a leaf command, possibly nested under parents, with local `.opts()`. */
function fakeCommand(opts: {
  name?: string;
  silent?: boolean;
  json?: boolean;
  parentName?: string;
} = {}): Command {
  const cmd = new Command(opts.name ?? 'sync');
  if (opts.silent !== undefined) cmd.option('--silent').setOptionValueWithSource('silent', opts.silent, 'cli');
  if (opts.json !== undefined) cmd.option('--json').setOptionValueWithSource('json', opts.json, 'cli');
  if (opts.parentName) {
    const parent = new Command(opts.parentName);
    parent.addCommand(cmd);
  }
  return cmd;
}

describe('heal-summary', () => {
  let thinkHome: string;
  let prevThinkHome: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let prevIsTTY: boolean | undefined;

  beforeEach(() => {
    thinkHome = mkdtempSync(join(tmpdir(), 'think-heal-summary-'));
    prevThinkHome = process.env.THINK_HOME;
    process.env.THINK_HOME = thinkHome;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    prevIsTTY = process.stdout.isTTY;
  });

  afterEach(() => {
    logSpy.mockRestore();
    rmSync(thinkHome, { recursive: true, force: true });
    if (prevThinkHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = prevThinkHome;
    Object.defineProperty(process.stdout, 'isTTY', { value: prevIsTTY, configurable: true });
  });

  function setTTY(value: boolean): void {
    Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true });
  }

  // -------------------------------------------------------------------------
  // AC2 — zero-count silence
  // -------------------------------------------------------------------------

  it('recordHealAction(kind, 0) never creates a pending record', () => {
    recordHealAction('migratedRows', 0);
    recordHealAction('removedLaunchAgents', 0);
    recordHealAction('refreshedBlocks', 0);
    expect(existsSync(join(thinkHome, 'heal-summary.json'))).toBe(false);
    expect(consumeHealSummary()).toBeNull();
  });

  it('reportPendingHeal prints nothing and touches nothing when no heal is pending', () => {
    setTTY(true);
    reportPendingHeal(fakeCommand());
    expect(logSpy).not.toHaveBeenCalled();
    expect(existsSync(daemonLogPath())).toBe(false);
  });

  // -------------------------------------------------------------------------
  // AC1/AC3 — print-once behaviour
  // -------------------------------------------------------------------------

  it('consumeHealSummary returns the record once, then null forever after', () => {
    recordHealAction('migratedRows', 3);
    recordHealAction('removedLaunchAgents', 2);

    const first = consumeHealSummary();
    expect(first).not.toBeNull();
    expect(first!.counts).toEqual({ migratedRows: 3, removedLaunchAgents: 2, refreshedBlocks: 0 });

    expect(consumeHealSummary()).toBeNull();
    expect(consumeHealSummary()).toBeNull(); // repeated calls stay null — not a one-shot fluke
  });

  it('reportPendingHeal prints the block once on an interactive TTY, then never again', () => {
    setTTY(true);
    recordHealAction('migratedRows', 5);
    recordHealAction('refreshedBlocks', 1);

    reportPendingHeal(fakeCommand());
    expect(logSpy).toHaveBeenCalled();
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('healed itself');
    expect(printed).toContain('migrated 5 stranded rows');
    expect(printed).toContain('refreshed 1 managed block');
    expect(printed).toContain('think doctor');
    // No v2/v3 wording anywhere in the rendered text (think-3 "Version and
    // vocabulary" — user-facing text just says "think").
    expect(printed).not.toMatch(/\bv[23]\b/i);

    logSpy.mockClear();
    reportPendingHeal(fakeCommand());
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('folds a second action into the same pending record before it is shown', () => {
    recordHealAction('migratedRows', 1);
    recordHealAction('removedLaunchAgents', 4); // e.g. a later `think update`, same unshown heal

    const summary = consumeHealSummary();
    expect(summary!.counts).toEqual({ migratedRows: 1, removedLaunchAgents: 4, refreshedBlocks: 0 });
  });

  it('a nonzero action after a heal was shown starts a fresh pending record', () => {
    recordHealAction('migratedRows', 1);
    expect(consumeHealSummary()).not.toBeNull();

    recordHealAction('refreshedBlocks', 2);
    const second = consumeHealSummary();
    expect(second!.counts).toEqual({ migratedRows: 0, removedLaunchAgents: 0, refreshedBlocks: 2 });
  });

  // -------------------------------------------------------------------------
  // AC2 — --silent / non-TTY route to daemon.log instead of stdout
  // -------------------------------------------------------------------------

  it('routes to daemon.log instead of stdout under --silent', () => {
    setTTY(true); // TTY, but --silent still wins
    recordHealAction('migratedRows', 2);

    reportPendingHeal(fakeCommand({ silent: true }));
    expect(logSpy).not.toHaveBeenCalled();
    expect(existsSync(daemonLogPath())).toBe(true);
    expect(readFileSync(daemonLogPath(), 'utf-8')).toContain('migrated 2 stranded rows');

    // And it was still consumed — a --silent command doesn't leave it pending.
    expect(consumeHealSummary()).toBeNull();
  });

  it('routes to daemon.log instead of stdout when stdout is not a TTY', () => {
    setTTY(false);
    recordHealAction('removedLaunchAgents', 7);

    reportPendingHeal(fakeCommand());
    expect(logSpy).not.toHaveBeenCalled();
    expect(readFileSync(daemonLogPath(), 'utf-8')).toContain('removed 7 stale launch agents');
  });

  it('appends to an existing daemon.log rather than truncating it', () => {
    const logPath = daemonLogPath();
    mkdirSync(thinkHome, { recursive: true });
    writeFileSync(logPath, '[preexisting] daemon line\n');

    setTTY(false);
    recordHealAction('migratedRows', 1);
    reportPendingHeal(fakeCommand());

    const contents = readFileSync(logPath, 'utf-8');
    expect(contents).toContain('[preexisting] daemon line');
    expect(contents).toContain('migrated 1 stranded row');
  });

  // -------------------------------------------------------------------------
  // Exempt commands — never printed, never consumed, never logged
  // -------------------------------------------------------------------------

  it('never touches the pending record for a `think daemon` subcommand', () => {
    setTTY(true);
    recordHealAction('migratedRows', 1);

    reportPendingHeal(fakeCommand({ name: 'start', parentName: 'daemon' }));
    expect(logSpy).not.toHaveBeenCalled();
    expect(existsSync(daemonLogPath())).toBe(false);

    // Still pending for the next real command.
    const summary = consumeHealSummary();
    expect(summary!.counts.migratedRows).toBe(1);
  });

  it('never touches the pending record for the hidden refresh-blocks-internal command', () => {
    setTTY(true);
    recordHealAction('refreshedBlocks', 1);

    reportPendingHeal(fakeCommand({ name: 'refresh-blocks-internal' }));
    expect(logSpy).not.toHaveBeenCalled();
    expect(existsSync(daemonLogPath())).toBe(false);
    expect(consumeHealSummary()!.counts.refreshedBlocks).toBe(1);
  });

  it('never touches the pending record for a --json invocation', () => {
    setTTY(true);
    recordHealAction('migratedRows', 1);

    reportPendingHeal(fakeCommand({ json: true }));
    expect(logSpy).not.toHaveBeenCalled();
    expect(existsSync(daemonLogPath())).toBe(false);
    expect(consumeHealSummary()!.counts.migratedRows).toBe(1);
  });

  // -------------------------------------------------------------------------
  // formatHealSummaryLines — plain-text rendering used by both paths
  // -------------------------------------------------------------------------

  it('formatHealSummaryLines omits a zero-count action entirely', () => {
    const lines = formatHealSummaryLines({ migratedRows: 0, removedLaunchAgents: 3, refreshedBlocks: 0 });
    expect(lines.some((l) => l.includes('migrated'))).toBe(false);
    expect(lines.some((l) => l.includes('refreshed'))).toBe(false);
    expect(lines.some((l) => l.includes('removed 3 stale launch agents'))).toBe(true);
  });
});
