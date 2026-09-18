import { Command } from 'commander';
import chalk from 'chalk';
import { getConfig, saveConfig } from '../lib/config.js';
import { isValidProxyUrl } from '../lib/proxy-url.js';

/**
 * Keys think-3 (AGT-1303) stopped reading when the engram write tier was
 * removed. Every one was read only by `think curate` or its prompt assembler.
 *
 * They stay settable on purpose: a script or shell history that still sets one
 * must keep exiting 0 (AC6 — note, don't fail). ALLOWED_KEYS is *derived* from
 * this set below rather than repeating the names, because a key listed here
 * but missing there would be rejected with "Unknown config key" before the
 * advisory could run — turning AC6's "note, don't fail" into exactly the
 * failure it forbids. Deriving makes that drift unrepresentable; the
 * behaviour for every key is pinned in tests/commands/config-retired-keys.test.ts.
 */
const RETIRED_KEYS = new Set([
  'cortex.curateEveryN',
  'cortex.engramTTLDays',
  'cortex.curatorPromptCharCap',
  'cortex.selectivity',
  'cortex.granularity',
  'cortex.maxMemoriesPerRun',
  'cortex.confirmBeforeCommit',
  'cortex.idleWindowMinutes',
  'cortex.staleWindowMinutes',
]);

/** Keys something still reads. */
const LIVE_KEYS = [
  'cortex.author',
  'cortex.repo',
  'cortex.active',
  'cortex.retroRelegateAfterRuns',
  'cortex.curationIntervalHours',
  'cortex.retroMinLength',
  'cortex.retroNearDupThreshold',
  'paused',
  'proxy.url',
  'search.engine',
];

/**
 * Everything `think config set` accepts: the live keys, plus the retired ones
 * — which are accepted-with-a-note rather than rejected.
 */
const ALLOWED_KEYS = new Set([...LIVE_KEYS, ...RETIRED_KEYS]);

/** Keys whose values must be one of a known enum. Checked at set time. */
const ENUM_KEYS: Record<string, string[]> = {
  'search.engine': ['brute-force', 'sqlite-vec'],
};

/**
 * Keys that require a daemon restart to take effect. A note is printed
 * after a successful write.
 */
const DAEMON_RESTART_KEYS = new Set(['proxy.url', 'cortex.curationIntervalHours']);

export const configCommand = new Command('config')
  .description('View or update think configuration');

configCommand.addCommand(new Command('show')
  .description('Print current configuration')
  .action(() => {
    const config = getConfig();
    console.log(JSON.stringify(config, null, 2));
  }));

configCommand.addCommand(new Command('set')
  .argument('<key>', 'Config key (e.g., cortex.author, cortex.confirmBeforeCommit)')
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
    let target: Record<string, unknown> = config as unknown as Record<string, unknown>;

    for (let i = 0; i < parts.length - 1; i++) {
      if (!target[parts[i]] || typeof target[parts[i]] !== 'object') {
        target[parts[i]] = {};
      }
      target = target[parts[i]] as Record<string, unknown>;
    }

    target[parts[parts.length - 1]] = parsed;
    saveConfig(config);

    console.log(chalk.green('✓') + ` ${key} = ${JSON.stringify(parsed)}`);
    if (RETIRED_KEYS.has(key)) {
      process.stderr.write(`think: ${key} is no longer used — the engram tier was removed in think 3.\n`);
    }
    if (DAEMON_RESTART_KEYS.has(key)) {
      console.log(chalk.dim('  Restart the daemon for this change to take effect (`think daemon restart`).'));
    }
  }));
