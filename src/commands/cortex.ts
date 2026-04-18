import fs from 'node:fs';
import { Command } from 'commander';
import chalk from 'chalk';
import readline from 'node:readline';
import { getConfig, saveConfig } from '../lib/config.js';
import { getCortexDb, closeCortexDb } from '../db/engrams.js';
import { getMemoryCount, getSyncCursor } from '../db/memory-queries.js';
import { getEngramsDir } from '../lib/paths.js';
import { getSyncAdapter } from '../sync/registry.js';
import { installAgent, uninstallAgent, getAgentStatus } from '../lib/auto-curate.js';

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

// think cortex setup
cortexCommand.addCommand(new Command('setup')
  .description('Configure a sync backend for cortex storage')
  .argument('[repo]', 'Git remote URL (e.g., git@github.com:org/hivedb.git)')
  .action(async (repo?: string) => {
    const config = getConfig();

    if (!repo) {
      repo = await prompt('Git repo URL for cortex storage (leave empty for offline-only): ');
    }

    const author = await prompt(`Your name (for memory attribution): `, config.cortex?.author);
    if (!author) {
      console.error(chalk.red('Author name is required.'));
      process.exit(1);
    }

    config.cortex = {
      ...config.cortex,
      author,
      active: config.cortex?.active,
    };

    if (repo) {
      config.cortex.repo = repo;
    }

    saveConfig(config);

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
    if (adapter?.isAvailable()) {
      try {
        await adapter.createCortex(name);
        console.log(chalk.green('✓') + ` Created cortex: ${name} (local + remote)`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(chalk.green('✓') + ` Created cortex: ${name} (local only)`);
        console.log(chalk.yellow(`  ⚠ Remote creation failed: ${message}`));
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
          console.log(chalk.dim('Remote only (run think cortex pull to sync):'));
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

    // Check if local DB exists
    const engramsDir = getEngramsDir();
    const dbPath = `${engramsDir}/${name}.db`;
    if (!fs.existsSync(dbPath)) {
      // Check if it exists remotely
      const adapter = getSyncAdapter();
      if (adapter?.isAvailable()) {
        try {
          const remoteCortexes = await adapter.listRemoteCortexes();
          if (remoteCortexes.includes(name)) {
            console.log(chalk.yellow(`Cortex '${name}' exists remotely but not locally.`));
            console.log(chalk.dim('Run: think cortex pull  (to sync from remote)'));
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

    console.log(chalk.cyan(`Syncing ${cortex}...`));
    const result = await adapter.sync(cortex);

    if (result.errors.length > 0) {
      for (const err of result.errors) {
        console.error(chalk.red(`  Error: ${err}`));
      }
    }

    console.log(chalk.green('✓') + ` Pulled ${result.pulled}, pushed ${result.pushed}`);
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

    if (adapter?.isAvailable()) {
      const pushCursor = getSyncCursor(cortex, adapter.name, 'push');
      console.log(`Last push cursor: ${pushCursor ?? chalk.dim('(never synced)')}`);
    }

    closeCortexDb(cortex);
  }));

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
