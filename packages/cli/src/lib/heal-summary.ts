/**
 * The first command after a self-heal prints a one-time summary — AGT-1307.
 *
 * Self-heal (LaunchAgent reaper AGT-1301, engram migration AGT-1302, managed
 * block refresh AGT-1306) rewrites files under a teammate's HOME and pushes
 * backdated entries onto a shared cortex branch with nobody watching it
 * happen. It must be visible at least once — see the think-3 design doc,
 * "Self-heal set."
 *
 * ## The record
 *
 * A single JSON file under THINK_HOME (`heal-summary.json`) accumulates
 * counts from whichever self-heal actions ran, however many separate
 * processes performed them:
 *   - the daemon reaps LaunchAgents and migrates engrams on every start
 *     (`daemon/index.ts`)
 *   - `think update` refreshes managed blocks (`commands/update.ts`, via
 *     `lib/block-refresh.ts`) — AGT-1306 wired the refresh into `update`,
 *     not into daemon start, so this module doesn't assume both halves
 *     happen in the same process or even the same day.
 *
 * `recordHealAction()` is the write side, called once per action with the
 * count it produced (0 is a no-op — a heal that found nothing to do never
 * manufactures a pending summary). `consumeHealSummary()` is the read side,
 * driven from the CLI entry point's `preAction` hook on every command: it
 * returns the pending summary, if any, and marks it shown in the same call.
 *
 * ## Crash safety — mark shown BEFORE printing
 *
 * The window between "read the record" and "print it" is one synchronous
 * `console.log` with nothing awaited in between, but a crash could still
 * land inside it. Two ways to be wrong:
 *   - mark shown first, then crash before printing: the banner is lost.
 *   - print first, then crash before marking shown: the NEXT command prints
 *     it again.
 * This picks the first. AC1 requires "prints once and never again" — a
 * violation of "at most once" (a duplicate banner nobody asked twice for) is
 * worse than a violation of "at least once" (a banner that happens to not
 * appear), and the second failure isn't really a silent loss: every action
 * that contributed to the record already wrote its own line to `daemon.log`
 * unconditionally when it did something (see the reaper, the migration and
 * the block refresh's own logging), so the raw information survives a crash
 * in that narrow window even when the one-time banner does not.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import chalk from 'chalk';
import { getThinkDir } from './paths.js';

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

export type HealActionKind = 'migratedRows' | 'removedLaunchAgents' | 'refreshedBlocks';

export interface HealCounts {
  migratedRows: number;
  removedLaunchAgents: number;
  refreshedBlocks: number;
}

interface HealRecord {
  /** ISO timestamp of the most recent action folded into this record. */
  at: string;
  counts: HealCounts;
  shown: boolean;
}

export interface PendingHealSummary {
  at: string;
  counts: HealCounts;
}

function emptyCounts(): HealCounts {
  return { migratedRows: 0, removedLaunchAgents: 0, refreshedBlocks: 0 };
}

function getHealSummaryPath(): string {
  return path.join(getThinkDir(), 'heal-summary.json');
}

function isValidRecord(value: unknown): value is HealRecord {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.at !== 'string' || typeof v.shown !== 'boolean') return false;
  if (typeof v.counts !== 'object' || v.counts === null) return false;
  const c = v.counts as Record<string, unknown>;
  return (
    typeof c.migratedRows === 'number' &&
    typeof c.removedLaunchAgents === 'number' &&
    typeof c.refreshedBlocks === 'number'
  );
}

/**
 * Tolerates a missing file, an unreadable file, and malformed/corrupt JSON —
 * all resolve to "nothing pending" rather than throwing. A corrupt record
 * must never block every future command from running.
 */
