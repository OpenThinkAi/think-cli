import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { getThinkDir } from './paths.js';

const DEFAULT_INTERVAL_SECONDS = 300; // 5 minutes

function getHome(): string {
  const home = process.env.HOME;
  if (!home) throw new Error('HOME environment variable is not set');
  return home;
}

function getLaunchAgentsDir(): string {
  return path.join(getHome(), 'Library', 'LaunchAgents');
}

// Derive a stable label suffix from THINK_HOME so workspace-specific plists
// don't collide. Defaults to 'default' when THINK_HOME is unset.
export function getAgentLabel(): string {
  const thinkHome = process.env.THINK_HOME;
  if (!thinkHome) return 'ai.openthink.curate.default';
  const hash = crypto.createHash('sha1').update(thinkHome).digest('hex').slice(0, 8);
  return `ai.openthink.curate.${hash}`;
}

export function getPlistPath(label: string = getAgentLabel()): string {
  return path.join(getLaunchAgentsDir(), `${label}.plist`);
}

export function getLogPath(): string {
  return path.join(getThinkDir(), 'auto-curate.log');
}

function resolveThinkBinary(): string {
  // Prefer the currently-running think binary so the scheduler uses the same
  // version the user installed (not a stale path).
  const arg1 = process.argv[1];
  if (arg1 && fs.existsSync(arg1)) return arg1;
  throw new Error('Could not resolve think binary path');
}

function resolveNodeBinary(): string {
  return process.execPath;
}

interface PlistOptions {
  label: string;
  nodePath: string;
  thinkPath: string;
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

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${escapeXml(opts.label)}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${escapeXml(opts.nodePath)}</string>
      <string>${escapeXml(opts.thinkPath)}</string>
      <string>curate</string>
      <string>--if-idle</string>
    </array>
    <key>StartInterval</key>
    <integer>${opts.intervalSeconds}</integer>
    <key>RunAtLoad</key>
    <false/>
${envBlock}    <key>StandardOutPath</key>
    <string>${escapeXml(opts.logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(opts.logPath)}</string>
  </dict>
</plist>
`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface InstallOptions {
  intervalSeconds?: number;
}

export function installAgent(opts: InstallOptions = {}): { label: string; plistPath: string } {
  if (process.platform !== 'darwin') {
    throw new Error('auto-curate install currently supports macOS only. For Linux, run `think curate --if-idle` from cron or systemd.');
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
    thinkHome: process.env.THINK_HOME,
    intervalSeconds: opts.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS,
    logPath: getLogPath(),
  });

  fs.writeFileSync(plistPath, plist, { mode: 0o644 });

  // Reload if already loaded (idempotent install); ignore failure if not loaded yet.
  try { execFileSync('launchctl', ['unload', plistPath], { stdio: 'ignore' }); } catch { /* not loaded */ }
  execFileSync('launchctl', ['load', plistPath], { stdio: 'ignore' });

  return { label, plistPath };
}

export function uninstallAgent(): { removed: boolean; plistPath: string } {
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

export interface AgentStatus {
  installed: boolean;
  label: string;
  plistPath: string;
  loaded: boolean;
  lastRunAt: Date | null;
  intervalSeconds: number | null;
}

export function getAgentStatus(): AgentStatus {
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
