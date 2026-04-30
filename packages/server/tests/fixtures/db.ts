import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { ensureSchema } from '../../src/db/schema.js';
import { closePool } from '../../src/db/pool.js';

/**
 * Provisions an isolated Postgres schema per test suite.
 *
 * Each call:
 *  - Creates a fresh schema named `test_<random>` on the configured
 *    DATABASE_URL.
 *  - Sets the connection's `search_path` to that schema so all queries
 *    land inside it.
 *  - Runs the production schema migration into it.
 *  - Returns a cleanup() that drops the schema and closes the pool.
 *
 * Tests sharing a process must serialize via vitest's `fileParallelism: false`
 * because we mutate `process.env.DATABASE_URL` and the singleton pool.
 */
export interface TestDb {
  schemaName: string;
  databaseUrl: string;
  cleanup: () => Promise<void>;
}

function requireBaseUrl(): string {
  const base = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!base) {
    throw new Error(
      'TEST_DATABASE_URL or DATABASE_URL must be set to a Postgres instance ' +
        '(use `docker compose up -d postgres` and export ' +
        'TEST_DATABASE_URL=postgres://think:think@localhost:5432/think).',
    );
  }
  return base;
}

export async function createTestDb(): Promise<TestDb> {
  const baseUrl = requireBaseUrl();
  const schemaName = `test_${randomBytes(6).toString('hex')}`;

  // Create schema with a one-off connection.
  const setup = new pg.Pool({ connectionString: baseUrl });
  try {
    await setup.query(`CREATE SCHEMA "${schemaName}"`);
  } finally {
    await setup.end();
  }

  // Encode schema-as-search_path into DATABASE_URL via the `options` query
  // param. pg passes it through to libpq, which honors `-c search_path=…`.
  const url = new URL(baseUrl);
  url.searchParams.set('options', `-csearch_path=${schemaName}`);
  const databaseUrl = url.toString();
  process.env.DATABASE_URL = databaseUrl;

  // Run production schema migration into the new schema.
  const migrationPool = new pg.Pool({ connectionString: databaseUrl });
  try {
    await ensureSchema(migrationPool);
  } finally {
    await migrationPool.end();
  }

  return {
    schemaName,
    databaseUrl,
    cleanup: async () => {
      // Close the app's singleton pool first so it doesn't hold connections.
      await closePool();
      const teardown = new pg.Pool({ connectionString: baseUrl });
      try {
        await teardown.query(`DROP SCHEMA "${schemaName}" CASCADE`);
      } finally {
        await teardown.end();
      }
      delete process.env.DATABASE_URL;
    },
  };
}
