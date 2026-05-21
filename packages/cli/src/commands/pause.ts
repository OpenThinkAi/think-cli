import { Command } from 'commander';
import chalk from 'chalk';
import { getConfig, saveConfig } from '../lib/config.js';

export const pauseCommand = new Command('pause')
  .description('Pause memory creation — think sync will silently skip until resumed')
  .action(() => {
    const config = getConfig();
    config.paused = true;
    saveConfig(config);
    console.log(chalk.yellow('⏸') + ' Memory creation paused. Run ' + chalk.dim('think resume') + ' to re-enable.');
  });

export const resumeCommand = new Command('resume')
  .description('Resume memory creation after a pause')
  .action(() => {
    const config = getConfig();
    config.paused = false;
    saveConfig(config);
    console.log(chalk.green('✓') + ' Memory creation resumed.');
  });
