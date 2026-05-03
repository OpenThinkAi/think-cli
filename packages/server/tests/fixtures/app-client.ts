import { createApp } from '../../src/app.js';
import { buildDefaultRegistry } from '../../src/connectors/registry.js';
import { openDb, type Database } from '../../src/db.js';
import { createScheduler, type SchedulerHandle, type TickReport } from '../../src/scheduler/index.js';
import type { ConnectorRegistry } from '../../src/connectors/registry.js';

// Module-level env mutation is intentional: every test file in this package
// imports this fixture, and they all need the bearer middleware to accept
// the same token. The middleware reads THINK_TOKEN once at construction, so
// setting it at import time guarantees a single value is in scope before any
// `createTestClient()` call instantiates a middleware-bound app.
const TOKEN = 'test-token-' + Math.random().toString(36).slice(2);
process.env.THINK_TOKEN = TOKEN;

interface RequestOptions {
  method?: string;
  path: string;
  body?: unknown;
  token?: string | null;
}

export interface TestClient {
  db: Database;
  request: <T = unknown>(opts: RequestOptions) => Promise<{ status: number; body: T }>;
  registry: ConnectorRegistry;
  scheduler: SchedulerHandle;
  tickOnce: () => Promise<TickReport>;
}

/**
 * Builds a fresh app + `:memory:` DB per call so each test owns its own
 * state. Bearer token is auto-attached unless `token: null` is passed.
 *
 * The scheduler is wired but not started — tests drive it via `tickOnce()`
 * for determinism. Pass `registry` to override the default `mock`-only
 * map (e.g. to inject a connector that throws, for failure-isolation
 * tests).
 */
export function createTestClient(opts: { db?: Database; registry?: ConnectorRegistry } = {}): TestClient {
  const db = opts.db ?? openDb(':memory:');
  const app = createApp({ db });
  const registry = opts.registry ?? buildDefaultRegistry();
  const scheduler = createScheduler({ db, registry, intervalMs: 60_000 });

  async function request<T = unknown>(reqOpts: RequestOptions): Promise<{
    status: number;
    body: T;
  }> {
    const headers: Record<string, string> = {};
    const token = reqOpts.token === undefined ? TOKEN : reqOpts.token;
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

  return {
    db,
    request,
    registry,
    scheduler,
    tickOnce: () => scheduler.tickOnce(),
  };
}
