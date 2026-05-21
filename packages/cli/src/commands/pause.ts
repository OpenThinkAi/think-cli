import { Command } from 'commander';
import chalk from 'chalk';
import { getConfig, saveConfig } from '../lib/config.js';

export const pauseCommand = new Command('pause')
  .description('Pause event creation — think sync will silently skip until resumed')
  .action(() => {
    const config = getConfig();
    config.paused = true;
    saveConfig(config);
    console.log(chalk.yellow('⏸') + ' Event creation paused. Run ' + chalk.dim('think resume') + ' to re-enable.');
  });

export const resumeCommand = new Command('resume')
  .description('Resume event creation after a pause')
  .action(() => {
    const config = getConfig();
    config.paused = false;
    saveConfig(config);
    console.log(chalk.green('✓') + ' Event creation resumed.');
  });
