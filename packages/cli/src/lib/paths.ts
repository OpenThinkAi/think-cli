import path from 'node:path';
import fs from 'node:fs';

function getHome(): string {
  const home = process.env.HOME;
  if (!home) {
    throw new Error('HOME environment variable is not set');
  }
  return home;
}

export function sanitizeName(name: string): string {
  if (!name || /[\/\\\.]{2}/.test(name) || /[^a-zA-Z0-9_-]/.test(name)) {
    throw new Error(`Invalid cortex name: "${name}". Use only alphanumeric characters, hyphens, and underscores.`);
  }
  return name;
}

function getThinkHome(): string | null {
  const thinkHome = process.env.THINK_HOME;
  if (thinkHome === undefined || thinkHome === '') return null;
  return thinkHome;
}

export function getThinkDir(): string {
  return getThinkHome() ?? path.join(getHome(), '.think');
}

export function getThinkConfigDir(): string {
  const thinkHome = getThinkHome();
  if (thinkHome) return path.join(thinkHome, 'config');
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(getHome(), '.config');
  return path.join(xdgConfig, 'think');
}

export function getThinkDataDir(): string {
  const thinkHome = getThinkHome();
  if (thinkHome) return path.join(thinkHome, 'data');
  const xdgData = process.env.XDG_DATA_HOME || path.join(getHome(), '.local', 'share');
  return path.join(xdgData, 'think');
}

export function getEngramsDir(): string {
  return path.join(getThinkDir(), 'engrams');
}

export function getEngramDbPath(cortexName: string): string {
  return path.join(getEngramsDir(), `${sanitizeName(cortexName)}.db`);
}

export function getRepoPath(): string {
  return path.join(getThinkDir(), 'repo');
}

export function getLongtermDir(): string {
  return path.join(getThinkDir(), 'longterm');
}

export function getLongtermPath(cortexName: string): string {
  return path.join(getLongtermDir(), `${sanitizeName(cortexName)}.md`);
}

export function getCuratorMdPath(): string {
  return path.join(getThinkDir(), 'curator.md');
}

export function ensureThinkDirs(): void {
  fs.mkdirSync(getEngramsDir(), { recursive: true });
  fs.mkdirSync(getLongtermDir(), { recursive: true });
}