function readRecord(): HealRecord | null {
  let raw: string;
  try {
    raw = fs.readFileSync(getHealSummaryPath(), 'utf-8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return isValidRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Write atomically: sibling temp file + rename, mirroring
 * `lib/block-registry.ts` — `rename(2)` is atomic on the same filesystem, so
 * a reader never observes a half-written record.
 */
function writeRecord(record: HealRecord): void {
  const recordPath = getHealSummaryPath();
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  const tmpPath = path.join(
    path.dirname(recordPath),
    `.heal-summary.json.tmp-${process.pid}-${Date.now()}`,
  );
  fs.writeFileSync(tmpPath, JSON.stringify(record, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmpPath, recordPath);
}

/**
 * Record that a self-heal action ran and produced `count` units of work. A
 * count of 0 is a deliberate no-op — nothing is created or touched, so a
 * heal that found nothing to do never manufactures an empty pending summary
 * (AC2: "nothing printed when all three counts are zero").
 *
 * Folds into the existing record when one is still pending (unshown): a
 * daemon start that reaps agents and migrates rows, followed later by a
 * `think update` that refreshes blocks before anyone has run an interactive
 * command in between, is still ONE heal to report, not two banners. Once a
 * record has been shown, the next nonzero action starts a fresh one.
 *
 * Best-effort: a write failure here (disk full, permissions on THINK_HOME)
 * is swallowed rather than thrown — the self-heal action it is reporting on
 * already succeeded and must not be rolled back or fail startup over a
 * summary nobody has asked to see yet.
 */
export function recordHealAction(kind: HealActionKind, count: number): void {
  if (count <= 0) return;
  try {
    const existing = readRecord();
    const counts = existing && !existing.shown ? { ...existing.counts } : emptyCounts();
    counts[kind] += count;
    writeRecord({ at: new Date().toISOString(), counts, shown: false });
  } catch {
    /* best-effort — see doc comment above */
  }
}

/**
 * Return the pending heal summary, if any, and mark it shown in the same
 * call — see the file-level doc for why "mark before print" is the right
 * crash-safety choice here. Returns null when there is nothing pending: no
 * file, an unparseable file, a record already shown, or (defensively —
 * `recordHealAction` never writes this) a record whose counts are all zero.
 */
export function consumeHealSummary(): PendingHealSummary | null {
  const record = readRecord();
  if (!record || record.shown) return null;
  const { migratedRows, removedLaunchAgents, refreshedBlocks } = record.counts;
  if (migratedRows === 0 && removedLaunchAgents === 0 && refreshedBlocks === 0) return null;

  try {
    writeRecord({ ...record, shown: true });
  } catch {
    // Could not persist "shown" — a duplicate banner from a record we could
    // not mark is worse than skipping this attempt; the next command will
    // read the same unshown record and try again.
    return null;
  }
  return { at: record.at, counts: record.counts };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Plain-text lines, shared between the colorized stdout banner and the
 * `daemon.log` fallback so the message is the same information either way.
 * Never mentions "v2"/"v3" — user-facing text says just "think" (think-3
 * design doc, "Version and vocabulary").
 */
export function formatHealSummaryLines(counts: HealCounts): string[] {
  const { migratedRows, removedLaunchAgents, refreshedBlocks } = counts;
  const lines: string[] = ['think healed itself since you last ran a command:'];
  if (migratedRows > 0) {
    lines.push(`  - migrated ${migratedRows} stranded ${migratedRows === 1 ? 'row' : 'rows'}`);
  }
  if (removedLaunchAgents > 0) {
    lines.push(
      `  - removed ${removedLaunchAgents} stale launch ${removedLaunchAgents === 1 ? 'agent' : 'agents'}`,
    );
  }
  if (refreshedBlocks > 0) {
    lines.push(`  - refreshed ${refreshedBlocks} managed ${refreshedBlocks === 1 ? 'block' : 'blocks'}`);
  }
  lines.push('Run `think doctor` for details.');
  return lines;
}

/**
 * Path shared with `lib/daemon-client.ts` / `daemon/index.ts`, which each
 * already compute this same join independently rather than import one
 * another (no shared "paths" owner for it exists yet). A CLI process cannot
 * reach the daemon's own `writeLine` closure — it lives inside a different
 * process's `runDaemon()` call — so this appends directly to the same file.
 */
function getDaemonLogPath(): string {
  return path.join(getThinkDir(), 'daemon.log');
}

/**
 * Append the summary to `daemon.log`, timestamped per line like the daemon's
 * own `writeLine`, for the cases where nothing may go to stdout (AC2:
 * `--silent`, non-TTY, all-zero — the last never reaches here since
 * `consumeHealSummary` already returns null for it). Best-effort: a CLI
 * command must never fail because it could not write a fallback log line.
 */
function appendToDaemonLog(lines: string[]): void {
  try {
    const logPath = getDaemonLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const ts = new Date().toISOString();
    const text = lines.map((line) => `[${ts}] heal-summary: ${line}\n`).join('');
    fs.appendFileSync(logPath, text);
  } catch {
    /* best-effort — see doc comment above */
  }
}

/**
 * Commands whose stdout must never receive an unrelated banner, because it
 * is either machine-parsed (`--json`, the hidden `refresh-blocks-internal`)
 * or is itself daemon lifecycle plumbing (`think daemon ...`). These are
 * skipped ENTIRELY — no read, no consume, no `daemon.log` fallback — so a
 * pending record survives untouched for the next command that actually
 * qualifies as "the next interactive `think` command" (AC1).
 */
function isExemptFromHealReporting(actionCommand: Command): boolean {
  if (actionCommand.opts().json === true) return true;
  let cmd: Command | null = actionCommand;
  while (cmd) {
    if (cmd.name() === 'daemon' || cmd.name() === 'refresh-blocks-internal') return true;
    cmd = cmd.parent;
  }
  return false;
}

/**
 * Called from the CLI entry point's `preAction` hook, once per invoked
 * command. No-ops instantly (a single failed `fs.readFileSync`) when there
 * is nothing pending, so this is cheap to run unconditionally.
 */
export function reportPendingHeal(actionCommand: Command): void {
  if (isExemptFromHealReporting(actionCommand)) return;

  const summary = consumeHealSummary();
  if (!summary) return;

  const lines = formatHealSummaryLines(summary.counts);

  const silent = actionCommand.opts().silent === true;
  const isTTY = process.stdout.isTTY === true;
  if (silent || !isTTY) {
    appendToDaemonLog(lines);
    return;
  }

  const hint = lines[lines.length - 1];
  const body = lines.slice(1, -1);
  console.log(chalk.yellow(`  ℹ ${lines[0]}`));
  for (const line of body) {
    console.log(line);
  }
  console.log(chalk.dim(`  ${hint}`));
}
