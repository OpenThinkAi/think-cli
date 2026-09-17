/**
 * Check: the daemon is running and serving the installed version
 * (AGT-1308 AC1).
 *
 * The resident daemon keeps its code in memory, so replacing the package on
 * disk leaves it serving the previous version indefinitely — and recall, sync
 * and compaction all execute daemon-side, so the user "updates" without
 * getting the update (#91).
 *
 * TWO sources are read, and the detail line says which one answered:
 *
 *  - the SOCKET plus the `status` RPC (`inspectDaemon`, AGT-287/#91) — the
 *    authoritative source, because only the running process can report the
 *    version it actually loaded;
 *  - the PID FILE (`isDaemonRunning`) — consulted only to tell "no daemon" apart
 *    from "a daemon is alive but not answering", which are different problems.
 *
 * Both probes are bounded: `inspectDaemon` connects with a 500 ms timeout and
 * gives the RPC 5 s, so an unreachable or wedged socket can never hang
 * `think doctor`.
 */

import { inspectDaemon, type DaemonInspection } from '../daemon-drift.js';
import { isDaemonRunning, type DaemonStatus } from '../daemon-status.js';
import { readPackageVersion } from '../version.js';
import { result, type CheckResult } from './types.js';

export const DAEMON_CHECK_ID = 'daemon-version';

export interface DaemonCheckOptions {
  /** Socket probe + `status` RPC. Tests MUST inject — never the real socket. */
  inspect?: () => Promise<DaemonInspection>;
  /** PID-file read. Tests MUST inject — never the real `~/.think/daemon.pid`. */
  pidStatus?: () => DaemonStatus;
  /** The version this CLI was installed as. Defaults to its own package.json. */
  installedVersion?: string | null;
}

export async function checkDaemonVersion(
  options: DaemonCheckOptions = {},
): Promise<CheckResult> {
  const inspect = options.inspect ?? inspectDaemon;
  const pidStatus = options.pidStatus ?? isDaemonRunning;
  const installed = options.installedVersion === undefined
    ? safeInstalledVersion()
    : options.installedVersion;

  const daemon = await inspect();

  if (!daemon.reachable) {
    const pid = readPidStatus(pidStatus);
    if (pid.running) {
      // A live process that will not answer its own socket. Restarting it is
      // the documented remedy and is what `--fix` does.
      return result(
        DAEMON_CHECK_ID,
        'fail',
        `Daemon process ${pid.pid} is alive (PID file) but its socket did not answer within 500ms.`,
        true,
      );
    }
    const staleNote = pid.stale ? ' A stale PID file is left behind.' : '';
    // Not running is a degraded install, not a broken one: writes fall back to
    // L1 and are picked up on the next start. `think doctor` deliberately does
    // not start a daemon — that is `think daemon start`, a decision for the
    // user's session, not a repair.
    return result(
      DAEMON_CHECK_ID,
      'warn',
      `No daemon is running (socket unreachable, PID file says not running).${staleNote} ` +
        'Start it with `think daemon start`.',
      false,
    );
  }

  if (installed === null) {
    return result(
      DAEMON_CHECK_ID,
      'warn',
      `Daemon is reachable and reports ${daemon.version ?? 'no version'}, ` +
        'but the installed CLI version could not be read to compare against.',
      false,
    );
  }

  if (daemon.version === installed) {
    return result(
      DAEMON_CHECK_ID,
      'pass',
      `Daemon is running ${installed} (status RPC), matching the installed CLI.`,
    );
  }

  // A reachable daemon with no version predates the `status` RPC — older by
  // definition, which is exactly `needsDaemonRestart`'s rule.
  const running = daemon.version ?? 'a version older than the status RPC';
  return result(
    DAEMON_CHECK_ID,
    'fail',
    `Daemon is serving ${running} but the installed CLI is ${installed} — ` +
      'recall, sync and compaction all run daemon-side, so they are still on the old code.',
    true,
  );
}

/** The CLI's own package version. Null when it cannot be read, which is
 *  reported rather than guessed at. */
function safeInstalledVersion(): string | null {
  try {
    const version = readPackageVersion();
    return version.length > 0 ? version : null;
  } catch {
    return null;
  }
}

/** `isDaemonRunning` throws on an unreadable PID file (anything but ENOENT).
 *  Doctor must survive that: an unreadable PID file is simply no answer. */
function readPidStatus(pidStatus: () => DaemonStatus): DaemonStatus {
  try {
    return pidStatus();
  } catch {
    return { running: false };
  }
}
