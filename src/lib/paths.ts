import path from 'node:path';
import fs from 'node:fs';

export function getThinkDir(): string {
  return path.join(process.env.HOME!, '.think');
}

export function getEngramsDir(): string {
  return path.join(getThinkDir(), 'engrams');
}

export function getEngramDbPath(cortexName: string): string {
  return path.join(getEngramsDir(), `${cortexName}.db`);
}

export function getRepoPath(): string {
  return path.join(getThinkDir(), 'repo');
}

export function getLongtermDir(): string {
  return path.join(getThinkDir(), 'longterm');
}

export function getLongtermPath(cortexName: string): string {
  return path.join(getLongtermDir(), `${cortexName}.md`);
}

export function getCuratorMdPath(): string {
  return path.join(getThinkDir(), 'curator.md');
}

export function ensureThinkDirs(): void {
  fs.mkdirSync(getEngramsDir(), { recursive: true });
  fs.mkdirSync(getLongtermDir(), { recursive: true });
}
