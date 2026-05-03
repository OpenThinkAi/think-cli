import path from 'node:path';
import fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import { getThinkConfigDir } from './paths.js';

export interface FsBackendConfig {
  /**
   * Absolute path to the cortex root directory. Each cortex lives under
   * `<path>/<cortex>/` and stores per-peer JSONL buckets. Whatever sync
   * tool (iCloud, Drive, Syncthing, or none) governs the folder is opaque
   * to think — see `~/Ideas/think-cli-v2/01-local-fs-adapter.md`.
   */
  path: string;
}

export interface CortexConfig {
  /** Git remote URL. Optional — only used by the git sync backend. */
  repo?: string;
  /** Local-fs backend. Mutually exclusive with `repo`. */
  fs?: FsBackendConfig;
  active?: string;
  author: string;
  curateEveryN?: number;
  confirmBeforeCommit?: boolean;
  selectivity?: 'low' | 'medium' | 'high';
  granularity?: 'detailed' | 'summary';
  maxMemoriesPerRun?: number;
  bucketSize?: number;
  onboardingDepth?: number;
  engramTTLDays?: number;
  idleWindowMinutes?: number;
  staleWindowMinutes?: number;
}

export interface Config {
  peerId: string;
  syncPort: number;
  cortex?: CortexConfig;
  paused?: boolean;
}

export function getConfigDir(): string {
  return getThinkConfigDir();
}

function configPath(): string {
  return path.join(getConfigDir(), 'config.json');
}

export function saveConfig(config: Config): void {
  const dir = getConfigDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
}

// Module-local guard so a long-lived process that calls getConfig() many
// times only emits the v2 deprecation banner once. The persisted file is
// rewritten on the first call so subsequent processes never re-warn.
let legacyServerWarned = false;

export function getConfig(): Config {
  const fp = configPath();
  if (fs.existsSync(fp)) {
    const raw = fs.readFileSync(fp, 'utf-8');
    const parsed = JSON.parse(raw) as Config & { cortex?: { server?: { url?: unknown } } };
    if (parsed.cortex && 'server' in parsed.cortex) {
      // Echo the dropped URL (token stays redacted) so a user who upgrades,
      // runs anything, then realizes they wanted to migrate has a trace
      // they can paste into a v1 invocation. Token is intentionally never
      // surfaced — it lands in stderr/cron logs/scrollback otherwise.
      const droppedUrl = typeof parsed.cortex.server?.url === 'string' ? parsed.cortex.server.url : null;
      delete parsed.cortex.server;
      if (!legacyServerWarned) {
        legacyServerWarned = true;
        const urlLine = droppedUrl
          ? `       URL was: ${droppedUrl}  (token redacted)\n`
          : '';
        process.stderr.write(
          `think: dropped legacy \`cortex.server\` from ${fp} — the http backend retired in v2.\n` +
          urlLine +
          '       Run `think cortex setup --fs <path>` to configure the local-fs backend.\n' +
          '       (The URL/token have been removed from your config file. If you need them, recover from a backup.)\n',
        );
      }
      saveConfig(parsed);
    }
    return parsed;
  }

  const config: Config = {
    peerId: uuidv4(),
    syncPort: 47821,
  };
  saveConfig(config);
  return config;
}

/**
 * Returns this peer's stable UUID. Self-heals legacy configs that pre-date
 * the auto-generated `peerId` field by minting one and persisting it back —
 * users on an older install don't need to delete their config to upgrade.
 */
export function getPeerId(): string {
  const config = getConfig();
  if (typeof config.peerId === 'string' && config.peerId.length > 0) {
    return config.peerId;
  }
  config.peerId = uuidv4();
  saveConfig(config);
  return config.peerId;
}
