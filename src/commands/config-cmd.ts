import { Command } from 'commander';
import chalk from 'chalk';
import { getConfig, saveConfig } from '../lib/config.js';

export const configCommand = new Command('config')
  .description('View or update think configuration');

configCommand.addCommand(new Command('show')
  .description('Print current configuration')
  .action(() => {
    const config = getConfig();
    console.log(JSON.stringify(config, null, 2));
  }));

configCommand.addCommand(new Command('set')
  .argument('<key>', 'Config key (e.g., cortex.curateEveryN, cortex.confirmBeforeCommit)')
  .argument('<value>', 'Value to set')
  .description('Set a configuration value')
  .action((key: string, value: string) => {
    const config = getConfig();

    // Parse value
    let parsed: unknown = value;
    if (value === 'true') parsed = true;
    else if (value === 'false') parsed = false;
    else if (/^\d+$/.test(value)) parsed = parseInt(value, 10);

    // Set nested keys
    const parts = key.split('.');
    let target: Record<string, unknown> = config as Record<string, unknown>;

    for (let i = 0; i < parts.length - 1; i++) {
      if (!target[parts[i]] || typeof target[parts[i]] !== 'object') {
        target[parts[i]] = {};
      }
      target = target[parts[i]] as Record<string, unknown>;
    }

    target[parts[parts.length - 1]] = parsed;
    saveConfig(config);

    console.log(chalk.green('✓') + ` ${key} = ${JSON.stringify(parsed)}`);
  }));
