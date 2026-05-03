import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { serve, type ServerType } from '@hono/node-server';
import { createApp } from '../../src/serve/app.js';
import { buildDefaultRegistry } from '../../src/serve/connectors/registry.js';
import { openDb, type Database } from '../../src/serve/db.js';
import { createVault, type Vault } from '../../src/serve/vault/index.js';
import { createScheduler, type SchedulerHandle } from '../../src/serve/scheduler/index.js';
import { saveConfig, getConfig } from '../../src/lib/config.js';
import { createTestCortex, type TestCortex } from '../fixtures/cortex.js';
import { subscribeCommand } from '../../src/commands/subscribe.js';
import { getCortexDb } from '../../src/db/engrams.js';

// In-process proxy fixture: spin a real Hono app on a free port with a
// :memory: SQLite, run the subscribe commands against it, and assert the
// CLI side wires everything correctly. We do NOT mock the proxy — the
// surface is small enough that asserting against the real handler keeps
// the contract honest end-to-end.

interface ProxyFixture {
  url: string;
  token: string;
  scheduler: SchedulerHandle;
  close: () => Promise<void>;
}

async function startProxy(): Promise<ProxyFixture> {
  const token = randomBytes(16).toString('hex');
  // bearerAuth reads THINK_TOKEN at middleware-creation time inside
  // createApp, so the env var has to be set BEFORE we wire up the app.
  process.env.THINK_TOKEN = token;

  const vaultKey = randomBytes(32);
  const vault: Vault = createVault(vaultKey);
  const db: Database = openDb(':memory:');
  const registry = buildDefaultRegistry();
  const app = createApp({ db, vault, registry });

  // Build a scheduler but don't `start()` — the timer would race with the
  // tests. Tests call `scheduler.tickOnce()` to drive event production
  // explicitly (the mock connector emits events on each tick).
  const scheduler = createScheduler({ db, registry, vault, intervalMs: 1_000_000 });

  const server: ServerType = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => {
    server.once('listening', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('proxy listen failed');
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    url,
    token,
    scheduler,
    close: () =>
      new Promise<void>((resolve) => {
        scheduler.stop();
        server.close(() => resolve());
        db.close();
      }),
  };
}

describe('think subscribe surface', () => {
  let proxy: ProxyFixture;
  let cortex: TestCortex | null = null;
  let originalThinkToken: string | undefined;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    originalThinkToken = process.env.THINK_TOKEN;
    proxy = await startProxy();
  });

  afterAll(async () => {
    await proxy.close();
    if (originalThinkToken === undefined) delete process.env.THINK_TOKEN;
    else process.env.THINK_TOKEN = originalThinkToken;
  });

  beforeEach(async () => {
    cortex = createTestCortex();
    // Set a real cortex active so `subscribe poll` has somewhere to write.
    saveConfig({
      ...getConfig(),
      cortex: { author: 'test', active: cortex.name },
      subscriptions: { proxyUrl: proxy.url, token: proxy.token },
    });
    // Reset proxy state between tests so subs added by one test don't bleed
    // into "no new events"/"--quiet stays silent" assertions in another.
    const cfg = { proxyUrl: proxy.url, token: proxy.token };
    const { listSubscriptions, deleteSubscription } = await import(
      '../../src/lib/proxy-client.js'
    );
    const existing = await listSubscriptions(cfg);
    for (const s of existing) await deleteSubscription(cfg, s.id);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
  });

  afterEach(() => {
    cortex?.cleanup();
    cortex = null;
    vi.restoreAllMocks();
  });

  // commander 13's `parseAsync` throws if `process.exit` is mocked (the
  // help flow exits 0). Wrap in a helper that swallows the synthetic exit.
  async function run(args: string[]): Promise<void> {
    // Each subcommand parse re-uses the same Command instance; reset its
    // arg state between invocations (commander mutates internal state).
    await subscribeCommand.parseAsync(['node', 'subscribe', ...args]);
  }

  it('configure --proxy --token writes to config', async () => {
    await run(['configure', '--proxy', proxy.url, '--token', 'fresh-token']);
    const cfg = getConfig();
    expect(cfg.subscriptions?.proxyUrl).toBe(proxy.url);
    expect(cfg.subscriptions?.token).toBe('fresh-token');
  });

  it('configure rejects non-http URLs', async () => {
    await expect(run(['configure', '--proxy', 'ftp://x', '--token', 't'])).rejects.toThrow(/process\.exit\(1\)/);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('add → list → remove round-trips through the proxy', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      logs.push(String(line));
    });

    await run(['add', 'mock', '3']);
    // Captured `id:` line is the second print after the ✓ banner; pull it out.
    const idLine = logs.find((l) => l.includes('id:'));
    expect(idLine).toBeDefined();
    const subId = idLine!.split('id:')[1]!.trim().replace(/\[\d+m/g, '');
    expect(subId.length).toBeGreaterThan(0);

    logs.length = 0;
    await run(['list']);
    expect(logs.some((l) => l.includes(subId))).toBe(true);
    expect(logs.some((l) => l.includes('mock'))).toBe(true);

    logs.length = 0;
    await run(['remove', subId]);
    expect(logs.some((l) => l.includes('Removed subscription'))).toBe(true);

    logs.length = 0;
    await run(['list']);
    // After removal the table prints the empty-state line.
    expect(logs.some((l) => l.toLowerCase().includes('no subscriptions'))).toBe(true);
  });

  it('poll inserts events as engrams and persists the cursor', async () => {
    if (!cortex) throw new Error('cortex fixture missing');
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      logs.push(String(line));
    });

    await run(['add', 'mock', '2']);
    const idLine = logs.find((l) => l.includes('id:'))!;
    const subId = idLine.split('id:')[1]!.trim().replace(/\[\d+m/g, '');

    // Drive one scheduler tick so the proxy has events to serve. The
    // scheduler is intentionally not auto-started — its timer would race
    // with the test, and tickOnce() gives deterministic ordering.
    await proxy.scheduler.tickOnce();

    logs.length = 0;
    await run(['poll']);

    // `subscribe poll` closes the cached DB handle on completion; re-open
    // a fresh handle for the assertions.
    const db = getCortexDb(cortex.name);
    // Two engrams were inserted (mock with pattern "2" emits 2 events per poll).
    const row = db.prepare(`SELECT count(*) AS c FROM engrams WHERE episode_key = ?`).get('subscribe:mock') as { c: number };
    expect(row.c).toBe(2);

    // Cursor advanced past 0.
    const cursor = getConfig().subscriptions?.cursors?.[subId];
    expect(cursor).toBeDefined();
    expect(cursor!).toBeGreaterThan(0);

    // Engram payload+context preserve metadata for future per-kind formatters.
    const sample = db
      .prepare(`SELECT context FROM engrams WHERE episode_key = ? LIMIT 1`)
      .get('subscribe:mock') as { context: string } | undefined;
    expect(sample).toBeDefined();
    const ctx = JSON.parse(sample!.context);
    expect(ctx.source).toBe('subscribe');
    expect(ctx.kind).toBe('mock');
    expect(ctx.subscription_id).toBe(subId);
  });

  it('poll --quiet stays silent when no events arrive', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
    // No subscriptions set up — poll has nothing to do.
    await run(['poll', '--quiet']);
    expect(logs).toEqual([]);
  });

  it('poll without --quiet logs a "no new events" line on a clean run', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
    await run(['poll']);
    expect(logs.some((l) => /no new events/.test(l))).toBe(true);
  });

  it('show prints proxy URL with token redacted', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
    await run(['show']);
    expect(logs.some((l) => l.includes(proxy.url))).toBe(true);
    expect(logs.some((l) => l.includes('redacted'))).toBe(true);
    expect(logs.every((l) => !l.includes(proxy.token))).toBe(true);
  });
});
