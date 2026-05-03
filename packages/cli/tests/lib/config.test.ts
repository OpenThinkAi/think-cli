import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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
