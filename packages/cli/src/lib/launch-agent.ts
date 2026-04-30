import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { getThinkDir } from './paths.js';

// Shared launchd-agent installer used by both `cortex auto-curate` and
// `cortex auto-sync`. Each caller binds a config (label prefix, command
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
  /** Filename under getThinkDir(), e.g. `auto-curate.log`. */
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

function getLaunchAgentsDir(): string {
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
