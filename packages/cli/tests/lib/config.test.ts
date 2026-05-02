import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
