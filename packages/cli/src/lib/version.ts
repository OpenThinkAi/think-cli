import fs from 'node:fs';
import path from 'node:path';

/**
 * Read this package's version from package.json. Used by both `think
 * --version` (`src/index.ts`) and the proxy's startup banner / `/v1/health`
 * body (`src/serve/version.ts`). Single source of truth; the bundled dist
 * still resolves the file because tsup keeps the manifest sibling to the
 * binary.
 *
 * Two candidate paths because `import.meta.dirname` lives in different
 * spots at runtime:
 *   - dev (`tsx`): `src/.../version.ts`         → ../../package.json
 *   - dev (`tsx` in src/): `src/version.ts`     → ../package.json
 *   - bundled (`dist/index.js`): `dist/`        → ../package.json
 *   - bundled (`dist/boot-entry-*.js`): `dist/` → ../package.json
 */
export function readPackageVersion(): string {
  try {
    const candidates = [
      path.join(import.meta.dirname, '..', 'package.json'),       // dist/, src/
      path.join(import.meta.dirname, '..', '..', 'package.json'), // src/<dir>/
      path.join(import.meta.dirname, '..', '..', '..', 'package.json'), // src/<dir>/<dir>/
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) as { name?: string; version?: string };
        // Pin to the right manifest in the monorepo by name — `..` from
        // some dist layouts lands at the workspace root, which has its
        // own package.json with a different version.
        if (parsed.name === '@openthink/think' && typeof parsed.version === 'string') {
          return parsed.version;
        }
      }
    }
    return '0.0.0';
  } catch {
    return '0.0.0';
  }
}
