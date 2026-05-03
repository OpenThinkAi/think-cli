import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  loadVaultKey,
  VAULT_KEY_ENV,
} from '../../src/vault/key.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'vault-key-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('vault/key — env-path (production)', () => {
  it('decodes a valid base64-encoded 32-byte key', () => {
    const key = randomBytes(32);
    const encoded = key.toString('base64');
    const loaded = loadVaultKey({
      env: { [VAULT_KEY_ENV]: encoded },
      devKeyPath: join(tmpDir, 'unused'),
    });
    expect(loaded.equals(key)).toBe(true);
  });

  it('tolerates surrounding whitespace in the env value', () => {
    const key = randomBytes(32);
    const encoded = `\n  ${key.toString('base64')}  \n`;
    const loaded = loadVaultKey({
      env: { [VAULT_KEY_ENV]: encoded },
      devKeyPath: join(tmpDir, 'unused'),
    });
    expect(loaded.equals(key)).toBe(true);
  });

  it('rejects a 16-byte (too-short) key', () => {
    const encoded = randomBytes(16).toString('base64');
    expect(() =>
      loadVaultKey({
        env: { [VAULT_KEY_ENV]: encoded },
        devKeyPath: join(tmpDir, 'unused'),
      }),
    ).toThrow(/32 bytes/);
  });

  it('rejects a 64-byte (too-long) key', () => {
    const encoded = randomBytes(64).toString('base64');
    expect(() =>
      loadVaultKey({
        env: { [VAULT_KEY_ENV]: encoded },
        devKeyPath: join(tmpDir, 'unused'),
      }),
    ).toThrow(/32 bytes/);
  });

  it('rejects non-base64 garbage', () => {
    expect(() =>
      loadVaultKey({
        env: { [VAULT_KEY_ENV]: '!!!not-base64!!!' },
        devKeyPath: join(tmpDir, 'unused'),
      }),
    ).toThrow(/base64/);
  });
});

describe('vault/key — dev-path (file-backed)', () => {
  it('generates a 32-byte key on first call and persists it with mode 0600', () => {
    const devKeyPath = join(tmpDir, 'sub', 'vault.key');
    expect(existsSync(devKeyPath)).toBe(false);

    const k1 = loadVaultKey({ env: {}, devKeyPath });
    expect(k1).toHaveLength(32);
    expect(existsSync(devKeyPath)).toBe(true);

    const stat = statSync(devKeyPath);
    // mode lower 9 bits should be 0o600 (rw-------).
    expect(stat.mode & 0o777).toBe(0o600);

    // On disk, the file content should equal the returned key.
    expect(readFileSync(devKeyPath).equals(k1)).toBe(true);
  });

  it('reads the same key back on the second call', () => {
    const devKeyPath = join(tmpDir, 'vault.key');
    const k1 = loadVaultKey({ env: {}, devKeyPath });
    const k2 = loadVaultKey({ env: {}, devKeyPath });
    expect(k1.equals(k2)).toBe(true);
  });

  it('treats an empty env value as unset (falls through to dev-path)', () => {
    const devKeyPath = join(tmpDir, 'vault.key');
    const k1 = loadVaultKey({
      env: { [VAULT_KEY_ENV]: '' },
      devKeyPath,
    });
    expect(k1).toHaveLength(32);
    expect(existsSync(devKeyPath)).toBe(true);
  });

  it('rejects a dev-path file with the wrong number of bytes', () => {
    const devKeyPath = join(tmpDir, 'vault.key');
    // Plant a corrupted key.
    writeFileSync(devKeyPath, randomBytes(16), { mode: 0o600 });
    expect(() => loadVaultKey({ env: {}, devKeyPath })).toThrow(/16 bytes.*32/);
  });
});
