/**
 * `think usage` — retro-usage report.
 *
 * Reads the local surfacing log (usage.db) joined against live retros and
 * renders it as a browser view via ui-leaf. ui-leaf is an *external* runtime
 * dependency: think spawns the `ui-leaf` binary over its line-delimited JSON
 * stdio protocol rather than bundling it. If the binary isn't on PATH, we
 * print an install hint. `--json` skips ui-leaf entirely and dumps the raw
 * dataset (useful for scripting / when ui-leaf isn't installed).
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import chalk from 'chalk';
import { getRetroUsageReport } from '../db/usage-queries.js';
import { closeUsageDb } from '../db/usage-db.js';
import { closeAllCortexDbs } from '../db/engrams.js';

const VIEW_NAME = 'usage-retros';

/**
 * Resolve the shipped `views/` directory. The bundled command lives in
 * `dist/` in a published install and in `src/commands/` under `tsx` dev, so
 * the depth from this module to the package root differs. Probe both.
 */
function resolveViewsRoot(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '..', 'views'), // dist/ -> <root>/views
    path.resolve(here, '..', '..', 'views'), // src/commands/ -> <root>/views
  ];
  for (const dir of candidates) {
    if (existsSync(path.join(dir, `${VIEW_NAME}.tsx`))) return dir;
  }
  return null;
}

export const usageCommand = new Command('usage')
  .description('Open a report of how your retros surface in recall/brief')
  .option('--json', 'Print the raw report as JSON instead of opening the view')
  .addHelpText(
    'after',
    `
What it shows:
  Each retro with how often it has surfaced in 'think recall' / 'think brief',
  when it last surfaced, the queries that pulled it up, and a per-day timeline.
  Plus a "dead retros" section: retros that exist but have never been recalled.

Requirements:
  Opening the view requires the ui-leaf binary on your PATH:
    npm install -g @openthink/ui-leaf
  Use --json to read the data without ui-leaf.

Examples:
  think usage
  think usage --json | jq '.surfaced[0]'
`,
  )
  .action(async function (this: Command, opts: { json?: boolean }) {
    const report = getRetroUsageReport();

    if (opts.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      closeUsageDb();
      closeAllCortexDbs();
      return;
    }

    if (report.total_surfacings === 0 && report.dead.length === 0) {
      console.log(chalk.dim('No retros found yet. Record one with: think retro "..." --cortex <name>'));
      console.log(chalk.dim('Usage data accrues as retros surface in recall/brief.'));
      closeUsageDb();
      closeAllCortexDbs();
      return;
    }

    const viewsRoot = resolveViewsRoot();
    if (!viewsRoot) {
      console.error(chalk.red(`think usage: could not locate the ${VIEW_NAME} view.`));
      console.error(chalk.dim('Falling back to --json:'));
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      closeUsageDb();
      closeAllCortexDbs();
      process.exitCode = 1;
      return;
    }

    closeUsageDb();
    closeAllCortexDbs();

    await mountView(viewsRoot, report);
  });

/**
 * Spawn `ui-leaf mount` and drive it over line-delimited JSON stdio.
 * Resolves when the view session ends (browser closed + caller close, or the
 * child exits). Rejects only on a fatal protocol error.
 */
function mountView(viewsRoot: string, data: unknown): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn('ui-leaf', ['mount'], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        console.error(chalk.red('think usage: the `ui-leaf` binary was not found on your PATH.'));
        console.error(chalk.yellow('  Install it:  npm install -g @openthink/ui-leaf'));
        console.error(chalk.dim('  Or read the data without it:  think usage --json'));
      } else {
        console.error(chalk.red(`think usage: failed to launch ui-leaf — ${err.message}`));
      }
      process.exitCode = 1;
      resolve();
    });

    const config = {
      version: '1',
      view: VIEW_NAME,
      viewsRoot,
      data,
      port: 0,
    };
    child.stdin.write(JSON.stringify(config) + '\n');

    // Parse line-delimited JSON events from the binary's stdout.
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let event: { type?: string; url?: string; message?: string };
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type === 'ready') {
          console.log(`${chalk.green('✓')} retro usage report open at ${chalk.cyan(event.url ?? '')}`);
          console.log(chalk.dim('  Close the browser tab and press Ctrl-C here to exit.'));
        } else if (event.type === 'error') {
          console.error(chalk.red(`think usage: ui-leaf error — ${event.message ?? 'unknown'}`));
          process.exitCode = 1;
        } else if (event.type === 'closed') {
          resolve();
        }
      }
    });

    child.on('exit', () => resolve());

    // Forward Ctrl-C as a graceful close so the browser/server shut down cleanly.
    const onSigint = () => {
      try {
        child.stdin.write(JSON.stringify({ version: '1', type: 'close' }) + '\n');
      } catch {
        child.kill();
      }
    };
    process.once('SIGINT', onSigint);
  });
}
