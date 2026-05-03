import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';

/**
 * AES-256-GCM with a 12-byte nonce and the standard 16-byte auth tag.
 * The auth tag is appended to the ciphertext so the on-disk shape stays
 * `(ciphertext BLOB, nonce BLOB)` — one column per axis of randomness,
 * not a third "auth_tag" column the schema would have to know about.
 *
 * Both functions throw on any failure (including tag-verification
 * failure on `decrypt`). Tampered ciphertext, wrong key, or a corrupted
 * row all surface the same way: a thrown Error from `node:crypto`.
 */
export const VAULT_KEY_BYTES = 32;
export const VAULT_NONCE_BYTES = 12;
export const VAULT_AUTH_TAG_BYTES = 16;

export interface CipherOutput {
  ciphertext: Buffer;
  nonce: Buffer;
}

export function encrypt(plaintext: string, key: Buffer): CipherOutput {
  if (key.length !== VAULT_KEY_BYTES) {
    throw new Error(`vault key must be ${VAULT_KEY_BYTES} bytes, got ${key.length}`);
  }
  const nonce = randomBytes(VAULT_NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: Buffer.concat([enc, tag]), nonce };
}

export function decrypt(ciphertext: Buffer, nonce: Buffer, key: Buffer): string {
  if (key.length !== VAULT_KEY_BYTES) {
    throw new Error(`vault key must be ${VAULT_KEY_BYTES} bytes, got ${key.length}`);
  }
  if (nonce.length !== VAULT_NONCE_BYTES) {
    throw new Error(`vault nonce must be ${VAULT_NONCE_BYTES} bytes, got ${nonce.length}`);
  }
  if (ciphertext.length < VAULT_AUTH_TAG_BYTES) {
    throw new Error('vault ciphertext is too short to contain an auth tag');
  }
  const tagOffset = ciphertext.length - VAULT_AUTH_TAG_BYTES;
  const enc = ciphertext.subarray(0, tagOffset);
  const tag = ciphertext.subarray(tagOffset);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString('utf8');
}
