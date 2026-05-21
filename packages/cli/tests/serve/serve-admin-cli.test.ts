import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { serveCommand } from '../../src/commands/serve.js';
import { openDb } from '../../src/serve/db.js';
import { createVault } from '../../src/serve/vault/index.js';
import { addSubscription } from '../../src/serve/admin.js';
import { DEV_VAULT_KEY_PATH, loadVaultKey } from '../../src/serve/vault/key.js';

/**
 * End-to-end CLI tests for `think serve subscribe`, `unsubscribe`,
 * `creds add`, and the AGT-388 enhancements to `status`. Drives the
 * actual commander wiring via `parseAsync` and inspects sqlite state
 * afterwards.
 */

function findSub(name: string) {
  const sub = serveCommand.commands.find((c) => c.name() === name);
  if (!sub) throw new Error(`expected \`serve ${name}\` subcommand to be registered`);
  return sub;
}

function findCredsSub(name: string) {
  const creds = findSub('creds');
  const sub = creds.commands.find((c) => c.name() === name);
  if (!sub) throw new Error(`expected \`serve creds ${name}\` subcommand to be registered`);
  return sub;
}

let tmpDir: string;
let prevDbPath: string | undefined;
let prevVaultKey: string | undefined;
let prevGithubPat: string | undefined;
let prevCredPlaintext: string | undefined;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let prevExitCode: number | string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'serve-admin-cli-'));
  prevDbPath = process.env.THINK_DB_PATH;
  prevVaultKey = process.env.THINK_VAULT_KEY;
  prevGithubPat = process.env.THINK_GITHUB_PAT;
  prevCredPlaintext = process.env.THINK_CRED_PLAINTEXT;
  process.env.THINK_DB_PATH = join(tmpDir, 'proxy.sqlite');
  // Pin a deterministic vault key so the CLI loads the same bytes the
  // test fixture would use. Base64 of 32 random bytes.
  process.env.THINK_VAULT_KEY = randomBytes(32).toString('base64');
  delete process.env.THINK_GITHUB_PAT;
  delete process.env.THINK_CRED_PLAINTEXT;
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  prevExitCode = process.exitCode;
  process.exitCode = undefined;
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  process.exitCode = prevExitCode;
  if (prevDbPath === undefined) delete process.env.THINK_DB_PATH;
  else process.env.THINK_DB_PATH = prevDbPath;
  if (prevVaultKey === undefined) delete process.env.THINK_VAULT_KEY;
  else process.env.THINK_VAULT_KEY = prevVaultKey;
  if (prevGithubPat === undefined) delete process.env.THINK_GITHUB_PAT;
  else process.env.THINK_GITHUB_PAT = prevGithubPat;
  if (prevCredPlaintext === undefined) delete process.env.THINK_CRED_PLAINTEXT;
  else process.env.THINK_CRED_PLAINTEXT = prevCredPlaintext;
  rmSync(tmpDir, { recursive: true, force: true });
});

function getOutput(): string {
  return logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
}

function getErrors(): string {
  return errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
}

describe('think serve subscribe (AGT-388 AC #2)', () => {
  it('inserts a row, prints the id, and is picked up by sqlite', async () => {
    await findSub('subscribe').parseAsync(['node', 'subscribe', 'github', 'octo/widget']);
    expect(getOutput()).toMatch(/subscribed: kind=github pattern=octo\/widget/);

    const db = openDb(process.env.THINK_DB_PATH as string);
    const row = db
      .prepare('SELECT id, kind, pattern FROM subscriptions WHERE kind = ? AND pattern = ?')
      .get('github', 'octo/widget') as { id: string; kind: string; pattern: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.kind).toBe('github');
    expect(row!.pattern).toBe('octo/widget');
    db.close();
  });

  it('is idempotent: second invocation reports already-subscribed without duplicating', async () => {
    await findSub('subscribe').parseAsync(['node', 'subscribe', 'github', 'octo/widget']);
    logSpy.mockClear();
    await findSub('subscribe').parseAsync(['node', 'subscribe', 'github', 'octo/widget']);
    expect(getOutput()).toMatch(/already subscribed/);

    const db = openDb(process.env.THINK_DB_PATH as string);
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE kind = ? AND pattern = ?')
      .get('github', 'octo/widget') as { n: number };
    expect(count.n).toBe(1);
    db.close();
  });

  it('hints at `creds add` only for github (other kinds get no hint)', async () => {
    await findSub('subscribe').parseAsync(['node', 'subscribe', 'github', 'octo/widget']);
    expect(getOutput()).toMatch(/creds add github octo\/widget/);

    logSpy.mockClear();
    await findSub('subscribe').parseAsync(['node', 'subscribe', 'mock', 'whatever']);
    expect(getOutput()).not.toMatch(/creds add/);
  });
});

