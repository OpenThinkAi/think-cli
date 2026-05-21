import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openDb } from '../../src/serve/db.js';
import { createVault } from '../../src/serve/vault/index.js';
import {
  addSubscription,
  removeSubscription,
  listSubscriptionsByKind,
  setSubscriptionCredential,
} from '../../src/serve/admin.js';

/**
 * Unit tests for the admin helpers used by `think serve subscribe` /
 * `unsubscribe` / `creds add` / `status` (AGT-388).
 *
 * These exercise the sqlite-level shape directly. The CLI integration
 * (commander wiring, stdin reading, exit codes) is covered in
 * `serve-admin.test.ts`.
 */

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'admin-test-'));
  dbPath = join(tmpDir, 'proxy.sqlite');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('addSubscription', () => {
  it('creates a new subscription with a uuid', () => {
    const db = openDb(dbPath);
    const result = addSubscription(db, 'github', 'octo/widget');
    expect(result.created).toBe(true);
    expect(result.subscription.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.subscription.kind).toBe('github');
    expect(result.subscription.pattern).toBe('octo/widget');
    expect(result.subscription.last_polled_at).toBeNull();
    db.close();
  });

  it('is idempotent: a second add for the same (kind, pattern) returns the existing row', () => {
    const db = openDb(dbPath);
    const first = addSubscription(db, 'github', 'octo/widget');
    const second = addSubscription(db, 'github', 'octo/widget');
    expect(second.created).toBe(false);
    expect(second.subscription.id).toBe(first.subscription.id);
    // Confirm no duplicate row landed.
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE kind = ? AND pattern = ?')
      .get('github', 'octo/widget') as { n: number };
    expect(count.n).toBe(1);
    db.close();
  });

  it('allows two subs with the same kind but different patterns', () => {
    const db = openDb(dbPath);
    addSubscription(db, 'github', 'octo/widget');
    addSubscription(db, 'github', 'octo/sprocket');
    const rows = db
      .prepare('SELECT pattern FROM subscriptions WHERE kind = ?')
      .all('github') as { pattern: string }[];
    expect(rows.map((r) => r.pattern).sort()).toEqual(['octo/sprocket', 'octo/widget']);
    db.close();
  });
});

describe('removeSubscription', () => {
  it('deletes the matching row and returns it', () => {
    const db = openDb(dbPath);
    const { subscription } = addSubscription(db, 'github', 'octo/widget');
    const removed = removeSubscription(db, 'github', 'octo/widget');
    expect(removed?.id).toBe(subscription.id);
    const row = db
      .prepare('SELECT id FROM subscriptions WHERE id = ?')
      .get(subscription.id);
    expect(row).toBeUndefined();
    db.close();
  });

  it('returns null when no match', () => {
    const db = openDb(dbPath);
    expect(removeSubscription(db, 'github', 'no-such/repo')).toBeNull();
    db.close();
  });

  it('cascades: stored credentials and events go with the subscription', () => {
    const db = openDb(dbPath);
    const vault = createVault(randomBytes(32));
    const { subscription } = addSubscription(db, 'github', 'octo/widget');
    vault.store(db, subscription.id, 'ghp_test_pat');
    db.prepare(
      'INSERT INTO events (id, subscription_id, payload_json, episode_key, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(
      'evt-1',
      subscription.id,
      '{}',
      'github:octo/widget#1',
      new Date().toISOString(),
    );
    expect(vault.has(db, subscription.id)).toBe(true);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM events WHERE subscription_id = ?').get(subscription.id),
    ).toEqual({ n: 1 });

    removeSubscription(db, 'github', 'octo/widget');

    expect(vault.has(db, subscription.id)).toBe(false);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM events WHERE subscription_id = ?').get(subscription.id),
    ).toEqual({ n: 0 });
    db.close();
  });
});

describe('listSubscriptionsByKind', () => {
  it('groups subscriptions by kind, ordered within group by created_at', () => {
    const db = openDb(dbPath);
    // Insert with explicit timestamps so we can assert ordering deterministically.
    let n = 0;
    const fixedNow = () => `2026-05-${String(20 + ++n).padStart(2, '0')}T00:00:00Z`;
    addSubscription(db, 'github', 'octo/a', { now: fixedNow });
    addSubscription(db, 'linear', 'TEAM-1', { now: fixedNow });
    addSubscription(db, 'github', 'octo/b', { now: fixedNow });
    addSubscription(db, 'github', 'octo/c', { now: fixedNow });

    const grouped = listSubscriptionsByKind(db);
    expect(Object.keys(grouped).sort()).toEqual(['github', 'linear']);
    expect(grouped.github.map((r) => r.pattern)).toEqual(['octo/a', 'octo/b', 'octo/c']);
    expect(grouped.linear.map((r) => r.pattern)).toEqual(['TEAM-1']);
    db.close();
  });

  it('returns an empty object when no subscriptions exist', () => {
    const db = openDb(dbPath);
    expect(listSubscriptionsByKind(db)).toEqual({});
    db.close();
  });
});

describe('setSubscriptionCredential', () => {
  it('stores a credential against the matching subscription and roundtrips via the vault', () => {
    const db = openDb(dbPath);
    const vault = createVault(randomBytes(32));
    const { subscription } = addSubscription(db, 'github', 'octo/widget');
    const id = setSubscriptionCredential(db, vault, 'github', 'octo/widget', 'ghp_xyz');
    expect(id).toBe(subscription.id);
    expect(vault.load(db, subscription.id)).toBe('ghp_xyz');
    db.close();
  });

  it('replaces an existing credential on second call (upsert)', () => {
    const db = openDb(dbPath);
    const vault = createVault(randomBytes(32));
    addSubscription(db, 'github', 'octo/widget');
    setSubscriptionCredential(db, vault, 'github', 'octo/widget', 'ghp_first');
    const id = setSubscriptionCredential(db, vault, 'github', 'octo/widget', 'ghp_second');
    expect(vault.load(db, id)).toBe('ghp_second');
    // No duplicate rows.
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM source_credentials WHERE subscription_id = ?')
      .get(id) as { n: number };
    expect(count.n).toBe(1);
    db.close();
  });

  it('throws when no matching subscription exists', () => {
    const db = openDb(dbPath);
    const vault = createVault(randomBytes(32));
    expect(() => setSubscriptionCredential(db, vault, 'github', 'no/sub', 'x')).toThrow(
      /no subscription found/,
    );
    db.close();
  });

  it('rejects an empty plaintext', () => {
    const db = openDb(dbPath);
    const vault = createVault(randomBytes(32));
    addSubscription(db, 'github', 'octo/widget');
    expect(() => setSubscriptionCredential(db, vault, 'github', 'octo/widget', '')).toThrow(
      /non-empty/,
    );
    db.close();
  });
});
