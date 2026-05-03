import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConfig, getPeerId, getConfigDir } from '../../src/lib/config.js';

describe('getPeerId', () => {
  let originalHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-config-test-'));
    process.env.THINK_HOME = tmpHome;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('returns a stable UUID across calls', () => {
    const first = getPeerId();
    const second = getPeerId();
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).toBe(first);
  });

  it('self-heals legacy configs missing peerId', () => {
    const configDir = getConfigDir();
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const configPath = join(configDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ syncPort: 47821 }) + '\n', { encoding: 'utf-8', mode: 0o600 });

    const peerId = getPeerId();
    expect(peerId).toMatch(/^[0-9a-f-]{36}$/);

    // Persisted back to disk so subsequent processes see the same id.
    expect(existsSync(configPath)).toBe(true);
    const persisted = JSON.parse(readFileSync(configPath, 'utf-8')) as { peerId?: string; syncPort?: number };
    expect(persisted.peerId).toBe(peerId);
    expect(persisted.syncPort).toBe(47821);
  });

  it('matches Config.peerId when one is already set', () => {
    const config = getConfig();
    expect(getPeerId()).toBe(config.peerId);
  });
});

describe('getConfig — legacy cortex.server pruning', () => {
  let originalHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-config-prune-test-'));
    process.env.THINK_HOME = tmpHome;
    // Re-import the config module to reset its legacyServerWarned guard so
    // each test sees a fresh "first call" state and the stderr warning
    // assertion is deterministic.
    vi.resetModules();
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('drops legacy cortex.server from returned config and persisted file, warning once', async () => {
    const { getConfig: freshGetConfig, saveConfig: freshSaveConfig } =
      await import('../../src/lib/config.js');

    const configDir = getConfigDir();
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const configPath = join(configDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      peerId: 'fixed-peer-id-for-prune-test',
      syncPort: 47821,
      cortex: {
        author: 'legacy',
        server: { url: 'https://legacy.example/', token: 'stale-token' },
        repo: 'git@github.com:org/repo.git',
      },
    }) + '\n', { encoding: 'utf-8', mode: 0o600 });

    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const first = freshGetConfig();
    // Prune happened in-memory.
    expect((first.cortex as Record<string, unknown> | undefined)?.server).toBeUndefined();
    // Other cortex fields preserved.
    expect(first.cortex?.author).toBe('legacy');
    expect(first.cortex?.repo).toBe('git@github.com:org/repo.git');
    // Warning fired exactly once and pointed users at --fs.
    expect(stderr).toHaveBeenCalledTimes(1);
    const banner = String(stderr.mock.calls[0][0]);
    expect(banner).toMatch(/cortex\.server/);
    expect(banner).toMatch(/--fs/);
    // Past-tense: by the time the user reads the banner the file is
    // already rewritten. "dropped" not "dropping" so users don't think
    // they can cancel mid-process to keep the field.
    expect(banner).toMatch(/dropped/);
    // URL is echoed so the user has a written trace of what was lost;
    // token is never echoed (it lands in stderr/cron logs).
    expect(banner).toContain('https://legacy.example/');
    expect(banner).not.toContain('stale-token');

    // Persisted file no longer carries the dead field.
    const persisted = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      cortex?: { server?: unknown; repo?: string };
    };
    expect(persisted.cortex?.server).toBeUndefined();
    expect(persisted.cortex?.repo).toBe('git@github.com:org/repo.git');

    // Pre-prune backup written so a user who misses the one-shot stderr
    // banner has a recovery path. Same dir, mode 0o600, contains the
    // original on-disk content (server URL + token both preserved).
    const backupPath = `${configPath}.pre-v2-prune`;
    expect(existsSync(backupPath)).toBe(true);
    const backup = JSON.parse(readFileSync(backupPath, 'utf-8')) as {
      cortex?: { server?: { url?: string; token?: string } };
    };
    expect(backup.cortex?.server?.url).toBe('https://legacy.example/');
    expect(backup.cortex?.server?.token).toBe('stale-token');
    const backupMode = statSync(backupPath).mode & 0o777;
    expect(backupMode).toBe(0o600);
    // Banner names the backup path so the user knows where to look.
    expect(banner).toContain(backupPath);

    // Subsequent reads in the same process don't re-warn (file is clean
    // AND the module-local guard is set).
    const second = freshGetConfig();
    expect((second.cortex as Record<string, unknown> | undefined)?.server).toBeUndefined();
    expect(stderr).toHaveBeenCalledTimes(1);

    // saveConfig still works the way callers expect.
    freshSaveConfig({ ...second, paused: true });
    const after = JSON.parse(readFileSync(configPath, 'utf-8')) as { paused?: boolean };
    expect(after.paused).toBe(true);

    stderr.mockRestore();
  });

  it('warns loudly when the backup write fails (banner reflects the failure)', async () => {
    const { getConfig: freshGetConfig } = await import('../../src/lib/config.js');
    const fs = await import('node:fs');

    const configDir = getConfigDir();
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const configPath = join(configDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      peerId: 'fixed-peer-id-for-prune-fail-test',
      syncPort: 47821,
      cortex: {
        server: { url: 'https://legacy.example/', token: 'stale-token' },
      },
    }) + '\n', { encoding: 'utf-8', mode: 0o600 });

    // Force the backup write to fail without mocking ESM modules (vitest can't
    // spy on writeFileSync directly). Pre-creating .pre-v2-prune as a DIRECTORY
    // makes writeFileSync('<path>.pre-v2-prune', ...) throw EISDIR, while the
    // separate saveConfig() write to config.json succeeds.
    mkdirSync(`${configPath}.pre-v2-prune`, { recursive: true });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    freshGetConfig();
    const banner = String(stderr.mock.calls[0][0]);

    // Banner must NOT claim a backup was written.
    expect(banner).not.toMatch(/backup .* was written/);
    // Banner must surface the failure clearly so the user knows the URL echo
    // is their only record.
    expect(banner).toMatch(/WARNING/);
    expect(banner).toMatch(/failed to write a backup/);
    expect(banner).toContain(`${configPath}.pre-v2-prune`);
    // Token still never leaks even on the failure path.
    expect(banner).not.toContain('stale-token');

    // The destructive prune still happened — backup failure isn't a hard
    // stop, but the banner is honest about what happened.
    const persisted = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      cortex?: { server?: unknown };
    };
    expect(persisted.cortex?.server).toBeUndefined();

    stderr.mockRestore();
  });

  it('leaves a config without cortex.server untouched (no warning, no rewrite)', async () => {
    const { getConfig: freshGetConfig } = await import('../../src/lib/config.js');

    const configDir = getConfigDir();
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const configPath = join(configDir, 'config.json');
    const original = JSON.stringify({
      peerId: 'untouched-peer-id',
      syncPort: 47821,
      cortex: { author: 'fresh', fs: { path: '/tmp/cortex-root' } },
    }) + '\n';
    writeFileSync(configPath, original, { encoding: 'utf-8', mode: 0o600 });

    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const config = freshGetConfig();
    expect(config.cortex?.fs?.path).toBe('/tmp/cortex-root');
    expect(stderr).not.toHaveBeenCalled();

    // File on disk is byte-for-byte identical (no defensive rewrite).
    expect(readFileSync(configPath, 'utf-8')).toBe(original);
    stderr.mockRestore();
  });
});
