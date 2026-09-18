import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import chalk from 'chalk';
import { recordHealAction } from '../lib/heal-summary.js';
import { parseVersion, comparePrecedence, prereleaseTag } from '../lib/semver-compare.js';

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
  .description('Update think to the latest version (restarts the daemon if needed)')
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
    // Same hazard applies to refreshing managed blocks (AGT-1306): this
    // process's copy of the refresh logic embeds whatever template was
    // loaded before the install, so it must never run in-process here.
    // `refreshBlocksViaBin` shells out to the freshly installed entry point
    // instead, exactly like `restartDaemonViaBin` above.
    const { refreshBlocksViaBin } = await import('../lib/block-refresh.js');
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

    // Refresh every registered managed block (AGT-1305 registry) from
    // whatever template is on disk right now. A direct `npm install -g`
    // (bypassing `think update`) can leave the package current but every
    // CLAUDE.md/AGENTS.md block stale — this heals that on the next
    // `think update` call regardless of which branch below runs (AC3).
    const refreshBlocks = (): void => {
      const pkgRoot = getGlobalPackageRoot();
      if (!pkgRoot) return;
      const result = refreshBlocksViaBin(pkgRoot);
      if (!result.ok) {
        console.error(chalk.yellow('⚠') + ` Could not refresh managed blocks: ${result.error}`);
        return;
      }
      if (result.refreshed.length > 0) {
        const n = result.refreshed.length;
        console.log(chalk.green('✓') + ` Refreshed ${n} managed block${n === 1 ? '' : 's'}.`);
        recordHealAction('refreshedBlocks', n); // AGT-1307
      }
      for (const failure of result.failures) {
        console.error(chalk.yellow('⚠') + ` Could not refresh the managed block in ${failure.path}: ${failure.reason}`);
      }
    };

    if (before && latest && before === latest) {
      console.log(chalk.dim(`Already up to date (@openthink/think@${before}).`));
      // A previous update (or a direct `npm install -g`) may have left the
      // daemon behind even though the package itself is current — heal that
      // drift here so re-running `think update` is always sufficient.
      syncDaemon(before);
      refreshBlocks();
      return;
    }

    // `latest` above is the `latest` DIST-TAG, not the highest published
    // version: publish.yml routes a prerelease to its own tag (`rc` for
    // `3.0.0-rc.1`), so on a canary machine the installed version is ahead
    // of `latest` and installing `@latest` would be a downgrade. hivedb's
    // managed block runs `think update` once per agent session, so that
    // downgrade would undo the canary within minutes (AGT-1324).
    const beforeParsed = parseVersion(before);
    const latestParsed = parseVersion(latest);

    // Unparsable registry answer: `npm view` succeeded but returned
    // something that is not a version, so there is no version to compare
    // against and no target worth installing. Say so and heal what we can,
    // rather than installing a tag we cannot reason about. (A registry
    // lookup that *failed* leaves `latest` null and falls through to the
    // install below — that is the offline/unknown case, unchanged.) Echoed
    // through JSON.stringify: this is the one version string that reached
    // us without passing the parser, so quote-and-escape it rather than let
    // registry bytes emit raw control/ANSI sequences into the warning.
    if (latest !== null && latestParsed === null) {
      console.error(
        chalk.yellow('⚠') +
          ` The registry reported an unrecognizable latest version (${JSON.stringify(latest)}) — not installing anything.`,
      );
      syncDaemon(before);
      refreshBlocks();
      return;
    }

    // Shared tail of the two "install nothing, keep what is here" branches
    // below: point at the dist-tag the install appears to track (`rc` for
    // `3.0.0-rc.1`, derived the way publish.yml derives it) so a deliberate
    // refresh is one copy-paste away, then run the same heal wiring as the
    // already-up-to-date path — nothing was installed, but the daemon or a
    // managed block can still be stale.
    const keepInstalled = (): void => {
      const tag = beforeParsed ? prereleaseTag(beforeParsed) : null;
      console.log(chalk.dim(`  Reinstall with \`npm install -g @openthink/think@${tag ?? before}\` to refresh.`));
      syncDaemon(before);
      refreshBlocks();
    };

    // Installed version is genuinely newer than `latest` (a prerelease
    // canary, or a local build) — keep it. An unparsable INSTALLED version
    // deliberately does not land here: an unknown install is the one case
    // where `@latest` is the best answer available, which is also today's
    // behaviour.
    if (beforeParsed && latestParsed && comparePrecedence(beforeParsed, latestParsed) > 0) {
      console.log(chalk.dim(`Installed @openthink/think@${before} is ahead of latest (${latest}) — keeping it.`));
      keepInstalled();
      return;
    }

    // Registry lookup failed outright (offline, or npm erroring) *and* the
    // install is a prerelease. `npm install -g @openthink/think@latest`
    // would then resolve `latest` from npm's local cache, which on a canary
    // machine is exactly the downgrade this command must never perform — and
    // unlike the branches above there is no version to compare against, so
    // the only safe answer is to leave the prerelease alone. A release
    // install with an unknown `latest` still falls through to the install
    // below: that is the unchanged offline behaviour.
    if (latest === null && beforeParsed && beforeParsed.prerelease.length > 0) {
      console.error(
        chalk.yellow('⚠') +
          ` Could not check the registry, so keeping the prerelease install @openthink/think@${before} rather than risk a downgrade.`,
      );
      keepInstalled();
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

    // Something is installed on disk at this point in every branch above
    // except the last (no package could be located at all, in which case
    // refreshBlocks() itself no-ops since getGlobalPackageRoot() also fails).
    if (after) refreshBlocks();

    if (legacyOpenThinkInstalled()) {
      console.error(
        chalk.yellow('⚠') +
          ' Detected legacy `open-think` global install alongside `@openthink/think`.',
      );
      console.error(chalk.dim('  Run `npm uninstall -g open-think` to avoid two `think` binaries on PATH.'));
    }
  });
