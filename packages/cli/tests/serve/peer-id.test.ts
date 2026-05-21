import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  generateProxyPeerId,
  getProxyPeerId,
  readProxyPeerId,
  writeProxyPeerId,
} from '../../src/serve/peer-id.js';
import { ensureSchema } from '../../src/serve/db/schema.js';

/**
 * AGT-385 — proxy peer-id config + initialization.
 *
 * Covers:
 *  1. First-boot auto-generates and persists.
 *  2. Second-boot reads the persisted value (idempotency).
 *  3. `--peer-id` flag override wins and is persisted (so subsequent
 *     restarts without the flag still pick up the same id).
 *  4. Generator naming convention: hostname segment present when usable,
 *     omitted when not, sanitized of unsafe characters.
 *  5. Write rejects empty/whitespace values.
 */

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  ensureSchema(db);
  return db;
}

describe('generateProxyPeerId — naming convention', () => {
  it('includes a sanitized hostname segment when one is available', () => {
    const id = generateProxyPeerId({ hostname: 'matt-laptop.local' });
    // proxy-<hostname-short>-<8 hex>
    expect(id).toMatch(/^proxy-matt-laptop-[0-9a-f]{8}$/);
  });

  it('lower-cases the hostname segment', () => {
    const id = generateProxyPeerId({ hostname: 'MATT-LAPTOP' });
    expect(id).toMatch(/^proxy-matt-laptop-[0-9a-f]{8}$/);
  });

  it('strips the first dot onward (FQDN → short)', () => {
    const id = generateProxyPeerId({ hostname: 'anglepoint-foo.local.example' });
    expect(id).toMatch(/^proxy-anglepoint-foo-[0-9a-f]{8}$/);
  });

  it('replaces unsafe chars with `-` and trims leading/trailing hyphens', () => {
    const id = generateProxyPeerId({ hostname: '__weird host!!' });
    // Underscores → `-`, double-space → single `-`, exclamation → `-`,
    // leading/trailing `-` trimmed.
    expect(id).toMatch(/^proxy-weird-host-[0-9a-f]{8}$/);
  });

  it('caps hostname segment length so the full id stays manageable', () => {
    const longHost = 'a'.repeat(64);
    const id = generateProxyPeerId({ hostname: longHost });
    // proxy- (6) + 32 (cap) + - (1) + 8 = 47
    expect(id.length).toBeLessThanOrEqual(48);
    expect(id).toMatch(/^proxy-a{32}-[0-9a-f]{8}$/);
  });

  it('falls back to `proxy-<uuid>` when hostname yields an empty segment', () => {
    const id = generateProxyPeerId({ hostname: '!!!' });
    expect(id).toMatch(/^proxy-[0-9a-f]{8}$/);
  });

  it('produces fresh suffixes across calls', () => {
    const a = generateProxyPeerId({ hostname: 'host' });
    const b = generateProxyPeerId({ hostname: 'host' });
    expect(a).not.toBe(b);
  });
});

describe('getProxyPeerId — first boot vs subsequent boot', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = makeDb();
  });

  it('first boot: generates a peer-id and persists it to proxy_kv', () => {
    expect(readProxyPeerId(db)).toBeNull();

    const id = getProxyPeerId(db, { hostname: 'host-1' });
    expect(id).toMatch(/^proxy-host-1-[0-9a-f]{8}$/);

    // Persisted.
    expect(readProxyPeerId(db)).toBe(id);
    const row = db
      .prepare("SELECT key, value, updated_at FROM proxy_kv WHERE key = 'peer_id'")
      .get() as { key: string; value: string; updated_at: string };
    expect(row.key).toBe('peer_id');
    expect(row.value).toBe(id);
    expect(row.updated_at).toMatch(/T.*Z$/); // ISO-8601
  });

  it('second boot: reads the persisted value, does not regenerate', () => {
    const first = getProxyPeerId(db, { hostname: 'host-1' });
    const second = getProxyPeerId(db, { hostname: 'host-2' /* would normally change the id */ });
    expect(second).toBe(first);
    // And there is still only one row.
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM proxy_kv').get() as { n: number };
    expect(n).toBe(1);
  });

  it('--peer-id override wins and is persisted', () => {
    // Pretend a prior boot wrote a generated id.
    getProxyPeerId(db, { hostname: 'host-1' });

    const overridden = getProxyPeerId(db, { override: 'proxy-anglepoint' });
    expect(overridden).toBe('proxy-anglepoint');
    expect(readProxyPeerId(db)).toBe('proxy-anglepoint');

    // Subsequent boot without the flag reuses the persisted override.
    const noFlag = getProxyPeerId(db);
    expect(noFlag).toBe('proxy-anglepoint');
  });

  it('--peer-id override on a fresh DB also persists', () => {
    const id = getProxyPeerId(db, { override: 'proxy-fresh' });
    expect(id).toBe('proxy-fresh');
    expect(readProxyPeerId(db)).toBe('proxy-fresh');
  });

  it('whitespace-only override is treated as "no override" (falls through)', () => {
    // Boot resolver must not write a blank value to sqlite. Resolution
    // falls through to the persist/generate branch.
    const id = getProxyPeerId(db, { override: '   ', hostname: 'host' });
    expect(id).toMatch(/^proxy-host-[0-9a-f]{8}$/);
  });

  it('override is trimmed before persist', () => {
    const id = getProxyPeerId(db, { override: '  proxy-padded  ' });
    expect(id).toBe('proxy-padded');
    expect(readProxyPeerId(db)).toBe('proxy-padded');
  });
});

describe('writeProxyPeerId — input validation', () => {
  it('rejects an empty string', () => {
    const db = makeDb();
    expect(() => writeProxyPeerId(db, '')).toThrow(/non-empty/);
  });

  it('rejects a whitespace-only string', () => {
    const db = makeDb();
    expect(() => writeProxyPeerId(db, '   \t\n')).toThrow(/non-empty/);
  });
});
