import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import chalk from 'chalk';

function getInstalledVersion(): string | null {
  try {
    const npmRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf-8' }).trim();
    const pkgPath = path.join(npmRoot, 'open-think', 'package.json');
    if (!fs.existsSync(pkgPath)) return null;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

function getLatestPublishedVersion(): string | null {
  try {
    const v = execFileSync('npm', ['view', 'open-think', 'version'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return v || null;
  } catch {
    return null;
  }
}

export const updateCommand = new Command('update')
  .description('Update think to the latest version')
  .action(() => {
    console.log(chalk.cyan('Checking for updates...'));

    const before = getInstalledVersion();
    const latest = getLatestPublishedVersion();

    if (before && latest && before === latest) {
      console.log(chalk.dim(`Already up to date (open-think@${before}).`));
      return;
    }

    // `--prefer-online` forces npm to check the registry for fresh tag metadata
    // instead of trusting a potentially stale local cache. Without it, npm can
    // silently no-op on `@latest` when its cached latest tag is behind.
    try {
      execFileSync('npm', ['install', '-g', '--prefer-online', 'open-think@latest'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red('Update failed. Try manually: npm install -g open-think@latest'));
      if (message.includes('EACCES')) {
        console.error(chalk.dim('  You may need to run with sudo or fix npm permissions.'));
      }
      return;
    }

    // Verify the install actually landed. npm can exit 0 while doing nothing
    // if its cache thinks the current install satisfies `@latest`.
    const after = getInstalledVersion();
    if (after && latest && after === latest) {
      console.log(chalk.green('✓') + ` Updated to open-think@${after}`);
    } else if (after && before && after !== before) {
      console.log(chalk.green('✓') + ` Updated to open-think@${after}${latest ? chalk.dim(` (registry says latest is ${latest})`) : ''}`);
    } else if (after && latest && after !== latest) {
      console.error(chalk.yellow('⚠') + ` npm reported success but installed version is ${after}, expected ${latest}.`);
      console.error(chalk.dim('  Try: npm cache clean --force && npm install -g open-think@latest'));
    } else if (after) {
      console.log(chalk.dim(`Installed version: open-think@${after} (could not verify against registry).`));
    } else {
      console.error(chalk.yellow('⚠') + ' Could not locate the installed package to verify the update.');
    }
  });
