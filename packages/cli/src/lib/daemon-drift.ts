/**
 * Daemon/CLI version-drift helpers (#91).
 *
 * The resident daemon keeps its code in memory, so replacing the global
 * package on disk (`think update`, `npm install -g`) leaves it serving the
 * previous version indefinitely — and recall/sync/compaction all execute
 * daemon-side, so the user "updates" without getting the update. These
 * helpers let `think update` detect and heal that drift, and let
 * `think daemon status` surface it.
 *
 * Everything here is written to be safe to call from an OLD CLI process
 * whose on-disk dist/ has just been replaced: `inspectDaemon` must run
 * BEFORE the install (it dynamically imports daemon modules), while
 * `restartDaemonViaBin` deliberately shells out to the freshly installed
 * entry point instead of importing anything — the bundle's chunk names are
 * content-hashed, so in-process imports after the swap can fail or, worse,
 * mix old and new code.
 */

import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** What we could learn about the resident daemon before an update. */
export interface DaemonInspection {
  /** True when a daemon is reachable on the default socket. */
  reachable: boolean;
  /**
   * The version the daemon reports via the `status` RPC, or null when the
   * daemon is unreachable OR too old to implement the RPC. A reachable
   * daemon with a null version predates AGT-287 — certainly stale.
   */
  version: string | null;
}

/**
 * Sanitize a daemon-reported version string for terminal-facing output.
 *
 * The daemon RPC is a separate trust boundary: a compromised package serving
 * as the daemon could embed `\r` or ANSI escape sequences in `version` to
 * overwrite or spoof the very warning that tells the user about it. Take the
 * first line, then strip all remaining C0 control characters and DEL —
 * killing carriage returns and the ESC that ANSI sequences need to activate.
 */
export function sanitizeDaemonVersion(raw: unknown): string {
  // eslint-disable-next-line no-control-regex
  return String(raw).split('\n')[0].replace(/[\x00-\x1f\x7f]/g, '');
}

/**
 * Probe the default socket and, if a daemon answers, ask it what version it
 * is running. Never spawns a daemon: `connectDaemon` is only called after a
 * successful probe, mirroring the guard in `think daemon status`.
 */
export async function inspectDaemon(): Promise<DaemonInspection> {
  const { probeDaemon, connectDaemon } = await import('./daemon-client.js');
  const alive = await probeDaemon(500);
  if (!alive) return { reachable: false, version: null };
  try {
    const client = await connectDaemon();
    try {
      const rpcResult = await client.call('status', {}, 5000);
      const r = (typeof rpcResult === 'object' && rpcResult !== null)
        ? rpcResult as Record<string, unknown>
        : {};
      // The value flows into single-line console output — see
      // sanitizeDaemonVersion for the trust-boundary rationale.
      const version = r['version'] !== undefined
        ? sanitizeDaemonVersion(r['version'])
        : null;
      return { reachable: true, version };
    } finally {
      client.close();
    }
  } catch {
    // Reachable but not answering the status RPC (METHOD_NOT_FOUND on an old
    // daemon, or a transient connect failure). Version unknown.
    return { reachable: true, version: null };
  }
}

/**
 * Should the daemon be restarted to serve `installedVersion`?
 *
 * Matrix:
 *  - no daemon reachable        → no (the next `daemon start` runs new code)
 *  - installed version unknown  → no (nothing to compare against)
 *  - daemon version == installed → no (already in sync)
 *  - daemon version differs OR is unknown → yes (an unknown version means
 *    the daemon predates the status RPC — older by definition)
 */
export function needsDaemonRestart(
  daemon: DaemonInspection,
  installedVersion: string | null,
): boolean {
  if (!daemon.reachable) return false;
  if (!installedVersion) return false;
  return daemon.version !== installedVersion;
}

/** Exec seam for tests; production default is execFileSync. */
export type ExecFn = (file: string, args: string[]) => void;

export interface RestartResult {
  ok: boolean;
  /** Human-readable failure detail when ok=false. */
  error?: string;
}

/**
 * Restart the daemon by shelling out to the CLI entry point under `pkgRoot`
 * (the `@openthink/think` package directory) — NOT by importing daemon
 * modules into this process. After `npm install -g` the on-disk bundle is
 * new code while this process is old code; spawning
 * `node <pkgRoot>/dist/index.js daemon stop|start` guarantees both the stop
 * and the spawned daemon run the freshly installed version.
 */
export function restartDaemonViaBin(pkgRoot: string, exec?: ExecFn): RestartResult {
  const bin = path.join(pkgRoot, 'dist', 'index.js');
  const run: ExecFn = exec ?? ((file, args) => {
    execFileSync(file, args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // stop waits up to 5s for exit; start's connect-retry loop can take
      // longer on a cold spawn. 60s comfortably covers both without hanging
      // `think update` indefinitely on a wedged daemon.
      timeout: 60_000,
    });
  });
  try {
    run(process.execPath, [bin, 'daemon', 'stop']);
    run(process.execPath, [bin, 'daemon', 'start']);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