describe('think serve unsubscribe (AGT-388 AC #3)', () => {
  it('removes the matching row and reports the id', async () => {
    await findSub('subscribe').parseAsync(['node', 'subscribe', 'github', 'octo/widget']);
    logSpy.mockClear();
    await findSub('unsubscribe').parseAsync(['node', 'unsubscribe', 'github', 'octo/widget']);
    expect(getOutput()).toMatch(/unsubscribed: kind=github pattern=octo\/widget/);

    const db = openDb(process.env.THINK_DB_PATH as string);
    const row = db
      .prepare('SELECT id FROM subscriptions WHERE kind = ? AND pattern = ?')
      .get('github', 'octo/widget');
    expect(row).toBeUndefined();
    db.close();
  });

  it('exits non-zero and logs to stderr when no match', async () => {
    await findSub('unsubscribe').parseAsync(['node', 'unsubscribe', 'github', 'octo/widget']);
    expect(getErrors()).toMatch(/no subscription found/);
    expect(process.exitCode).toBe(1);
  });
});

describe('think serve creds add (AGT-388 AC #1)', () => {
  it('stores the credential from $THINK_GITHUB_PAT', async () => {
    await findSub('subscribe').parseAsync(['node', 'subscribe', 'github', 'octo/widget']);
    logSpy.mockClear();

    process.env.THINK_GITHUB_PAT = 'ghp_via_env';
    await findCredsSub('add').parseAsync(['node', 'add', 'github', 'octo/widget']);
    expect(getOutput()).toMatch(/credential stored for kind=github pattern=octo\/widget/);

    // Load via the vault to confirm round-trip.
    const db = openDb(process.env.THINK_DB_PATH as string);
    const vault = createVault(loadVaultKey({ env: process.env }));
    const row = db
      .prepare('SELECT id FROM subscriptions WHERE kind = ? AND pattern = ?')
      .get('github', 'octo/widget') as { id: string };
    expect(vault.load(db, row.id)).toBe('ghp_via_env');
    db.close();
  });

  it('falls back to $THINK_CRED_PLAINTEXT for non-github kinds', async () => {
    // Register an arbitrary `acme` subscription and store a credential via
    // the generic env var. Demonstrates the env-name-by-kind hint is just
    // a default and stdin/THINK_CRED_PLAINTEXT remain as fallbacks.
    const db = openDb(process.env.THINK_DB_PATH as string);
    addSubscription(db, 'acme', 'team-a');
    db.close();

    process.env.THINK_CRED_PLAINTEXT = 'acme-secret-zz';
    await findCredsSub('add').parseAsync(['node', 'add', 'acme', 'team-a']);
    expect(getOutput()).toMatch(/credential stored for kind=acme/);

    const db2 = openDb(process.env.THINK_DB_PATH as string);
    const vault = createVault(loadVaultKey({ env: process.env }));
    const row = db2
      .prepare('SELECT id FROM subscriptions WHERE kind = ? AND pattern = ?')
      .get('acme', 'team-a') as { id: string };
    expect(vault.load(db2, row.id)).toBe('acme-secret-zz');
    db2.close();
  });

  it('errors when no subscription matches', async () => {
    process.env.THINK_GITHUB_PAT = 'ghp_xxx';
    await findCredsSub('add').parseAsync(['node', 'add', 'github', 'no-such/repo']);
    expect(getErrors()).toMatch(/no subscription found/);
    expect(process.exitCode).toBe(1);
  });

  it('errors when no credential is provided (no env, no stdin)', async () => {
    await findSub('subscribe').parseAsync(['node', 'subscribe', 'github', 'octo/widget']);
    logSpy.mockClear();

    // Force isTTY=true to make stdin-read short-circuit (no piped input).
    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    try {
      await findCredsSub('add').parseAsync(['node', 'add', 'github', 'octo/widget']);
      expect(getErrors()).toMatch(/no credential provided/);
      expect(process.exitCode).toBe(1);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: origIsTTY,
        configurable: true,
      });
    }
  });
});

describe('think serve status (AGT-388 AC #4)', () => {
  it('lists subscriptions grouped by kind', async () => {
    const db = openDb(process.env.THINK_DB_PATH as string);
    addSubscription(db, 'github', 'octo/widget');
    addSubscription(db, 'github', 'octo/sprocket');
    addSubscription(db, 'mock', '3');
    db.close();

    await findSub('status').parseAsync(['node', 'status']);
    const out = getOutput();
    expect(out).toMatch(/subscriptions:/);
    expect(out).toMatch(/github:/);
    expect(out).toMatch(/octo\/widget/);
    expect(out).toMatch(/octo\/sprocket/);
    expect(out).toMatch(/mock:/);
  });

  it('signals empty state explicitly', async () => {
    // Touch the DB so the schema exists but no subscriptions are added.
    openDb(process.env.THINK_DB_PATH as string).close();
    await findSub('status').parseAsync(['node', 'status']);
    const out = getOutput();
    expect(out).toMatch(/subscriptions:/);
    expect(out).toMatch(/\(none\)/);
  });
});
