import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { getThinkDir } from './paths.js';

// Shared launchd-agent installer. `cortex auto-curate` and `cortex auto-sync`
// were its original callers and were deleted in AGT-1303; `think subscribe
// install-agent` still uses it, and the reaper below still cleans up the
// agents those two left behind. Each caller binds a config (label prefix, command
// args, RunAtLoad flag, default interval, log filename) and gets back a
// suite of install/uninstall/status helpers with stable behavior across
// agents — a bug fixed here is fixed for both.

export interface LaunchAgentConfig {
  /**
   * Label prefix, e.g. `ai.openthink.curate`. The full label appends a
   * sha1(THINK_HOME) suffix so personal vs work cortexes get independent
   * agents. Two agents with different prefixes can coexist on the same
   * THINK_HOME without colliding.
   */
  labelPrefix: string;
  /**
   * Args after the resolved think binary, e.g. `['curate', '--if-idle']`
   * or `['cortex', 'sync', '--if-online']`. The plist's ProgramArguments
   * is `[node, think, ...commandArgs]`.
   */
  commandArgs: string[];
  /**
   * Whether launchd should fire the agent on load (login, `enable`,
   * reboot). True for sync (catch up immediately on session start),
   * false for curate (no rush; next tick is fine).
   */
  runAtLoad: boolean;
  /** Default cadence in seconds when the user doesn't pass `--interval`. */
  defaultIntervalSeconds: number;
  /** Filename under getThinkDir(), e.g. `auto-subscribe.log`. */
  logFileName: string;
}

export interface LaunchAgentApi {
  getAgentLabel(): string;
  getPlistPath(label?: string): string;
  getLogPath(): string;
  installAgent(opts?: { intervalSeconds?: number }): { label: string; plistPath: string };
  uninstallAgent(): { removed: boolean; plistPath: string };
  getAgentStatus(): AgentStatus;
}

export interface AgentStatus {
  installed: boolean;
  label: string;
  plistPath: string;
  loaded: boolean;
  lastRunAt: Date | null;
  intervalSeconds: number | null;
}

export interface InstallOptions {
  intervalSeconds?: number;
}

function getHome(): string {
  const home = process.env.HOME;
  if (!home) throw new Error('HOME environment variable is not set');
  return home;
}

export function getLaunchAgentsDir(): string {
  return path.join(getHome(), 'Library', 'LaunchAgents');
}

function resolveThinkBinary(): string {
  const arg1 = process.argv[1];
  if (arg1 && fs.existsSync(arg1)) return arg1;
  throw new Error('Could not resolve think binary path (could not locate the think CLI; reinstall or run `which think`).');
}

