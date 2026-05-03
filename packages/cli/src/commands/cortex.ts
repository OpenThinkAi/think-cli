import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command, Option } from 'commander';
import chalk from 'chalk';
import readline from 'node:readline';
import { getConfig, saveConfig, getPeerId } from '../lib/config.js';
import { getCortexDb, closeCortexDb } from '../db/engrams.js';
import { getMemoryCount, getSyncCursor } from '../db/memory-queries.js';
import { getEngramDbPath, getEngramsDir } from '../lib/paths.js';
import { getSyncAdapter } from '../sync/registry.js';
import { LocalFsSyncAdapter } from '../sync/local-fs-adapter.js';
import { installAgent, uninstallAgent, getAgentStatus } from '../lib/auto-curate.js';
import {
  installAgent as installSyncAgent,
  uninstallAgent as uninstallSyncAgent,
  getAgentStatus as getSyncAgentStatus,
  getLogPath as getSyncLogPath,
} from '../lib/auto-sync.js';
import { validateRepoUrl } from '../lib/repo-url.js';

function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

export const cortexCommand = new Command('cortex')
  .description('Manage cortexes (team memory workspaces)');

// Resolve `--fs <path>` to an absolute path, expanding a leading `~` to
// $HOME. Returns null for empty input. Storing absolute paths matters
// because `cwd` shifts under cron / LaunchAgent / nested shells, and a
// relative path baked into config would break in those contexts.
function resolveFsPath(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  let expanded = trimmed;
  if (expanded === '~' || expanded.startsWith('~/')) {
    expanded = path.join(os.homedir(), expanded.slice(1));
  }
  return path.resolve(expanded);
}

