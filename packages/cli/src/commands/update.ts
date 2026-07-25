import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import chalk from 'chalk';

/** Directory of the globally installed `@openthink/think` package, or null. */
function getGlobalPackageRoot(): string | null {
  try {
    const npmRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf-8' }).trim();
    const root = path.join(npmRoot, '@openthink/think');
    return fs.existsSync(path.join(root, 'package.json')) ? root : null;
  } catch {
    return null;
  }
}

function getInstalledVersion(): string | null {
  try {
    const root = getGlobalPackageRoot();
    if (!root) return null;
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

function legacyOpenThinkInstalled(): boolean {
  try {
    const npmRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf-8' }).trim();
    return fs.existsSync(path.join(npmRoot, 'open-think', 'package.json'));
  } catch {
    return false;
  }
}

function getLatestPublishedVersion(): string | null {
  try {
    const v = execFileSync('npm', ['view', '@openthink/think', 'version'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return v || null;
  } catch {
    return null;
  }
}

export const updateCommand = new Command('update')
  .description('Update think to the latest version (restarts the resident daemon if it is serving older code)')
  .action(async () => {
    console.log(chalk.cyan('Checking for updates...'));

    const before = getInstalledVersion();
    const latest = getLatestPublishedVersion();

    // Inspect the daemon BEFORE any install touches disk (#91). This loads
    // the daemon-client modules into memory now; after `npm install -g`
    // replaces dist/, in-process imports from this (old) CLI are unsafe —
    // the bundle's chunk names are content-hashed, so a post-install import
    // can fail or mix old and new code. Anything daemon-related that runs
    // after the install goes through `restartDaemonViaBin`, which shells out
    // to the freshly installed entry point instead.
    const { inspectDaemon, needsDaemonRestart, restartDaemonViaBin } =
      await import('../lib/daemon-drift.js');
    const daemon = await inspectDaemon();

    // Bring the resident daemon onto `target` (the version now on disk) if it
    // is serving anything else. The daemon keeps old code in memory across
    // package upgrades, and recall/sync run daemon-side — without a restart
    // the user updates but does not get the update (#91).
    const syncDaemon = (target: string | null): void => {
      if (!needsDaemonRestart(daemon, target)) return;
      const pkgRoot = getGlobalPackageRoot();
      if (!pkgRoot || !target) return;
      const runningLabel = daemon.version ?? 'an older version';
      const result = restartDaemonViaBin(pkgRoot);
      if (result.ok) {
        console.log(chalk.green('✓') + ` Daemon restarted (was serving ${runningLabel}, now ${target}).`);
      } else {
        console.error(chalk.yellow('⚠') + ` Daemon is still running ${runningLabel} — restart it to pick up ${target}:`);
        console.error(chalk.dim('    think daemon stop && think daemon start'));
      }
    };

    if (before && latest && before === latest) {
      console.log(chalk.dim(`Already up to date (@openthink/think@${before}).`));
      // A previous update (or a direct `npm install -g`) may have left the
      // daemon behind even though the package itself is current — heal that
      // drift here so re-running `think update` is always sufficient.
      syncDaemon(before);
      return;
    }

    // `--prefer-online` forces npm to check the registry for fresh tag metadata
    // instead of trusting a potentially stale local cache. Without it, npm can
    // silently no-op on `@latest` when its cached latest tag is behind.
    try {
      execFileSync('npm', ['install', '-g', '--prefer-online', '@openthink/think@latest'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red('Update failed. Try manually: npm install -g @openthink/think@latest'));
      if (message.includes('EACCES')) {
        console.error(chalk.dim('  You may need to run with sudo or fix npm permissions.'));
      }
      return;
    }

    // Verify the install actually landed. npm can exit 0 while doing nothing
    // if its cache thinks the current install satisfies `@latest`.
    const after = getInstalledVersion();
    if (after && latest && after === latest) {
      console.log(chalk.green('✓') + ` Updated to @openthink/think@${after}`);
      syncDaemon(after);
    } else if (after && before && after !== before) {
      console.log(chalk.green('✓') + ` Updated to @openthink/think@${after}${latest ? chalk.dim(` (registry says latest is ${latest})`) : ''}`);
      syncDaemon(after);
    } else if (after && latest && after !== latest) {
      console.error(chalk.yellow('⚠') + ` npm reported success but installed version is ${after}, expected ${latest}.`);
      console.error(chalk.dim('  Try: npm cache clean --force && npm install -g @openthink/think@latest'));
    } else if (after) {
      console.log(chalk.dim(`Installed version: @openthink/think@${after} (could not verify against registry).`));
    } else {
      console.error(chalk.yellow('⚠') + ' Could not locate the installed package to verify the update.');
    }

    if (legacyOpenThinkInstalled()) {
      console.error(
        chalk.yellow('⚠') +
          ' Detected legacy `open-think` global install alongside `@openthink/think`.',
      );
      console.error(chalk.dim('  Run `npm uninstall -g open-think` to avoid two `think` binaries on PATH.'));
    }
  });
