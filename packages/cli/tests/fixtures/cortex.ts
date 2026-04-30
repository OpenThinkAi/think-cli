import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { getCortexDb, closeAllCortexDbs } from '../../src/db/engrams.js';

export interface TestCortex {
  name: string;
  thinkHome: string;
  db: DatabaseSync;
  cleanup: () => void;
}

function newTmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'think-test-'));
}

function randomCortexName(): string {
  return `test-${randomBytes(4).toString('hex')}`;
}

/**
 * Creates an isolated cortex DB in a fresh tmpdir.
 * Sets THINK_HOME for the duration of the test; caller must invoke cleanup() to
 * release the DB handle and remove the tmpdir. The caller is responsible for
 * not interleaving operations across cortexes that share the global env state —
 * use createPeerPair for that.
 */
export function createTestCortex(opts: { name?: string } = {}): TestCortex {
  const thinkHome = newTmpHome();
  const name = opts.name ?? randomCortexName();

  process.env.THINK_HOME = thinkHome;
  closeAllCortexDbs();

  const db = getCortexDb(name);

  return {
    name,
    thinkHome,
    db,
    cleanup: () => {
      closeAllCortexDbs();
      rmSync(thinkHome, { recursive: true, force: true });
      delete process.env.THINK_HOME;
    },
  };
}
