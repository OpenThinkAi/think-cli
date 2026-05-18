import path from 'node:path';
import fs from 'node:fs';

function getHome(): string {
  const home = process.env.HOME;
  if (!home) {
    throw new Error('HOME environment variable is not set');
  }
  return home;
}

export function sanitizeName(name: string): string {
  if (!name || /[\/\\\.]{2}/.test(name) || /[^a-zA-Z0-9_-]/.test(name)) {
    throw new Error(`Invalid cortex name: "${name}". Use only alphanumeric characters, hyphens, and underscores.`);
  }
  return name;
}

function getThinkHome(): string | null {
  const thinkHome = process.env.THINK_HOME;
  if (thinkHome === undefined || thinkHome === '') return null;
  return thinkHome;
}

export function getThinkDir(): string {
  return getThinkHome() ?? path.join(getHome(), '.think');
}

export function getThinkConfigDir(): string {
  const thinkHome = getThinkHome();
  if (thinkHome) return path.join(thinkHome, 'config');
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(getHome(), '.config');
  return path.join(xdgConfig, 'think');
}

export function getThinkDataDir(): string {
  const thinkHome = getThinkHome();
  if (thinkHome) return path.join(thinkHome, 'data');
  const xdgData = process.env.XDG_DATA_HOME || path.join(getHome(), '.local', 'share');
  return path.join(xdgData, 'think');
}

export function getIndexDir(): string {
  return path.join(getThinkDir(), 'index');
}

export function getIndexDbPath(cortexName: string): string {
  return path.join(getIndexDir(), `${sanitizeName(cortexName)}.db`);
}

export function getRepoPath(): string {
  return path.join(getThinkDir(), 'repo');
}

export function getLongtermDir(): string {
  return path.join(getThinkDir(), 'longterm');
}

export function getLongtermPath(cortexName: string): string {
  return path.join(getLongtermDir(), `${sanitizeName(cortexName)}.md`);
}

export function getCuratorMdPath(): string {
  return path.join(getThinkDir(), 'curator.md');
}

/** Module-level guard so the migration check runs at most once per process. */
let _migrationChecked = false;

/**
 * Consolidate engrams/ → index/ when both directories exist and the session
 * is interactive.  Called from the confirmation path of
 * maybeMigrateEngramsToIndex; separated for testability.
 *
 * Strategy when the same cortex .db exists in BOTH dirs: prefer index/ (v3
 * canonical), back up the engrams/ copy to a timestamped sibling directory
 * outside engrams/ so the user can recover it, then discard the engrams/ copy.
 *
 * @param oldDir  Path to the engrams/ directory.
 * @param newDir  Path to the index/ directory.
 */
export function consolidateEngramsToIndex(oldDir: string, newDir: string): void {
  fs.mkdirSync(newDir, { recursive: true });

  const files = fs.readdirSync(oldDir);
  const ts = Date.now();
  let movedCount = 0;

  for (const file of files) {
    const src = path.join(oldDir, file);
    const dst = path.join(newDir, file);

    if (fs.existsSync(dst)) {
      // Both dirs have this cortex DB — index/ (v3) is canonical.
      // Back up the engrams/ copy outside the tree so the user can recover it.
      const backupDir = path.join(path.dirname(oldDir), `engrams-backup-${ts}`);
      fs.mkdirSync(backupDir, { recursive: true });
      fs.renameSync(src, path.join(backupDir, file));
    } else {
      fs.renameSync(src, dst);
      movedCount += 1;
    }
  }

  fs.rmSync(oldDir, { recursive: true, force: true });

  process.stderr.write(
    `think: consolidated ${movedCount} database(s) from ${oldDir} into ${newDir}; removed ${oldDir}\n`,
  );
}

/**
 * One-time migration: rename ~/.think/engrams/ → ~/.think/index/ if needed.
 * Safe to call multiple times — guarded by a module-level flag so the
 * filesystem check only happens once per process.
 *
 * Three cases:
 *   1. Only engrams/ exists  → auto-rename to index/, log one line.
 *   2. Only index/ (or neither) → no-op.
 *   3. Both exist:
 *      - Interactive (stdin is a TTY): prompt once; on confirm, consolidate.
 *      - Non-interactive: silent skip — the next interactive think invocation
 *        will handle it.  No warning printed per invocation.
 */
export function maybeMigrateEngramsToIndex(): void {
  if (_migrationChecked) return;
  _migrationChecked = true;

  const oldDir = path.join(getThinkDir(), 'engrams');
  const newDir = getIndexDir();
  const oldExists = fs.existsSync(oldDir);
  const newExists = fs.existsSync(newDir);

  if (oldExists && !newExists) {
    // Simple rename — no user interaction needed.
    fs.renameSync(oldDir, newDir);
    process.stderr.write(`think: migrated ${oldDir} to ${newDir}\n`);
    return;
  }

  if (!oldExists) {
    // Nothing to migrate.
    return;
  }

  // Both directories exist.  Consolidation is irreversible; only do it
  // interactively so the user can Ctrl-C and back up first.
  if (!process.stdin.isTTY) {
    // Non-interactive (hooks, MCP, scripts) — skip silently.
    // The next interactive `think` call will handle it.
    return;
  }

  // Interactive path — print a clear prompt and block on stdin.
  process.stderr.write('\n');
  process.stderr.write(`think: two database directories detected\n`);
  process.stderr.write(`  engrams/  ${oldDir}\n`);
  process.stderr.write(`  index/    ${newDir}\n`);
  process.stderr.write('\n');
  process.stderr.write(`think will consolidate all .db files from engrams/ into index/ and then\n`);
  process.stderr.write(`delete engrams/.  index/ is the canonical v3 location.\n`);
  process.stderr.write('\n');
  process.stderr.write(`note: .db files that already exist in index/ will NOT be overwritten —\n`);
  process.stderr.write(`      the index/ copy is canonical; the engrams/ copy will be backed up\n`);
  process.stderr.write(`      to a timestamped directory next to engrams/ so you can recover it.\n`);
  process.stderr.write('\n');
  process.stderr.write(`WARNING: this operation is IRREVERSIBLE (except via the backup).\n`);
  process.stderr.write(`         Press Ctrl-C NOW if you want to back up ${oldDir} first.\n`);
  process.stderr.write('\n');
  process.stderr.write(`Press Enter to consolidate, or Ctrl-C to cancel: `);

  // Synchronous stdin read — blocks until the user presses Enter (or Ctrl-C).
  // We do NOT make ensureThinkDirs async because that would ripple through
  // dozens of call sites; sync stdin read is the right pattern here.
  const buf = Buffer.alloc(64);
  try {
    fs.readSync(0, buf, 0, buf.length, null);
  } catch {
    // readSync on stdin can throw on some platforms when stdin is already
    // closed or signaled; treat as cancellation.
    process.stderr.write('\nthink: consolidation cancelled.\n');
    return;
  }

  consolidateEngramsToIndex(oldDir, newDir);
}

export function ensureThinkDirs(): void {
  maybeMigrateEngramsToIndex();
  fs.mkdirSync(getIndexDir(), { recursive: true });
  fs.mkdirSync(getLongtermDir(), { recursive: true });
}

/**
 * Path to the daemon Unix socket (macOS/Linux).
 * On Windows the daemon binds TCP instead; callers that need to branch on
 * platform should check `process.platform === 'win32'` separately.
 */
export function getDaemonSocketPath(): string {
  return path.join(getThinkDir(), 'daemon.sock');
}
