import type { Database } from '../db.js';
import { decrypt, encrypt } from './cipher.js';

/**
 * The vault is a thin façade over `cipher.ts` + the `source_credentials`
 * table. Route handlers and the scheduler call `store/load/has` and never
 * touch `node:crypto` themselves.
 *
 * `load()` returns `null` when no row exists (preserves the existing
 * connector contract that `credential` is `string | null`). It throws if
 * the row is present but decryption fails — that means the key was
 * rotated without re-encryption, or the row is corrupted, and the
 * operator needs to know rather than silently get `null`.
 */
export interface Vault {
  store(db: Database, subscriptionId: string, plaintext: string, now?: () => string): void;
  load(db: Database, subscriptionId: string): string | null;
  has(db: Database, subscriptionId: string): boolean;
}

interface CredentialRow {
  ciphertext: Buffer | Uint8Array;
  nonce: Buffer | Uint8Array;
}

function asBuffer(b: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(b) ? b : Buffer.from(b);
}

export function createVault(key: Buffer): Vault {
  // Defensive copy — caller can't mutate the key out from under us
  // through a shared reference (e.g. zeroing the env-var buffer).
  const keyCopy = Buffer.from(key);

  return {
    store(db, subscriptionId, plaintext, now = () => new Date().toISOString()): void {
      const { ciphertext, nonce } = encrypt(plaintext, keyCopy);
      // Upsert: PUT replaces any existing credential for the subscription
      // without leaking whether one was already there (no separate
      // create-vs-update path in the route).
      db.prepare(
        `INSERT INTO source_credentials (subscription_id, ciphertext, nonce, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(subscription_id) DO UPDATE SET
           ciphertext = excluded.ciphertext,
           nonce = excluded.nonce,
           created_at = excluded.created_at`,
      ).run(subscriptionId, ciphertext, nonce, now());
    },
    load(db, subscriptionId): string | null {
      const row = db
        .prepare(
          'SELECT ciphertext, nonce FROM source_credentials WHERE subscription_id = ?',
        )
        .get(subscriptionId) as CredentialRow | undefined;
      if (!row) return null;
      return decrypt(asBuffer(row.ciphertext), asBuffer(row.nonce), keyCopy);
    },
    has(db, subscriptionId): boolean {
      const row = db
        .prepare('SELECT 1 FROM source_credentials WHERE subscription_id = ?')
        .get(subscriptionId);
      return row !== undefined;
    },
  };
}
