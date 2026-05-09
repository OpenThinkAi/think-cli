import { Command } from 'commander';
import chalk from 'chalk';
import { readAuditLog, pruneAuditLog, type AuditEntry } from '../lib/audit.js';

const typeLabels: Record<AuditEntry['type'], (s: string) => string> = {
  'export': chalk.blue,
  'import': chalk.green,
  'network-send': chalk.yellow,
  'network-receive': chalk.cyan,
};

function formatEntry(entry: AuditEntry): string {
  const ts = entry.timestamp.slice(0, 16).replace('T', ' ');
  const colorFn = typeLabels[entry.type];
  const badge = colorFn(`[${entry.type}]`.padEnd(20));
  const peer = entry.peer === 'self' ? '' : ` peer:${entry.peer.slice(0, 8)}`;
  const host = entry.host && entry.host !== 'self' ? ` host:${entry.host}` : '';
  const file = entry.file ? ` file:${entry.file}` : '';
  return `${chalk.gray(ts)}  ${badge} ${entry.count} entries${peer}${host}${file}`;
}

export const auditCommand = new Command('audit')
  .description('Show sync audit log — what data was sent or received')
  .option('-n, --limit <n>', 'Number of entries to show', '50')
  .option('--verbose', 'Show entry IDs for each event')
  .action((opts: { limit: string; verbose?: boolean }) => {
    const entries = readAuditLog();
    const limit = parseInt(opts.limit, 10);
    const shown = entries.slice(-limit);

    if (shown.length === 0) {
      console.log(chalk.dim('No sync activity recorded.'));
      return;
    }

    for (const entry of shown) {
      console.log(formatEntry(entry));
      if (opts.verbose) {
        for (const id of entry.entryIds) {
          console.log(chalk.dim(`    ${id}`));
        }
      }
    }

    console.log(chalk.dim(`\n${shown.length} events` + (entries.length > limit ? ` (showing last ${limit} of ${entries.length})` : '')));
  });

// AGT-063: drop entries older than --before from the active log (and
// optionally the rotated archive). Useful when the audit log accumulates
// retention you don't want to keep — work-intensity patterns, peer
// relationships, file paths can all be trimmed back to a recent window.
auditCommand.addCommand(new Command('prune')
  .description('Drop audit entries older than the given date (--before <iso-date>)')
  .requiredOption('--before <date>', 'ISO-8601 date (YYYY-MM-DD or full timestamp). Entries strictly before this drop.')
  .option('--include-archive', 'Also prune the rotated archive (sync-audit.log.1)')
  .action((opts: { before: string; includeArchive?: boolean }) => {
    // Validate the cutoff parses to a real date; reject obvious garbage
    // before we rewrite the log file.
    const parsed = new Date(opts.before);
    if (Number.isNaN(parsed.getTime())) {
      console.error(chalk.red(`think audit prune: --before ${JSON.stringify(opts.before)} is not a valid ISO date.`));
      process.exitCode = 1;
      return;
    }

    // Re-emit the cutoff as a normalized ISO so the comparison against
    // entry timestamps is unambiguous (the entries are written as
    // `new Date().toISOString()` upstream).
    const cutoffIso = parsed.toISOString();
    const pruned = pruneAuditLog(cutoffIso, { includeArchive: opts.includeArchive });

    if (pruned === 0) {
      console.log(chalk.dim(`No audit entries before ${cutoffIso}.`));
    } else {
      const scope = opts.includeArchive ? 'active log + archive' : 'active log';
      console.log(`${chalk.green('✓')} Pruned ${pruned} audit entr${pruned === 1 ? 'y' : 'ies'} from the ${scope} (cutoff: ${cutoffIso}).`);
    }
  }));
