import path from 'node:path';
import fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';

export interface Config {
  peerId: string;
  syncPort: number;
  anthropicApiKey?: string;
}

export function getConfigDir(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME!, '.config');
  return path.join(xdgConfig, 'think');
}

function configPath(): string {
  return path.join(getConfigDir(), 'config.json');
}

export function saveConfig(config: Config): void {
  const dir = getConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n', 'utf-8');
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
