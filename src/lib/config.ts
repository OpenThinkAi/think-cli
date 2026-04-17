import path from 'node:path';
import fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import { getThinkConfigDir } from './paths.js';

export interface CortexConfig {
  repo: string;
  active?: string;
  author: string;
  curateEveryN?: number;
  confirmBeforeCommit?: boolean;
  selectivity?: 'low' | 'medium' | 'high';
  granularity?: 'detailed' | 'summary';
  maxMemoriesPerRun?: number;
  bucketSize?: number;
  onboardingDepth?: number;
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
