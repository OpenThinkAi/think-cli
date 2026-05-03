import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  decrypt,
  encrypt,
  VAULT_KEY_BYTES,
  VAULT_NONCE_BYTES,
} from '../../../src/serve/vault/cipher.js';

describe('vault/cipher (AGT-029)', () => {
  it('round-trips an arbitrary string through encrypt → decrypt', () => {
    const key = randomBytes(VAULT_KEY_BYTES);
    const plaintext = 'ghp_aBcDeFg12345-secret';
    const { ciphertext, nonce } = encrypt(plaintext, key);
    expect(nonce).toHaveLength(VAULT_NONCE_BYTES);
    expect(decrypt(ciphertext, nonce, key)).toBe(plaintext);
  });

  it('round-trips unicode and longer payloads', () => {
    const key = randomBytes(VAULT_KEY_BYTES);
    const plaintext = '🔐 secret with unicode\n' + 'x'.repeat(2048);
    const { ciphertext, nonce } = encrypt(plaintext, key);
    expect(decrypt(ciphertext, nonce, key)).toBe(plaintext);
  });

  it('detects tampering: a single-bit flip in the ciphertext throws on decrypt', () => {
    const key = randomBytes(VAULT_KEY_BYTES);
    const { ciphertext, nonce } = encrypt('hello', key);
    const tampered = Buffer.from(ciphertext);
    tampered[0] ^= 0x01;
    expect(() => decrypt(tampered, nonce, key)).toThrow();
  });

  it('detects tampering: mutating the appended auth tag throws on decrypt', () => {
    const key = randomBytes(VAULT_KEY_BYTES);
    const { ciphertext, nonce } = encrypt('hello', key);
    const tampered = Buffer.from(ciphertext);
    // Last byte is part of the auth tag.
    tampered[tampered.length - 1] ^= 0x01;
    expect(() => decrypt(tampered, nonce, key)).toThrow();
  });

  it('decryption with the wrong key throws', () => {
    const k1 = randomBytes(VAULT_KEY_BYTES);
    const k2 = randomBytes(VAULT_KEY_BYTES);
    const { ciphertext, nonce } = encrypt('hello', k1);
    expect(() => decrypt(ciphertext, nonce, k2)).toThrow();
  });

  it('rejects keys of the wrong length', () => {
    expect(() => encrypt('x', randomBytes(16))).toThrow(/32 bytes/);
    expect(() => encrypt('x', randomBytes(64))).toThrow(/32 bytes/);
    const key = randomBytes(VAULT_KEY_BYTES);
    const { ciphertext, nonce } = encrypt('x', key);
    expect(() => decrypt(ciphertext, nonce, randomBytes(16))).toThrow(/32 bytes/);
  });

  it('produces a unique nonce for every encrypt call', () => {
    const key = randomBytes(VAULT_KEY_BYTES);
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const { nonce } = encrypt('same plaintext', key);
      seen.add(nonce.toString('hex'));
    }
    expect(seen.size).toBe(1000);
  });

  it('rejects ciphertexts shorter than the auth tag', () => {
    const key = randomBytes(VAULT_KEY_BYTES);
    const nonce = randomBytes(VAULT_NONCE_BYTES);
    expect(() => decrypt(Buffer.from('abc'), nonce, key)).toThrow(/auth tag/);
  });
});
