import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { getConfigDir } from './config.js';

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const PACKAGE_NAME = '@openthink/think';

interface VersionCache {
  latest: string;
  checkedAt: number;
}

function cachePath(): string {
  return path.join(getConfigDir(), 'version-cache.json');
}

function readCache(): VersionCache | null {
  try {
    const raw = fs.readFileSync(cachePath(), 'utf-8');
    return JSON.parse(raw) as VersionCache;
  } catch {
    return null;
  }
}

function writeCache(cache: VersionCache): void {
  const dir = getConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cachePath(), JSON.stringify(cache), 'utf-8');
}

function getInstalledVersion(): string | null {
  try {
    const pkgPath = path.join(import.meta.dirname, '..', 'package.json');
    const raw = fs.readFileSync(pkgPath, 'utf-8');
    return JSON.parse(raw).version ?? null;
  } catch {
    return null;
  }
}

function isNewer(latest: string, current: string): boolean {
  const l = latest.split('.').map(Number);
  const c = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((l[i] ?? 0) > (c[i] ?? 0)) return true;
    if ((l[i] ?? 0) < (c[i] ?? 0)) return false;
  }
  return false;
}

export function checkForUpdate(): string | null {
  // Opt-out for air-gapped machines, privacy-minded users, and environments
  // where outbound network calls are undesirable. Any common truthy value
  // (1, true, yes — case-insensitive) skips the background `npm view` call
  // entirely.
  const optOut = (process.env.THINK_NO_UPDATE_CHECK ?? '').trim().toLowerCase();
  if (optOut === '1' || optOut === 'true' || optOut === 'yes') return null;

  const installed = getInstalledVersion();
  if (!installed) return null;

  const cache = readCache();
  const now = Date.now();

  // Return cached result if fresh
  if (cache && (now - cache.checkedAt) < CHECK_INTERVAL_MS) {
    if (isNewer(cache.latest, installed)) {
      return `@openthink/think ${cache.latest} available (you have ${installed}). Run: npm update -g @openthink/think`;
    }
    return null;
  }

  // Check in background — don't block the current command
  execFile('npm', ['view', PACKAGE_NAME, 'version'], { timeout: 5000 }, (err, stdout) => {
    if (err) return;
    const latest = stdout.trim();
    if (latest) {
      writeCache({ latest, checkedAt: Date.now() });
    }
  });

  // On first check, use cached value if available (stale but better than nothing)
  if (cache && isNewer(cache.latest, installed)) {
    return `@openthink/think ${cache.latest} available (you have ${installed}). Run: npm update -g @openthink/think`;
  }

  return null;
}
