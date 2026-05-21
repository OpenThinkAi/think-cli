import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveCommand } from '../../src/commands/serve.js';
import { openDb } from '../../src/serve/db.js';
import { writeProxyPeerId } from '../../src/serve/peer-id.js';

/**
 * AGT-385 AC #4 — `think serve status` displays the active peer-id.
 *
 * The status subcommand reads the same sqlite DB the running proxy writes
 * to (resolved via `THINK_DB_PATH`, default `./open-think.sqlite`).
 * Without starting the server, it just opens, reads, and prints.
 */

function findStatusSub() {
  // Commander's `.commands` is the array of registered subcommands. We
  // look up `status` by name rather than relying on positional index so
  // future-added subcommands don't shift the test.
  const sub = serveCommand.commands.find((c) => c.name() === 'status');
  if (!sub) {
    throw new Error('expected `serve status` subcommand to be registered');
  }
  return sub;
}

let tmpDir: string;
let prevDbPath: string | undefined;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'serve-status-test-'));
  prevDbPath = process.env.THINK_DB_PATH;
  process.env.THINK_DB_PATH = join(tmpDir, 'proxy.sqlite');
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  if (prevDbPath === undefined) {
    delete process.env.THINK_DB_PATH;
  } else {
    process.env.THINK_DB_PATH = prevDbPath;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('think serve status (AGT-385 AC #4)', () => {
  it('prints the persisted peer-id when one is set', async () => {
    // Seed the DB the way a real boot would.
    const db = openDb(process.env.THINK_DB_PATH as string);
    writeProxyPeerId(db, 'proxy-anglepoint');
    db.close();

    await findStatusSub().parseAsync(['node', 'status']);

    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('proxy peer-id:');
    expect(output).toContain('proxy-anglepoint');
    expect(output).toContain('db path:');
    expect(output).toContain(process.env.THINK_DB_PATH);
  });

  it('signals unset state clearly when no peer-id has been persisted', async () => {
    // Open + close to create the schema, but write nothing.
    const db = openDb(process.env.THINK_DB_PATH as string);
    db.close();

    await findStatusSub().parseAsync(['node', 'status']);

    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('proxy peer-id:');
    // Must NOT silently show an empty string — that would look broken.
    expect(output).toMatch(/unset|will auto-generate/i);
  });
});
