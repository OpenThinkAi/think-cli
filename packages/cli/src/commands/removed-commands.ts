import { Command } from 'commander';

/**
 * think-3 (AGT-1325): AGT-1303 deleted `curate`, `monitor`, `curator`,
 * `migrate-data`, `log` and `cortex auto-curate`/`auto-sync` outright, so
 * typing one after upgrading fell through to commander's generic "unknown
 * command … (Did you mean …?)" — no hint the command was removed or what
 * replaced it, unlike the removed *flags* (AGT-1297/1303), which already got
 * our own one-line pointer. This module re-registers each name as a HIDDEN
 * command (excluded from `--help`, the generated command table, and the
 * vocabulary lint's scanned surfaces — see `program.ts`, same treatment as
 * `refresh-blocks-internal`, AGT-1306) whose only job is to print the
 * pointer and exit non-zero. There is no functionality behind any of these
 * names — the tier (or, for `migrate-data`/`curator`, the feature) they
 * belonged to is gone.
 *
 * `.allowUnknownOption()` plus a variadic optional `[args...]` argument
 * mean a muscle-memory invocation carrying the command's old flags or
 * arguments (`think curate --episode foo`, `think curator show`) still
 * reaches the pointer instead of tripping commander's own "unknown option"
 * or "too many arguments" error first — the whole point is that the
 * pointer is what the user sees, not a different generic error.
 */
function removedCommand(name: string, message: string): Command {
  return new Command(name)
    .allowUnknownOption()
    .allowExcessArguments()
    .argument('[args...]')
    .action(() => {
      process.stderr.write(`error: ${message}\n`);
      process.exitCode = 1;
    });
}

export const curateCommand = removedCommand(
  'curate',
  'think curate has been removed — the daemon compacts memories now; `think curate-retros` is a different command and still exists',
);

export const monitorCommand = removedCommand(
  'monitor',
  'think monitor has been removed; use `think recall` or `think memory` instead',
);

export const curatorCommand = removedCommand(
  'curator',
  'think curator has been removed — nothing to run (there is no curator prompt to guide)',
);

export const migrateDataCommand = removedCommand(
  'migrate-data',
  'think migrate-data has been removed; run `think migrate-engrams --dry-run` (or `think doctor --fix`) for the stranded-row rescue',
);

export const logCommand = removedCommand(
  'log',
  'think log has been removed; use `think sync` instead',
);

// Subcommands of `think cortex` — registered hidden on the `cortex` group in
// cortex.ts, the same way `program.ts` hides a top-level command.
export const cortexAutoCurateCommand = removedCommand(
  'auto-curate',
  'think cortex auto-curate has been removed — nothing to run; the daemon handles this now (see `think daemon status`)',
);

export const cortexAutoSyncCommand = removedCommand(
  'auto-sync',
  'think cortex auto-sync has been removed — nothing to run; the daemon handles this now (see `think daemon status`)',
);
