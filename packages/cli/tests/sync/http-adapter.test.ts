import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import pg from 'pg';
import { serve } from '@hono/node-server';
import { createApp } from '../../../server/src/app.js';
import { ensureSchema } from '../../../server/src/db/schema.js';
import { closePool, getPool } from '../../../server/src/db/pool.js';
import { runSyncAdapterContractTests, type AdapterFactory } from './contract.js';
import { HttpSyncAdapter } from '../../src/sync/http-adapter.js';
import { saveConfig, getConfig } from '../../src/lib/config.js';
import type { TestPeer } from '../fixtures/peer-pair.js';

interface HttpRemote {
  url: string;
  token: string;
  schemaName: string;
}

const TEST_TOKEN = 'test-token-' + randomBytes(8).toString('hex');
let baseDatabaseUrl: string;
let serverHandle: ReturnType<typeof serve> | null = null;
let serverUrl: string;

function requireBaseDb(): string {
  const u = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!u) {
    throw new Error(
      'TEST_DATABASE_URL must be set to a Postgres instance for HttpSyncAdapter tests ' +
        '(e.g. `docker compose up -d postgres` then ' +
        'TEST_DATABASE_URL=postgres://think:think@localhost:5434/think).',
    );
  }
  return u;
}

beforeAll(async () => {
  baseDatabaseUrl = requireBaseDb();
  process.env.THINK_TOKEN = TEST_TOKEN;
  // The server's createApp() reads THINK_TOKEN from env at request time;
  // DATABASE_URL is read by getPool() which is invoked by route handlers.
  // We rotate DATABASE_URL per test via setupRemote, so set a placeholder
  // pointing at the public schema for app construction.
  process.env.DATABASE_URL = baseDatabaseUrl;

  const app = createApp();
  const handle = serve({ fetch: app.fetch, port: 0 });
  serverHandle = handle;
  // @hono/node-server returns Node's http.Server; address() gives the port.
  // Using `any` here only because the public type is loose.
  const addr = (handle as { address: () => { port: number } | string | null }).address();
  if (!addr || typeof addr === 'string') {
    throw new Error('failed to bind test server');
  }
  serverUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  if (serverHandle) {
    await new Promise<void>((resolve, reject) => {
      (serverHandle as { close: (cb: (err?: Error) => void) => void }).close(err => {
        if (err) reject(err);
        else resolve();
      });
    });
    serverHandle = null;
  }
  // Close the server's pg pool so it doesn't leak connections across files.
  await closePool();
});

const factory: AdapterFactory<HttpRemote> = {
  label: 'http',

  async setupRemote(_cortexName: string): Promise<HttpRemote> {
    // Each test gets its own ephemeral schema. We have to flip the server's
    // active DATABASE_URL into this schema's search_path before the test runs.
    const schemaName = `test_${randomBytes(6).toString('hex')}`;

    const setup = new pg.Pool({ connectionString: baseDatabaseUrl });
    try {
      await setup.query(`CREATE SCHEMA "${schemaName}"`);
    } finally {
      await setup.end();
    }

    const url = new URL(baseDatabaseUrl);
    url.searchParams.set('options', `-csearch_path=${schemaName}`);
    process.env.DATABASE_URL = url.toString();

    // Server's pool is a singleton — close + recreate so it picks up the new
    // DATABASE_URL and the new search_path.
    await closePool();
    await ensureSchema(getPool());

    return { url: serverUrl, token: TEST_TOKEN, schemaName };
  },

  configurePeer(peer: TestPeer, _cortexName: string, remote: HttpRemote): void {
    peer.activate();
    const existing = getConfig();
    saveConfig({
      ...existing,
      cortex: {
        ...existing.cortex,
        author: `test-peer-${path.basename(peer.thinkHome)}`,
        server: { url: remote.url, token: remote.token },
        // Make sure no stale repo config makes the registry pick the git adapter.
        repo: undefined,
      },
    });
  },

  createAdapter() {
    return new HttpSyncAdapter();
  },

  async teardownRemote(remote: HttpRemote): Promise<void> {
    await closePool();
    const teardown = new pg.Pool({ connectionString: baseDatabaseUrl });
    try {
      await teardown.query(`DROP SCHEMA "${remote.schemaName}" CASCADE`);
    } finally {
      await teardown.end();
    }
  },
};

// Skip the http suite entirely if there's no Postgres available — the rest of
// the cli test suite doesn't depend on it.
const haveDb = !!(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL);
if (!haveDb) {
  describe.skip('SyncAdapter contract — http (skipped: TEST_DATABASE_URL not set)', () => {
    /* skipped */
  });
} else {
  runSyncAdapterContractTests(factory, { enforceImmutableMemories: true });

  describe('http long-term-event sync (BLOOM-139)', () => {
    let pair: ReturnType<typeof import('../fixtures/peer-pair.js').createPeerPair> | null = null;
    let remote: HttpRemote | null = null;

    afterAll(async () => {
      if (remote) await factory.teardownRemote(remote);
      pair?.cleanup();
    });

    it('round-trips LT events between two peers (incl. tombstone)', async () => {
      const { createPeerPair } = await import('../fixtures/peer-pair.js');
      const { insertLongTermEvent, tombstoneLongTermEvent, getLongTermEvents } =
        await import('../../src/db/long-term-queries.js');

      pair = createPeerPair();
      remote = await factory.setupRemote(pair.cortexName) as HttpRemote;
      pair.peerA.activate();
      await factory.configurePeer(pair.peerA, pair.cortexName, remote);
      pair.peerB.activate();
      await factory.configurePeer(pair.peerB, pair.cortexName, remote);
      const adapter = factory.createAdapter();

      // Peer A authors an LT event.
      pair.peerA.activate();
      const inserted = insertLongTermEvent(pair.cortexName, {
        ts: '2026-04-30T12:00:00Z',
        author: 'a',
        kind: 'decision',
        title: 'Adopt http',
        content: 'we will use the http backend',
        topics: ['arch'],
      });
      const eventId = inserted.row.id;

      // A pushes; B pulls.
      pair.peerA.activate();
      await adapter.sync(pair.cortexName);
      pair.peerB.activate();
      await adapter.sync(pair.cortexName);

      const onB = getLongTermEvents(pair.cortexName);
      expect(onB).toHaveLength(1);
      expect(onB[0].id).toBe(eventId);
      expect(onB[0].title).toBe('Adopt http');

      // A tombstones the event. Tombstone propagates to B.
      pair.peerA.activate();
      tombstoneLongTermEvent(pair.cortexName, eventId);

      pair.peerA.activate();
      await adapter.sync(pair.cortexName);
      pair.peerB.activate();
      await adapter.sync(pair.cortexName);

      // getLongTermEvents excludes deleted_at by default.
      const liveOnB = getLongTermEvents(pair.cortexName);
      expect(liveOnB).toHaveLength(0);
    });
  });
}

