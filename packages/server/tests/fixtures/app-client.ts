import { createApp } from '../../src/app.js';
import { openDb, type Database } from '../../src/db.js';

// Module-level env mutation is intentional: every test file in this package
// imports this fixture, and they all need the bearer middleware to accept
// the same token. Setting it at import time means a single THINK_TOKEN value
// is in scope by the time any test calls `app.fetch`. Per-test or per-file
// scoping would race with createTestClient() callers in `beforeEach`.
const DEFAULT_TOKEN = 'test-token-' + Math.random().toString(36).slice(2);
process.env.THINK_TOKEN = DEFAULT_TOKEN;

interface RequestOptions {
  method?: string;
  path: string;
  body?: unknown;
  token?: string | null;
}

export interface TestClient {
  db: Database;
  request: <T = unknown>(opts: RequestOptions) => Promise<{ status: number; body: T }>;
}

/**
 * Builds a fresh app + `:memory:` DB per call so each test file owns its
 * own state. Bearer token is auto-attached unless `token: null` is passed.
 *
 * Two layers exist intentionally: `createTestClient()` for per-test isolation
 * (events/subscriptions tests need a clean DB each `beforeEach`), and a
 * module-level singleton `request`/`TEST_TOKEN` for the existing
 * health/404/auth tests in `server.test.ts` that don't care about DB state.
 */
export function createTestClient(opts: { db?: Database } = {}): TestClient {
  const db = opts.db ?? openDb(':memory:');
  const app = createApp({ db });

  async function request<T = unknown>(reqOpts: RequestOptions): Promise<{
    status: number;
    body: T;
  }> {
    const headers: Record<string, string> = {};
    const token = reqOpts.token === undefined ? DEFAULT_TOKEN : reqOpts.token;
    if (token !== null) headers['Authorization'] = `Bearer ${token}`;
    if (reqOpts.body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await app.fetch(
      new Request(`http://test.local${reqOpts.path}`, {
        method: reqOpts.method ?? 'GET',
        headers,
        body: reqOpts.body !== undefined ? JSON.stringify(reqOpts.body) : undefined,
      }),
    );

    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, body: body as T };
  }

  return { db, request };
}

const defaultClient = createTestClient();
export const request = defaultClient.request;
export const TEST_TOKEN = DEFAULT_TOKEN;
