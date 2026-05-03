import fs from 'node:fs';
import path from 'node:path';

// Single source of truth: read the version from packages/cli/package.json
// at module-load time. Mirrors the pattern in `src/index.ts` so the proxy's
// `/v1/health` body and startup logs stay in lockstep with the published
// package version automatically — no hand-syncing constant + manifest.
function readPackageVersion(): string {
  try {
    // From dist/, package.json sits one level up (`dist/../package.json`).
    // From src/serve/, it's three levels up. import.meta.dirname covers both.
    const candidates = [
      path.join(import.meta.dirname, '..', 'package.json'),       // dist
      path.join(import.meta.dirname, '..', '..', 'package.json'), // src/serve
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, 'utf-8')).version ?? '0.0.0';
      }
    }
    return '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const VERSION = readPackageVersion();
