import { Command } from 'commander';
import chalk from 'chalk';
import readline from 'node:readline';
import { getConfig, saveConfig } from '../lib/config.js';
import { ensureRepoCloned, branchExists, createOrphanBranch, listRemoteBranches } from '../lib/git.js';
import { getEngramsDb, closeEngramsDb } from '../db/engrams.js';

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
  .description('Configure the git repo for cortex storage')
  .argument('[repo]', 'Git remote URL (e.g., git@github.com:org/hivedb.git)')
  .action(async (repo?: string) => {
    const config = getConfig();

    if (!repo) {
      repo = await prompt('Git repo URL for cortex storage: ');
      if (!repo) {
        console.error(chalk.red('Repo URL is required.'));
        process.exit(1);
      }
    }

    const author = await prompt(`Your name (for memory attribution): `, config.cortex?.author);
    if (!author) {
      console.error(chalk.red('Author name is required.'));
      process.exit(1);
    }

    config.cortex = {
      repo,
      author,
      active: config.cortex?.active,
    };
    saveConfig(config);

    console.log(chalk.green('✓') + ` Cortex repo: ${repo}`);
    console.log(chalk.green('✓') + ` Author: ${author}`);

    // Clone the repo
    ensureRepoCloned();
    console.log(chalk.green('✓') + ' Repo cloned');
  }));

// think cortex create <name>
cortexCommand.addCommand(new Command('create')
  .argument('<name>', 'Cortex name (e.g., engineering, product)')
  .description('Create a new cortex branch')
  .action(async (name: string) => {
    const config = getConfig();
    if (!config.cortex?.repo) {
      console.error(chalk.red('No cortex repo configured. Run: think cortex setup'));
      process.exit(1);
    }

    ensureRepoCloned();

    if (branchExists(name)) {
      console.log(chalk.yellow(`Branch '${name}' already exists. Use: think cortex switch ${name}`));
      return;
    }

    createOrphanBranch(name);

    // Initialize the engram DB for this cortex
    getEngramsDb(name);
    closeEngramsDb(name);

    // Set as active if no active cortex
    if (!config.cortex.active) {
      config.cortex.active = name;
      saveConfig(config);
    }

    console.log(chalk.green('✓') + ` Created cortex: ${name}`);
    if (config.cortex.active === name) {
      console.log(chalk.dim('  Set as active cortex'));
    }
  }));

// think cortex list
cortexCommand.addCommand(new Command('list')
  .description('Show all cortex branches')
  .action(async () => {
    const config = getConfig();
    if (!config.cortex?.repo) {
      console.log(chalk.dim('No cortex repo configured. Run: think cortex setup'));
      return;
    }

    ensureRepoCloned();

    const branches = listRemoteBranches();

    if (branches.length === 0) {
      console.log(chalk.dim('No cortex branches found. Run: think cortex create <name>'));
      return;
    }

    for (const branch of branches) {
      const marker = branch === config.cortex.active ? chalk.green('* ') : '  ';
      console.log(`${marker}${branch}`);
    }
  }));

// think cortex switch <name>
cortexCommand.addCommand(new Command('switch')
  .argument('<name>', 'Cortex name')
  .description('Set the active cortex')
  .action(async (name: string) => {
    const config = getConfig();
    if (!config.cortex?.repo) {
      console.error(chalk.red('No cortex repo configured. Run: think cortex setup'));
      process.exit(1);
    }

    ensureRepoCloned();

    if (!branchExists(name)) {
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