// think cortex setup
cortexCommand.addCommand(new Command('setup')
  .description('Configure a sync backend for cortex storage (git or local-fs)')
  .argument('[repo]', 'Git remote URL (e.g., git@github.com:org/hivedb.git). Mutually exclusive with --fs.')
  .option('--fs <path>', 'Use a local folder (cloud-synced or otherwise) as the cortex backend. Mutually exclusive with [repo].')
  // --server / --token are kept registered as hidden options so the v2
  // deprecation message points at --fs cleanly, instead of commander's
  // generic "unknown option" rejection. The action handler exits before
  // touching any state when either is set.
  .addOption(new Option('--server <url>', 'deprecated — retired in v2').hideHelp())
  .addOption(new Option('--token <token>', 'deprecated — retired in v2').hideHelp())
  .action(async (repo: string | undefined, opts: { server?: string; token?: string; fs?: string }) => {
    if (opts.server !== undefined || opts.token !== undefined) {
      console.error(chalk.red(
        '--server and --token were retired in think-cli v2 (the http backend is gone).\n' +
        'Use `think cortex setup --fs <path>` instead.',
      ));
      console.error(chalk.dim(
        'If you have data on the v1 http server, migrate it on think-cli v1 first\n' +
        '(`think cortex migrate --to fs --path <path>`), then upgrade — v2 cannot\n' +
        'read remote http stores.',
      ));
      process.exit(1);
    }

    const config = getConfig();

    if (repo && opts.fs) {
      console.error(chalk.red('Pass either `[repo]` or `--fs <path>`, not both.'));
      process.exit(1);
    }

    // Local-fs backend
    if (opts.fs !== undefined) {
      const resolved = resolveFsPath(opts.fs);
      if (!resolved) {
        console.error(chalk.red('--fs requires a non-empty path.'));
        process.exit(1);
      }
      try {
        fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
      } catch (err) {
        console.error(chalk.red(`Could not create or access ${resolved}: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }

      const author = await prompt(`Your name (for memory attribution): `, config.cortex?.author);
      if (!author) {
        console.error(chalk.red('Author name is required.'));
        process.exit(1);
      }

      const hadRepo = !!config.cortex?.repo;
      config.cortex = {
        ...config.cortex,
        author,
        fs: { path: resolved },
      };
      // Symmetric clear: switching to fs drops repo so the registry's
      // priority rule doesn't keep handing back a stale adapter.
      delete config.cortex.repo;

      saveConfig(config);

      console.log(chalk.green('✓') + ` Cortex folder: ${resolved}`);
      console.log(chalk.green('✓') + ` Author: ${author}`);
      if (hadRepo) console.log(chalk.dim('  (cleared previous git repo backend)'));
      return;
    }

    // Git backend (existing path)
    if (!repo) {
      repo = await prompt('Git repo URL for cortex storage (leave empty for offline-only): ');
    }

    try {
      validateRepoUrl(repo);
    } catch (err) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }

    const author = await prompt(`Your name (for memory attribution): `, config.cortex?.author);
    if (!author) {
      console.error(chalk.red('Author name is required.'));
      process.exit(1);
    }

    const hadFs = !!config.cortex?.fs;
    config.cortex = {
      ...config.cortex,
      author,
    };

    if (repo) {
      config.cortex.repo = repo;
    }
    // Symmetric to the --fs branch: switching to git drops any prior fs
    // config so the registry's priority rule doesn't silently keep
    // routing pushes/pulls to the wrong backend.
    delete config.cortex.fs;

    saveConfig(config);

    if (hadFs) {
      console.log(chalk.dim('  (cleared previous local-fs backend)'));
    }

    if (repo) {
      console.log(chalk.green('✓') + ` Cortex repo: ${repo}`);
    } else {
      console.log(chalk.green('✓') + ' Offline-only mode (no sync backend)');
    }
    console.log(chalk.green('✓') + ` Author: ${author}`);

    // Clone the repo if configured
    if (repo) {
      const adapter = getSyncAdapter();
      if (adapter) {
        try {
          // Trigger repo clone by checking availability
          const { ensureRepoCloned } = await import('../lib/git.js');
          ensureRepoCloned();
          console.log(chalk.green('✓') + ' Repo cloned');
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.log(chalk.yellow(`  ⚠ Could not clone repo: ${message}`));
        }
      }
    }
  }));

// think cortex create <name>
cortexCommand.addCommand(new Command('create')
  .argument('<name>', 'Cortex name (e.g., engineering, product)')
  .description('Create a new cortex')
  .action(async (name: string) => {
    const config = getConfig();
    if (!config.cortex?.author) {
      console.error(chalk.red('No cortex author configured. Run: think cortex setup'));
      process.exit(1);
    }

    // Initialize the local engram DB for this cortex (also creates memories table via migrations)
    getCortexDb(name);
    closeCortexDb(name);

    // Create on remote if sync adapter is available
    const adapter = getSyncAdapter();
    // v2: when fs is the configured backend, the second tier is "the folder"
    // — the README and openthink.dev surface that framing too. Keep "remote"
    // for the legacy git backend so its wording stays accurate.
    const secondTierLabel = config.cortex?.fs?.path ? 'folder' : 'remote';
    if (adapter?.isAvailable()) {
      try {
        await adapter.createCortex(name);
        console.log(chalk.green('✓') + ` Created cortex: ${name} (local + ${secondTierLabel})`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(chalk.green('✓') + ` Created cortex: ${name} (local only)`);
        console.log(chalk.yellow(`  ⚠ ${secondTierLabel === 'folder' ? 'Folder' : 'Remote'} creation failed: ${message}`));
      }
    } else {
      console.log(chalk.green('✓') + ` Created cortex: ${name} (local only)`);
    }

    // Set as active if no active cortex
    if (!config.cortex.active) {
      config.cortex.active = name;
      saveConfig(config);
      console.log(chalk.dim('  Set as active cortex'));
    }
  }));

// think cortex list
cortexCommand.addCommand(new Command('list')
  .description('Show all cortexes')
  .action(async () => {
    const config = getConfig();
    const engramsDir = getEngramsDir();

    // List local cortex databases
    const localCortexes: string[] = [];
    if (fs.existsSync(engramsDir)) {
      for (const file of fs.readdirSync(engramsDir)) {
        if (file.endsWith('.db') && !file.endsWith('-shm') && !file.endsWith('-wal')) {
          localCortexes.push(file.replace('.db', ''));
        }
      }
    }

    if (localCortexes.length === 0) {
      console.log(chalk.dim('No cortexes found. Run: think cortex create <name>'));
      return;
    }

    for (const name of localCortexes.sort()) {
      const marker = name === config.cortex?.active ? chalk.green('* ') : '  ';
      const count = getMemoryCount(name);
      const countLabel = count > 0 ? chalk.dim(` (${count} memories)`) : '';
      console.log(`${marker}${name}${countLabel}`);
      closeCortexDb(name);
    }

    // Show remote cortexes if adapter is available
    const adapter = getSyncAdapter();
    if (adapter?.isAvailable()) {
      try {
        const remoteCortexes = await adapter.listRemoteCortexes();
        const remoteOnly = remoteCortexes.filter(r => !localCortexes.includes(r));
        if (remoteOnly.length > 0) {
          console.log();
          // v2 fs backend: the "remote" is just a folder on disk, so name it.
          // Including the path makes the next step (`think cortex pull`)
          // self-explanatory — the user can see exactly which folder feeds it.
          const fsPath = config.cortex?.fs?.path;
          const header = fsPath
            ? `Folder only (in ${fsPath}, run think cortex pull to sync):`
            : 'Remote only (run think cortex pull to sync):';
          console.log(chalk.dim(header));
          for (const name of remoteOnly) {
            console.log(`  ${chalk.dim(name)}`);
          }
        }
      } catch {
        // Silently skip if remote is unreachable
      }
    }
  }));

// think cortex switch <name>
cortexCommand.addCommand(new Command('switch')
  .argument('<name>', 'Cortex name')
  .description('Set the active cortex')
  .action(async (name: string) => {
    const config = getConfig();
    if (!config.cortex) {
      console.error(chalk.red('No cortex configured. Run: think cortex setup'));
      process.exit(1);
    }

    // Check if local DB exists. Route path construction through
    // getEngramDbPath so `name` flows through sanitizeName (rejects '..',
    // path separators, and non-alphanumeric characters). Matches how every
    // other engram-path site resolves.
    const dbPath = getEngramDbPath(name);
    if (!fs.existsSync(dbPath)) {
      // Check if it exists remotely
      const adapter = getSyncAdapter();
      if (adapter?.isAvailable()) {
        try {
          const remoteCortexes = await adapter.listRemoteCortexes();
          if (remoteCortexes.includes(name)) {
            // Mirror `cortex list`'s "Folder only (in <path>, …)" framing —
            // surfacing the path here gives the user the same "what + where"
            // affordance instead of a bare "in folder" that reads as broken
            // English. `getSyncAdapter()` prefers fs over repo, so probing
            // `fs.path` here matches the adapter that actually ran above.
            const fsPath = config.cortex?.fs?.path;
            if (fsPath) {
              console.log(chalk.yellow(`Cortex '${name}' exists in ${fsPath} but not locally.`));
              console.log(chalk.dim('Run: think cortex pull  (to sync from the folder)'));
            } else {
              console.log(chalk.yellow(`Cortex '${name}' exists remotely but not locally.`));
              console.log(chalk.dim('Run: think cortex pull  (to sync from remote)'));
            }
            return;
          }
        } catch {
          // Fall through to local-only check
        }
      }
      console.error(chalk.red(`Cortex '${name}' does not exist. Run: think cortex create ${name}`));
      process.exit(1);
    }

    config.cortex.active = name;
    saveConfig(config);
    console.log(chalk.green('✓') + ` Active cortex: ${name}`);
  }));

// think cortex current
cortexCommand.addCommand(new Command('current')
  .description('Show the active cortex')
  .action(() => {
    const config = getConfig();
    const active = config.cortex?.active;
    if (active) {
      console.log(active);
    } else {
      console.log(chalk.dim('(no active cortex)'));
    }
  }));

// think cortex push
cortexCommand.addCommand(new Command('push')
  .description('Push local memories to remote')
  .action(async () => {
    const config = getConfig();
    const cortex = config.cortex?.active;

    if (!cortex) {
      console.error(chalk.red('No active cortex. Run: think cortex switch <name>'));
      process.exit(1);
    }

    const adapter = getSyncAdapter();
    if (!adapter?.isAvailable()) {
      console.error(chalk.red('No sync backend configured. Run: think cortex setup'));
      process.exit(1);
    }

    console.log(chalk.cyan(`Pushing ${cortex} memories...`));
    const result = await adapter.push(cortex);

    if (result.errors.length > 0) {
      for (const err of result.errors) {
        console.error(chalk.red(`  Error: ${err}`));
      }
    }

    console.log(chalk.green('✓') + ` Pushed ${result.pushed} memories`);
    closeCortexDb(cortex);
  }));

// think cortex pull
cortexCommand.addCommand(new Command('pull')
  .description('Pull remote memories to local')
  .action(async () => {
    const config = getConfig();
    const cortex = config.cortex?.active;

    if (!cortex) {
      console.error(chalk.red('No active cortex. Run: think cortex switch <name>'));
      process.exit(1);
    }

    const adapter = getSyncAdapter();
    if (!adapter?.isAvailable()) {
      console.error(chalk.red('No sync backend configured. Run: think cortex setup'));
      process.exit(1);
    }

    console.log(chalk.cyan(`Pulling ${cortex} memories...`));
    const result = await adapter.pull(cortex);

    if (result.errors.length > 0) {
      for (const err of result.errors) {
        console.error(chalk.red(`  Error: ${err}`));
      }
    }

    console.log(chalk.green('✓') + ` Pulled ${result.pulled} new memories`);
    closeCortexDb(cortex);
  }));

// think cortex sync
cortexCommand.addCommand(new Command('sync')
  .description('Sync memories with remote (pull + push)')
  .option('--if-online', 'Skip silently if remote is unreachable (used by the auto-sync LaunchAgent).')
  .action(async (opts: { ifOnline?: boolean }) => {
    const config = getConfig();
    const cortex = config.cortex?.active;

    if (!cortex) {
      // --if-online runs from launchd with no terminal — bail quietly so the
      // log doesn't fill with "no active cortex" once a minute on a fresh
      // machine that hasn't finished setup.
      if (opts.ifOnline) return;
      console.error(chalk.red('No active cortex. Run: think cortex switch <name>'));
      process.exit(1);
    }

    const adapter = getSyncAdapter();
    if (!adapter?.isAvailable()) {
      if (opts.ifOnline) return;
      console.error(chalk.red('No sync backend configured. Run: think cortex setup'));
      process.exit(1);
    }

    if (opts.ifOnline) {
      const reachable = await adapter.isReachable();
      if (!reachable) {
        // Single dim line so the log shows liveness but doesn't grow on every
        // tick when offline. Mirrors `curate --if-idle`'s skip posture.
        console.log(chalk.dim('[auto-sync] skipped: remote unreachable'));
        closeCortexDb(cortex);
        return;
      }
    }

    if (!opts.ifOnline) {
      console.log(chalk.cyan(`Syncing ${cortex}...`));
    }
    const result = await adapter.sync(cortex);

    if (result.errors.length > 0) {
      for (const err of result.errors) {
        console.error(chalk.red(`  Error: ${err}`));
      }
    }

    // In --if-online mode, swallow the success line entirely on no-op runs so
    // a 60s LaunchAgent doesn't grow `auto-sync.log` to MB-scale. Only print
    // when there's something to report.
    if (opts.ifOnline) {
      if (result.pulled > 0 || result.pushed > 0) {
        console.log(chalk.green('✓') + ` [auto-sync] Pulled ${result.pulled}, pushed ${result.pushed}`);
      }
    } else {
      console.log(chalk.green('✓') + ` Pulled ${result.pulled}, pushed ${result.pushed}`);
    }
    closeCortexDb(cortex);
  }));

// think cortex status
cortexCommand.addCommand(new Command('status')
  .description('Show sync status for the active cortex')
  .action(async () => {
    const config = getConfig();
    const cortex = config.cortex?.active;

    if (!cortex) {
      console.error(chalk.red('No active cortex. Run: think cortex switch <name>'));
      process.exit(1);
    }

    const memoryCount = getMemoryCount(cortex);
    const adapter = getSyncAdapter();
    const backendName = adapter?.isAvailable() ? adapter.name : 'none';

    console.log(`Cortex: ${chalk.cyan(cortex)}`);
    console.log(`Memories: ${memoryCount}`);
    console.log(`Backend: ${backendName}`);

    if (config.cortex?.fs?.path) {
      console.log(`Folder: ${config.cortex.fs.path}`);
    } else if (config.cortex?.repo) {
      console.log(`Repo: ${config.cortex.repo}`);
    }

    if (adapter?.isAvailable()) {
      const pushCursor = getSyncCursor(cortex, adapter.name, 'push');
      console.log(`Last push cursor: ${pushCursor ?? chalk.dim('(never synced)')}`);
    }

    closeCortexDb(cortex);
  }));

// think cortex migrate
cortexCommand.addCommand(new Command('migrate')
  .description('Migrate cortex storage from git to a local folder')
  .requiredOption('--to <backend>', 'Target backend (currently only `fs` is supported)')
  .option('--path <path>', 'Target folder for the local-fs backend (required when --to fs)')
  .option('--allow-stale-source', 'Proceed with the migration even if pulling the latest from the source backend fails. By default migrate aborts on pull failure so users do not end up with a permanently-stale fs backend they cannot retry from.')
  .action(async (opts: { to: string; path?: string; allowStaleSource?: boolean }) => {
    if (opts.to !== 'fs') {
      console.error(chalk.red(`Unsupported migration target: --to ${opts.to}. Only --to fs is supported.`));
      process.exit(1);
    }
    if (!opts.path) {
      console.error(chalk.red('--to fs requires --path <folder>.'));
      process.exit(1);
    }

    const config = getConfig();
    if (!config.cortex?.repo) {
      console.error(chalk.red('No git backend configured. Nothing to migrate from.'));
      console.error(chalk.dim('Run `think cortex setup --fs <path>` to set up a fresh local-fs backend instead.'));
      console.error(chalk.dim('Coming from the v1 http backend? It was retired in v2 — downgrade to think-cli v1, run `think cortex migrate --to fs --path <path>` there, then upgrade.'));
      process.exit(1);
    }

    const resolved = resolveFsPath(opts.path);
    if (!resolved) {
      console.error(chalk.red('--path must be a non-empty folder.'));
      process.exit(1);
    }

    // Block accidentally targeting an already-populated fs cortex root —
    // a stray cortex folder there could collide with a fresh export and
    // produce confusing duplicates. An empty or non-existent folder is fine.
    if (fs.existsSync(resolved)) {
      const entries = fs.readdirSync(resolved);
      const hasSubdirs = entries.some(name => {
        const full = path.join(resolved, name);
        try { return fs.statSync(full).isDirectory(); } catch { return false; }
      });
      if (hasSubdirs) {
        console.error(chalk.red(
          `Refusing to migrate into a folder that already contains directories: ${resolved}.\n` +
          `Pick an empty folder or remove the existing entries first.`,
        ));
        process.exit(1);
      }
    }

    // Step 1: ensure local SQLite has everything from the source remote.
    // Pull-only (not full sync) — push-side effects on the legacy backend
    // would be wasted writes since we're abandoning it.
    const sourceAdapter = getSyncAdapter();
    if (!sourceAdapter?.isAvailable()) {
      console.error(chalk.red('Source adapter not available. Aborting.'));
      process.exit(1);
    }

    const localCortexes = listLocalCortexes();
    if (localCortexes.length === 0) {
      console.error(chalk.red('No local cortexes to migrate.'));
      console.error(chalk.dim('  Run `think cortex setup --fs <path>` to set up a fresh local-fs backend.'));
      process.exit(1);
    }

    console.log(chalk.cyan(`Pulling latest from ${sourceAdapter.name} into local SQLite...`));
    const pullFailures: string[] = [];
    for (const cortex of localCortexes) {
      try {
        const pullResult = await sourceAdapter.pull(cortex);
        if (pullResult.errors.length > 0) {
          pullFailures.push(`${cortex}: ${pullResult.errors.join('; ')}`);
        }
      } catch (err) {
        pullFailures.push(`${cortex}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (pullFailures.length > 0 && !opts.allowStaleSource) {
      console.error(chalk.red('Source pull failed; aborting before rewriting config:'));
      for (const f of pullFailures) {
        console.error(chalk.red(`  - ${f}`));
      }
      console.error(chalk.dim(
        '  Re-run when the source is reachable, or pass --allow-stale-source\n' +
        '  to migrate with whatever SQLite already has (you will not be able\n' +
        '  to retry the pull once the config has been rewritten to fs).',
      ));
      process.exit(1);
    }
    if (pullFailures.length > 0 && opts.allowStaleSource) {
      console.log(chalk.yellow('  ⚠ Continuing with --allow-stale-source despite pull failures:'));
      for (const f of pullFailures) {
        console.log(chalk.yellow(`    - ${f}`));
      }
    }

    // Step 2: scaffold target folder.
    try {
      fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
    } catch (err) {
      console.error(chalk.red(`Could not create ${resolved}: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }

    // Step 3: switch config — registry will now hand back the fs adapter.
    const hadRepo = !!config.cortex.repo;
    config.cortex = {
      ...config.cortex,
      fs: { path: resolved },
    };
    delete config.cortex.repo;
    saveConfig(config);

    // Step 4: export every local cortex's memories + long-term events to
    // the new folder. The fs adapter's push cursor for a fresh backend
    // starts empty, so a no-op default is to push everything from
    // sync_version=0 — no explicit cursor reset needed.
    const fsAdapter = new LocalFsSyncAdapter();
    let totalPushed = 0;
    for (const cortex of localCortexes) {
      // No explicit createCortex — fsAdapter.push mkdirs the cortex dir
      // itself when there's something to write.
      try {
        const result = await fsAdapter.push(cortex);
        if (result.errors.length > 0) {
          for (const err of result.errors) {
            console.error(chalk.red(`  Error (${cortex}): ${err}`));
          }
        }
        totalPushed += result.pushed;
        console.log(chalk.green('✓') + ` ${cortex}: exported ${result.pushed} entries`);
      } catch (err) {
        console.error(chalk.red(`  Error (${cortex}): ${err instanceof Error ? err.message : String(err)}`));
      } finally {
        closeCortexDb(cortex);
      }
    }

    console.log();
    console.log(chalk.green('✓') + ` Migrated ${localCortexes.length} cortex(es), ${totalPushed} entries → ${resolved}`);
    if (hadRepo) console.log(chalk.dim('  (cleared previous git repo backend)'));
    console.log(chalk.dim(`  Peer id: ${getPeerId()}`));
    console.log();
    console.log(chalk.cyan('Next:'));
    console.log(`  ${chalk.dim('•')} ${chalk.bold('think cortex status')}  — confirm the new backend is in place`);
    console.log(`  ${chalk.dim('•')} ${chalk.bold('think sync "test"')}     — verify writes hit ${resolved}`);
  }));

function listLocalCortexes(): string[] {
  const dir = getEngramsDir();
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (file.endsWith('.db')) out.push(file.replace(/\.db$/, ''));
  }
  return out.sort();
}

// think cortex auto-curate — scheduled background curation
const autoCurateCommand = new Command('auto-curate')
  .description('Manage scheduled background curation (macOS LaunchAgent)');

autoCurateCommand.addCommand(new Command('enable')
  .description('Install a LaunchAgent that runs `think curate --if-idle` every 5 minutes')
  .option('--interval <seconds>', 'Scheduler cadence in seconds (default 300)', (v) => parseInt(v, 10))
  .action((opts: { interval?: number }) => {
    try {
      const { label, plistPath } = installAgent({ intervalSeconds: opts.interval });
      console.log(chalk.green('✓') + ` Auto-curation enabled`);
      console.log(chalk.dim(`  Label: ${label}`));
      console.log(chalk.dim(`  Plist: ${plistPath}`));
      if (process.env.THINK_HOME) {
        console.log(chalk.dim(`  THINK_HOME: ${process.env.THINK_HOME}`));
      }
    } catch (err) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  }));

autoCurateCommand.addCommand(new Command('disable')
  .description('Remove the auto-curation LaunchAgent for this workspace')
  .action(() => {
    const { removed, plistPath } = uninstallAgent();
    if (removed) {
      console.log(chalk.green('✓') + ` Auto-curation disabled (${plistPath})`);
    } else {
      console.log(chalk.dim(`No auto-curation agent installed (${plistPath})`));
    }
  }));

autoCurateCommand.addCommand(new Command('status')
  .description('Show auto-curation scheduler status')
  .action(() => {
    const s = getAgentStatus();
    console.log(`Label:     ${chalk.cyan(s.label)}`);
    console.log(`Installed: ${s.installed ? chalk.green('yes') : chalk.dim('no')}`);
    console.log(`Loaded:    ${s.loaded ? chalk.green('yes') : chalk.dim('no')}`);
    if (s.intervalSeconds) {
      console.log(`Interval:  ${s.intervalSeconds}s`);
    }
    console.log(`Plist:     ${s.plistPath}`);
    if (s.lastRunAt) {
      console.log(`Last log:  ${s.lastRunAt.toISOString()}`);
    } else {
      console.log(`Last log:  ${chalk.dim('(no log file yet)')}`);
    }
  }));

cortexCommand.addCommand(autoCurateCommand);

// think cortex auto-sync — scheduled background sync (pull + push)
const autoSyncCommand = new Command('auto-sync')
  .description('Manage scheduled background sync (macOS LaunchAgent)');

autoSyncCommand.addCommand(new Command('enable')
  .description('Install a LaunchAgent that runs `think cortex sync --if-online` on session load and every 60 seconds')
  .option('--interval <seconds>', 'Scheduler cadence in seconds (default 60)', (v) => {
    const n = parseInt(v, 10);
    // commander's parser ignores throws here in some configs and we'd write
    // <integer>NaN</integer> into the plist with stdio:'ignore' on launchctl,
    // so the user would walk away with a broken agent. Reject loudly.
    if (!Number.isInteger(n) || n <= 0 || String(n) !== v.trim()) {
      console.error(chalk.red(`--interval must be a positive integer (got: '${v}')`));
      process.exit(1);
    }
    return n;
  })
  .action((opts: { interval?: number }) => {
    try {
      const { label, plistPath } = installSyncAgent({ intervalSeconds: opts.interval });
      console.log(chalk.green('✓') + ` Auto-sync enabled`);
      console.log(chalk.dim(`  Label: ${label}`));
      console.log(chalk.dim(`  Plist: ${plistPath}`));
      if (process.env.THINK_HOME) {
        console.log(chalk.dim(`  THINK_HOME: ${process.env.THINK_HOME}`));
      }
      // RunAtLoad: true → first sync fires immediately on `launchctl load`.
      // Tell the user where to watch so "did it work?" is answerable.
      console.log(chalk.dim(`  First run fires immediately; tail the log to watch:`));
      console.log(chalk.dim(`    tail -f ${getSyncLogPath()}`));
    } catch (err) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  }));

autoSyncCommand.addCommand(new Command('disable')
  .description('Remove the auto-sync LaunchAgent for this workspace')
  .action(() => {
    const { removed, plistPath } = uninstallSyncAgent();
    if (removed) {
      console.log(chalk.green('✓') + ` Auto-sync disabled (${plistPath})`);
    } else {
      console.log(chalk.dim(`No auto-sync agent installed (${plistPath})`));
    }
  }));

autoSyncCommand.addCommand(new Command('status')
  .description('Show auto-sync scheduler status')
  .action(() => {
    const s = getSyncAgentStatus();
    console.log(`Label:     ${chalk.cyan(s.label)}`);
    console.log(`Installed: ${s.installed ? chalk.green('yes') : chalk.dim('no')}`);
    console.log(`Loaded:    ${s.loaded ? chalk.green('yes') : chalk.dim('no')}`);
    if (s.intervalSeconds) {
      console.log(`Interval:  ${s.intervalSeconds}s`);
    }
    console.log(`Plist:     ${s.plistPath}`);
    if (s.lastRunAt) {
      console.log(`Last log entry:  ${s.lastRunAt.toISOString()}`);
    } else {
      console.log(`Last log entry:  ${chalk.dim('(no log file yet)')}`);
    }
  }));

cortexCommand.addCommand(autoSyncCommand);
