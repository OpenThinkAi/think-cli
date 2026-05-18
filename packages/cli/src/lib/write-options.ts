/**
 * Shared CLI option definitions for write commands (sync, retro, event).
 *
 * All three commands accept `--topic <t>` (repeatable) and `--cortex <name>`.
 * This module centralises the option definitions so they stay consistent
 * across the three command files.
 *
 * Usage:
 *   addWriteOptions(cmd)  — call on the Command before .action(); returns cmd
 *   extractWriteOpts(opts) — pull the shared fields out of an opts object
 */

import type { Command } from 'commander';

/**
 * Add `--topic <t>` (repeatable) and `--cortex <name>` to a Commander command.
 * Returns the same command for chaining.
 *
 * - `--topic` accumulates into a `string[]` via the standard concat reducer.
 * - `--cortex` is an override; the active-cortex fallback is caller-side logic
 *   because each command has different rules (sync/event fall back to config;
 *   retro requires an explicit value).
 */
export function addWriteOptions(cmd: Command): Command {
  return cmd
    .option(
      '--topic <t>',
      'Tag this entry with a topic (repeatable: --topic auth --topic jwt)',
      (val: string, prev: string[]) => prev.concat([val]),
      [] as string[],
    )
    .option('--cortex <name>', 'Override the active cortex for this write');
}

/**
 * Extract the shared write options from a parsed opts object.
 * Returns `topics` as `string[] | undefined` (undefined when no --topic given,
 * so callers can cleanly omit the key from the daemon RPC params).
 */
export function extractWriteOpts(opts: { topic: string[]; cortex?: string }): {
  topics: string[] | undefined;
  cortex: string | undefined;
} {
  return {
    topics: opts.topic.length > 0 ? opts.topic : undefined,
    cortex: opts.cortex,
  };
}
