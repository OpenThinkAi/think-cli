import { Command } from 'commander';
import { refreshRegisteredBlocks } from '../lib/block-refresh.js';

/**
 * Internal plumbing for `think update` (AGT-1306) — not a user-facing
 * command, hence registered with `{ hidden: true }` in index.ts so it never
 * shows up in `--help`.
 *
 * `think update` re-execs into this after `npm install -g` lands so the
 * refresh runs against the newly installed template rather than the old
 * process's in-memory copy (see lib/block-refresh.ts's `refreshBlocksViaBin`
 * doc comment). Prints exactly one JSON object to stdout — the
 * `BlockRefreshResult` — for the parent process to parse; nothing else goes
 * to stdout so that parse can't be corrupted by unrelated console output.
 */
export const refreshBlocksInternalCommand = new Command('refresh-blocks-internal')
  .description('internal: refresh every registered managed block from the current template')
  .action(() => {
    const result = refreshRegisteredBlocks();
    process.stdout.write(JSON.stringify(result) + '\n');
  });
