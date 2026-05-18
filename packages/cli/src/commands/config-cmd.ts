import { Command } from 'commander';
import chalk from 'chalk';
import { getConfig, saveConfig } from '../lib/config.js';
import { isValidProxyUrl } from '../lib/proxy-url.js';

const ALLOWED_KEYS = new Set([
  'cortex.curateEveryN',
  'cortex.confirmBeforeCommit',
  'cortex.selectivity',
  'cortex.granularity',
  'cortex.maxMemoriesPerRun',
  'cortex.author',
  'cortex.repo',
  'cortex.active',
  'cortex.engramTTLDays',
  'cortex.idleWindowMinutes',
  'cortex.staleWindowMinutes',
  'cortex.retroRelegateAfterRuns',
  'paused',
  'proxy.url',
  'search.engine',
]);

/** Keys whose values must be one of a known enum. Checked at set time. */
const ENUM_KEYS: Record<string, string[]> = {
  'search.engine': ['brute-force', 'sqlite-vec'],
};

/**
 * Keys that require a daemon restart to take effect. A note is printed
 * after a successful write.
 */
const DAEMON_RESTART_KEYS = new Set(['proxy.url']);

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
    if (!ALLOWED_KEYS.has(key)) {
      console.error(chalk.red(`Unknown config key: ${key}`));
      console.error(chalk.dim(`Allowed keys: ${[...ALLOWED_KEYS].join(', ')}`));
      process.exit(1);
    }

    const allowed = ENUM_KEYS[key];
    if (allowed !== undefined && !allowed.includes(value)) {
      console.error(chalk.red(`Invalid value for ${key}: ${JSON.stringify(value)}`));
      console.error(chalk.dim(`Allowed values: ${allowed.join(', ')}`));
      process.exit(1);
    }

    // proxy.url must be ws:// or wss://.
    if (key === 'proxy.url' && value.trim() !== '' && !isValidProxyUrl(value)) {
      console.error(chalk.red(`proxy.url must be a ws:// or wss:// URL (got: ${JSON.stringify(value)})`));
      process.exit(1);
    }

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
    if (DAEMON_RESTART_KEYS.has(key)) {
      console.log(chalk.dim('  Restart the daemon for this change to take effect (`think daemon restart`).'));
    }
  }));
