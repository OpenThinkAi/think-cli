import { Command } from 'commander';
import chalk from 'chalk';
import { readAuditLog, type AuditEntry } from '../lib/audit.js';

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
