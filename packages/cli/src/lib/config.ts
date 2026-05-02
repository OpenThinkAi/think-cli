import path from 'node:path';
import fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import { getThinkConfigDir } from './paths.js';

export interface ServerBackendConfig {
  /** Base URL of an open-think-server instance, e.g. `https://think.mycorp.com`. */
  url: string;
  /** Bearer token presented as `Authorization: Bearer <token>`. */
  token: string;
}

export interface CortexConfig {
  /** Git remote URL. Optional — only used by the git sync backend. */
  repo?: string;
  /** open-think-server backend. Mutually exclusive with `repo`. */
  server?: ServerBackendConfig;
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

export function getConfig(): Config {
  const fp = configPath();
  if (fs.existsSync(fp)) {
    const raw = fs.readFileSync(fp, 'utf-8');
    return JSON.parse(raw) as Config;
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
