import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { VAULT_KEY_BYTES } from './cipher.js';

/**
 * Vault key sourcing per AGT-029 AC #5:
 *
 *   - Production (`THINK_VAULT_KEY` set): base64-decode the env var; must
 *     be exactly 32 bytes after decoding. Anything else throws with the
 *     env-var name in the message so an operator can correct.
 *   - Dev (env unset): generate a fresh 32-byte key on first boot and
 *     persist to `~/.openthink/vault.key` with mode 0600. Subsequent boots
 *     read the same file, so a dev DB stays decryptable across restarts.
 *
 * The production-vs-dev gate (AC #6) lives in `runBootGuards` in
 * `index.ts` — this module is the storage shape, not the policy. Calling
 * `loadVaultKey()` with the env var unset always falls through to the
 * dev path; the operator-protection is "refuse to start in production
 * without the env var", which the boot guard owns.
 */

export const VAULT_KEY_ENV = 'THINK_VAULT_KEY';
export const DEV_VAULT_KEY_DIR = join(homedir(), '.openthink');
export const DEV_VAULT_KEY_PATH = join(DEV_VAULT_KEY_DIR, 'vault.key');

export interface LoadVaultKeyOptions {
  env?: NodeJS.ProcessEnv;
  devKeyPath?: string;
}

function decodeEnvKey(raw: string): Buffer {
  // Be lenient about accidental whitespace in env values (Railway and a
  // few other hosts tolerate trailing newlines on copy-paste).
  const trimmed = raw.trim();
  // `Buffer.from(str, 'base64')` doesn't throw on invalid input — it
  // silently returns a buffer of whatever bytes it could decode. Round-
  // trip to detect garbage rather than accepting a truncated "key".
  const decoded = Buffer.from(trimmed, 'base64');
  if (decoded.toString('base64').replace(/=+$/, '') !== trimmed.replace(/=+$/, '')) {
    throw new Error(
      `${VAULT_KEY_ENV} must be valid base64 (44 chars including padding for a 32-byte key)`,
    );
  }
  if (decoded.length !== VAULT_KEY_BYTES) {
    throw new Error(
      `${VAULT_KEY_ENV} must decode to ${VAULT_KEY_BYTES} bytes, got ${decoded.length}`,
    );
  }
  return decoded;
}

function readOrCreateDevKey(devKeyPath: string): Buffer {
  try {
    const buf = readFileSync(devKeyPath);
    if (buf.length !== VAULT_KEY_BYTES) {
      throw new Error(
        `dev vault key at ${devKeyPath} is ${buf.length} bytes; expected ${VAULT_KEY_BYTES}. ` +
          `Delete the file to regenerate.`,
      );
    }
    return buf;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
  // First-boot generation. Use `openSync(..., 'wx', 0o600)` to atomically
  // create with the right mode and fail if a racing process beat us to
  // it; in that case, re-read.
  mkdirSync(dirname(devKeyPath), { recursive: true, mode: 0o700 });
  const key = randomBytes(VAULT_KEY_BYTES);
  try {
    const fd = openSync(devKeyPath, 'wx', 0o600);
    try {
      writeSync(fd, key);
    } finally {
      closeSync(fd);
    }
    return key;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw err;
    }
    return readFileSync(devKeyPath);
  }
}

export function loadVaultKey(opts: LoadVaultKeyOptions = {}): Buffer {
  const env = opts.env ?? process.env;
  const devKeyPath = opts.devKeyPath ?? DEV_VAULT_KEY_PATH;
  const raw = env[VAULT_KEY_ENV];
  if (raw !== undefined && raw !== '') {
    return decodeEnvKey(raw);
  }
  return readOrCreateDevKey(devKeyPath);
}