function resolveNodeBinary(): string {
  return process.execPath;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface PlistOptions {
  label: string;
  nodePath: string;
  thinkPath: string;
  commandArgs: string[];
  runAtLoad: boolean;
  thinkHome: string | undefined;
  intervalSeconds: number;
  logPath: string;
}

function renderPlist(opts: PlistOptions): string {
  const envBlock = opts.thinkHome
    ? `    <key>EnvironmentVariables</key>
    <dict>
      <key>THINK_HOME</key>
      <string>${escapeXml(opts.thinkHome)}</string>
    </dict>
`
    : '';

  const argsXml = [opts.nodePath, opts.thinkPath, ...opts.commandArgs]
    .map((a) => `      <string>${escapeXml(a)}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${escapeXml(opts.label)}</string>
    <key>ProgramArguments</key>
    <array>
${argsXml}
    </array>
    <key>StartInterval</key>
    <integer>${opts.intervalSeconds}</integer>
    <key>RunAtLoad</key>
    <${opts.runAtLoad ? 'true' : 'false'}/>
${envBlock}    <key>StandardOutPath</key>
    <string>${escapeXml(opts.logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(opts.logPath)}</string>
  </dict>
</plist>
`;
}

export function createLaunchAgent(config: LaunchAgentConfig): LaunchAgentApi {
  function getAgentLabel(): string {
    const thinkHome = process.env.THINK_HOME;
    if (!thinkHome) return `${config.labelPrefix}.default`;
    const hash = crypto.createHash('sha1').update(thinkHome).digest('hex').slice(0, 8);
    return `${config.labelPrefix}.${hash}`;
  }

  function getPlistPath(label: string = getAgentLabel()): string {
    return path.join(getLaunchAgentsDir(), `${label}.plist`);
  }

  function getLogPath(): string {
    return path.join(getThinkDir(), config.logFileName);
  }

  function installAgent(opts: { intervalSeconds?: number } = {}): { label: string; plistPath: string } {
    if (process.platform !== 'darwin') {
      throw new Error(`launchd agents are macOS-only. For Linux, run \`think ${config.commandArgs.join(' ')}\` from cron or systemd.`);
    }

    const label = getAgentLabel();
    const plistPath = getPlistPath(label);
    const agentsDir = getLaunchAgentsDir();

    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(getThinkDir(), { recursive: true });

    const plist = renderPlist({
      label,
      nodePath: resolveNodeBinary(),
      thinkPath: resolveThinkBinary(),
      commandArgs: config.commandArgs,
      runAtLoad: config.runAtLoad,
      thinkHome: process.env.THINK_HOME,
      intervalSeconds: opts.intervalSeconds ?? config.defaultIntervalSeconds,
      logPath: getLogPath(),
    });

    fs.writeFileSync(plistPath, plist, { mode: 0o644 });

    // Idempotent install: unload-then-load so re-running `enable` picks up
    // a changed interval. Ignore unload failure (agent wasn't loaded).
    try { execFileSync('launchctl', ['unload', plistPath], { stdio: 'ignore' }); } catch { /* not loaded */ }
    execFileSync('launchctl', ['load', plistPath], { stdio: 'ignore' });

    return { label, plistPath };
  }

  function uninstallAgent(): { removed: boolean; plistPath: string } {
    const plistPath = getPlistPath();
    if (!fs.existsSync(plistPath)) {
      return { removed: false, plistPath };
    }
    if (process.platform === 'darwin') {
      try { execFileSync('launchctl', ['unload', plistPath], { stdio: 'ignore' }); } catch { /* not loaded */ }
    }
    fs.unlinkSync(plistPath);
    return { removed: true, plistPath };
  }

  function getAgentStatus(): AgentStatus {
    const label = getAgentLabel();
    const plistPath = getPlistPath(label);
    const installed = fs.existsSync(plistPath);

    let loaded = false;
    let intervalSeconds: number | null = null;
    if (installed && process.platform === 'darwin') {
      try {
        const out = execFileSync('launchctl', ['list', label], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
        loaded = out.trim().length > 0;
      } catch {
        loaded = false;
      }
      try {
        const plist = fs.readFileSync(plistPath, 'utf-8');
        const match = plist.match(/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/);
        if (match) intervalSeconds = parseInt(match[1], 10);
      } catch { /* ignore */ }
    }

    let lastRunAt: Date | null = null;
    const logPath = getLogPath();
    if (fs.existsSync(logPath)) {
      try {
        const stat = fs.statSync(logPath);
        lastRunAt = stat.mtime;
      } catch { /* ignore */ }
    }

    return { installed, label, plistPath, loaded, lastRunAt, intervalSeconds };
  }

  return { getAgentLabel, getPlistPath, getLogPath, installAgent, uninstallAgent, getAgentStatus };
}

// ---------------------------------------------------------------------------
// Stale-agent reaper (AGT-1301)
//
// `getAgentLabel()` above suffixes the label with sha1(THINK_HOME), so every
// THINK_HOME a machine has ever pointed at gets its own curate/sync agent —
// and nothing ever removed one. With `think curate` and the daemon-down sync
// bypass now deleted (AGT-1303), a stranded agent invokes a nonexistent
// command forever. This reaps them unconditionally on daemon start,
// regardless of which THINK_HOME the daemon itself is running under: it
// matches on label PREFIX (`ai.openthink.curate.` / `ai.openthink.sync.`),
// not on the current home's hash.
//
// Deliberately exported as a plain function with every input injected
// (directory, platform, unload) rather than a method bound to one
// LaunchAgentApi instance: AGT-1307 (heal summary) and AGT-1308 (doctor)
// both need to run the same matcher and report on it, and tests must never
// touch the real ~/Library/LaunchAgents (see packages/cli/tests for the
// fixture-directory suite).
// ---------------------------------------------------------------------------

/** Label prefixes this reaper removes. Order doesn't matter; kept as a tuple
 *  so a filename/Label match can report *which* prefix it matched under. */
const REAPED_LABEL_PREFIXES = ['ai.openthink.curate.', 'ai.openthink.sync.'] as const;

export interface ReapedLaunchAgent {
  /** The plist's Label key (not just the filename-derived guess). */
  label: string;
  plistPath: string;
  /** Which of REAPED_LABEL_PREFIXES matched. */
  prefix: string;
  /** False if `launchctl unload` failed (e.g. agent wasn't loaded) — the
   *  plist is still deleted either way. */
  unloaded: boolean;
}

export interface ReapLaunchAgentsOptions {
  /** Directory to scan for stale agents. Defaults to ~/Library/LaunchAgents.
   *  Tests MUST inject a temp directory here — never the real one. */
  launchAgentsDir?: string;
  /** Defaults to process.platform. Inject e.g. 'linux' to exercise the
   *  no-op path without needing to run this suite on Linux. */
  platform?: NodeJS.Platform;
  /** Called once per plist about to be deleted, so it can be unloaded first.
   *  Defaults to a real `launchctl unload`. Tests MUST inject a fake here —
   *  never let this hit the real launchctl / real loaded agents. Throwing
   *  (e.g. "not loaded") is expected and non-fatal: the plist is still
   *  deleted, just reported with unloaded: false. */
  unload?: (plistPath: string) => void;
  /** Optional one-line-per-action sink, wired to daemon.log by the caller. */
  log?: (message: string) => void;
  /**
   * Report what WOULD be reaped without unloading or deleting anything
   * (AGT-1308). Added so `think doctor` can report stale agents through the
   * exact matcher `--fix` and daemon start then use, rather than growing a
   * second, drifting copy of the filename/Label agreement rule above.
   *
   * `ReapedLaunchAgent.unloaded` is always false under a dry run — nothing was
   * unloaded, so there is no outcome to report.
   */
  dryRun?: boolean;
}

function defaultUnload(plistPath: string): void {
  execFileSync('launchctl', ['unload', plistPath], { stdio: 'ignore' });
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/** Pulls the <key>Label</key><string>…</string> value out of plist XML, or
 *  null if the file doesn't parse as a plist with a Label key at all. Mirrors
 *  the StartInterval regex-scrape in getAgentStatus() above rather than
 *  pulling in a full plist parser for one field. */
function extractPlistLabel(xml: string): string | null {
  const match = xml.match(/<key>\s*Label\s*<\/key>\s*<string>([^<]*)<\/string>/);
  if (!match) return null;
  return unescapeXml(match[1]);
}

/**
 * Removes every `ai.openthink.curate.*` / `ai.openthink.sync.*` LaunchAgent
 * plist directly inside `launchAgentsDir`, across all THINK_HOMEs, unloading
 * each first. Everything else — `ai.openthink.subscribe.*`,
 * `ai.openthink.pablo.*`, any `com.openthink.*`, unrelated third-party
 * agents — is left untouched.
 *
 * No-op, never throws: wrong platform, missing directory, empty directory,
 * or an unload that fails all resolve to a (possibly shorter) result array,
 * never an exception. Callers (daemon start) can therefore call this
 * unconditionally without a surrounding try/catch, though daemon start
 * wraps it anyway as defense-in-depth for a future edit here.
 *
 * Matching is deliberately conservative. A plist's filename mirrors its
 * Label at install time (`getPlistPath` names the file `${label}.plist`),
 * but a file on disk could have been edited or replaced since. This checks
 * BOTH signals and requires them to agree on the same prefix before
 * deleting anything:
 *   - filename doesn't match either prefix              → not ours, skip
 *   - filename matches but Label key is missing/unparsable → skip + log
 *     (can't rule out a plist that isn't ours after all)
 *   - filename matches one prefix, Label matches a different one (or none)
 *     → skip + log (ambiguous — a human should look at this, not the reaper)
 *   - filename and Label agree on the same prefix         → delete
 *
 * With `dryRun: true` the same proof runs and the same array comes back, but
 * nothing is unloaded or deleted — that is how `think doctor` reports this
 * check (AGT-1308).
 *
 * Only regular files directly inside the directory are considered:
 * `fs.readdirSync(..., { withFileTypes: true })` + `Dirent.isFile()` is
 * false for symlinks and subdirectories, so this never follows a symlink
 * out of LaunchAgents or descends into one.
 */
export function reapStaleLaunchAgents(options: ReapLaunchAgentsOptions = {}): ReapedLaunchAgent[] {
  const platform = options.platform ?? process.platform;
  const removed: ReapedLaunchAgent[] = [];

  // AC4: no-op (no error) on Linux — LaunchAgents don't exist there.
  if (platform !== 'darwin') return removed;

  let launchAgentsDir: string;
  try {
    launchAgentsDir = options.launchAgentsDir ?? getLaunchAgentsDir();
  } catch {
    // HOME unset, or similar — nothing to reap, never fatal.
    return removed;
  }

  const unload = options.unload ?? defaultUnload;
  const log = options.log ?? ((): void => {});
  const dryRun = options.dryRun === true;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(launchAgentsDir, { withFileTypes: true });
  } catch {
    // AC4: directory doesn't exist (fresh machine, never installed an agent).
    return removed;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.plist')) continue;

    const filenameLabel = entry.name.slice(0, -'.plist'.length);
    const filenamePrefix = REAPED_LABEL_PREFIXES.find((p) => filenameLabel.startsWith(p));
    if (!filenamePrefix) continue;

    const plistPath = path.join(launchAgentsDir, entry.name);

    let contents: string;
    try {
      contents = fs.readFileSync(plistPath, 'utf-8');
    } catch (err: unknown) {
      log(`launch-agent reap: skipping ${entry.name} — could not read plist: ${String(err)}`);
      continue;
    }

    const label = extractPlistLabel(contents);
    if (label === null) {
      log(`launch-agent reap: skipping ${entry.name} — filename matches "${filenamePrefix}" but no Label key found; leaving for manual review`);
      continue;
    }

    const labelPrefix = REAPED_LABEL_PREFIXES.find((p) => label.startsWith(p));
    if (labelPrefix !== filenamePrefix) {
      log(`launch-agent reap: skipping ${entry.name} — filename implies "${filenamePrefix}" but plist Label is "${label}"; leaving for manual review`);
      continue;
    }

    // Dry run stops here, after the same two-signal agreement proof and
    // before the first side effect: the caller learns exactly which plists a
    // real run would remove.
    if (dryRun) {
      removed.push({ label, plistPath, prefix: labelPrefix, unloaded: false });
      continue;
    }

    let unloaded = true;
    try {
      unload(plistPath);
    } catch {
      // Not loaded (already unloaded, or install never `load`ed it) —
      // expected and non-fatal. Still remove the stale file below.
      unloaded = false;
    }

    try {
      fs.unlinkSync(plistPath);
    } catch (err: unknown) {
      log(`launch-agent reap: failed to delete ${plistPath}: ${String(err)}`);
      continue;
    }

    log(`launch-agent reap: removed ${label} (${plistPath})`);
    removed.push({ label, plistPath, prefix: labelPrefix, unloaded });
  }

  return removed;
}
