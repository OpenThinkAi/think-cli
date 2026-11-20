/**
 * `think forget <id>` — erase one memory from the active cortex on every peer
 * (AGT-2331).
 *
 * Routes through the daemon `forget` RPC, which hard-deletes the entry from
 * the cortex index (content, embedding, search index) and queues a
 * `kind: "tombstone"` sync line carrying only ids. Each peer removes its copy
 * when it pulls the tombstone; the hub deletes its stored copy too.
 *
 * Not a history rewrite: the original line stays in the L1 JSONL files and
 * their git history (local repo, remote, every clone) and in fs-sync bucket
 * files until someone rewrites them by hand. See docs/cortex-sync-protocol.md
 * "Forgetting a memory".
 *
 * Exit code: 1 when nothing was forgotten.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { getConfig } from '../lib/config.js';
import { connectDaemon, DaemonUnavailableError } from '../lib/daemon-client.js';

interface ForgetRpcResult {
  forgotten: boolean;
  id: string;
  ids: string[];
  derived: { id: string; content: string }[];
  alreadyForgotten: boolean;
}

function snippet(content: string): string {
  const oneLine = content.replace(/\s+/g, ' ').trim();
  return oneLine.length > 72 ? `${oneLine.slice(0, 72)}…` : oneLine;
}

export const forgetCommand = new Command('forget')
  .description('Erase a memory here, on every peer and on the hub (git history keeps it)')
  .argument('<id>', 'ID of the entry to forget (shown in `think recall` output)')
  .addHelpText(
    'after',
    `
Unlike \`think delete\` (a soft delete that keeps the text), forget removes
the entry's text and embedding from this machine's index and sends a tombstone
that carries only the id. Peers on think 3.3.0+ remove their copy when they
pull it. Older peers hide it but keep the text until they upgrade and run
\`think reindex\`.

Forget does not rewrite git history: the original line stays in the cortex's
git repo (and its remote and clones) and in fs-sync folders until you rewrite
them by hand.`,
  )
  .action(async function (this: Command, id: string) {
    const globalOpts = this.optsWithGlobals() as { cortex?: string };
    const cortex = globalOpts.cortex ?? getConfig().cortex?.active;
    if (!cortex) {
      console.error(chalk.red('Forget error: no active cortex. Set one with: think cortex switch <name>'));
      process.exitCode = 1;
      return;
    }

    let result: ForgetRpcResult;
    try {
      const client = await connectDaemon();
      try {
        result = (await client.call('forget', { cortex, id })) as ForgetRpcResult;
      } finally {
        try { client.close(); } catch { /* best-effort */ }
      }
    } catch (err) {
      if (err instanceof DaemonUnavailableError) {
        console.error(chalk.red(
          `Forget error: the daemon is required to forget from cortex '${cortex}' ` +
          `(the tombstone must be queued for sync). Start it with: think daemon start`,
        ));
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        const hint = /unknown method|method not found/i.test(msg)
          ? ' (the running daemon predates `forget`; restart it with: think daemon stop && think daemon start)'
          : '';
        console.error(chalk.red(`Forget error: ${msg}${hint}`));
      }
      process.exitCode = 1;
      return;
    }

    const badge = chalk.cyan(`[${cortex}]`);
    if (!result.forgotten) {
      const why = result.alreadyForgotten ? 'already forgotten' : `no entry with id ${id}`;
      console.log(chalk.yellow(`${badge} ${why} — nothing forgotten`));
      process.exitCode = 1;
      return;
    }

    console.log(`${chalk.green('✓')} ${badge} forgot ${id} (tombstone queued for sync)`);
    console.log(chalk.dim('  git history still holds the original line until it is rewritten by hand'));
    if (result.derived.length > 0) {
      console.log(chalk.yellow(
        `  ${result.derived.length} compacted ${result.derived.length === 1 ? 'entry summarises' : 'entries summarise'} it and ` +
        `${result.derived.length === 1 ? 'was' : 'were'} kept; forget ${result.derived.length === 1 ? 'it' : 'them'} too if needed:`,
      ));
      for (const d of result.derived) {
        console.log(chalk.dim(`  ${d.id}  ${snippet(d.content)}`));
      }
    }
  });
