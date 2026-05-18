/**
 * Shared package-root sentinel-walk helpers.
 *
 * `resolvePackageEntry` is used in two places via `claude-settings.ts`:
 *   - `resolveHookScriptPath`  — locates dist/hooks/user-prompt-submit.js
 *   - `resolveMcpServerPath`   — locates dist/mcp/server.js
 *
 * `daemon-client.ts` has an equivalent inline copy (`resolveDaemonEntryFromDir`)
 * that predates this helper and is exported for testing. It is intentionally
 * kept separate to avoid breaking its public test surface.
 *
 * The function walks candidate parent directories outward from `thisDir`,
 * looking for the `@openthink/think` `package.json` sentinel, then returns
 * the requested subpath under that root. Name-pinning is required because the
 * monorepo workspace root has its own `package.json` that must NOT match.
 *
 * Layouts handled:
 *   - bundled dist (tsup): thisDir = dist/         → ../package.json
 *   - dev source:          thisDir = src/lib/       → ../../package.json
 *   - dev source deeper:   thisDir = src/lib/sub/   → ../../../package.json
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Walk outward from `thisDir` up to three levels looking for a
 * `package.json` with `name === "@openthink/think"` and return the
 * resolved absolute path for the given `subpath` segments under that root.
 *
 * @param thisDir   The directory to start walking from.
 *                  Pass `path.dirname(fileURLToPath(import.meta.url))` in
 *                  ESM modules so the path survives bundling.
 * @param subpath   Path segments to join onto the found package root.
 *
 * @throws {Error}  If no matching manifest is found within the walk depth.
 */
export function resolvePackageEntry(thisDir: string, ...subpath: string[]): string {
  const candidates = [
    path.join(thisDir, '..'),
    path.join(thisDir, '..', '..'),
    path.join(thisDir, '..', '..', '..'),
  ];
  for (const root of candidates) {
    const manifest = path.join(root, 'package.json');
    if (!fs.existsSync(manifest)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(manifest, 'utf-8')) as { name?: string };
      if (parsed.name === '@openthink/think') {
        return path.join(root, ...subpath);
      }
    } catch {
      // unreadable / not JSON — try next candidate
    }
  }
  throw new Error(
    `could not locate @openthink/think package root from ${thisDir} — install may be corrupted`,
  );
}
