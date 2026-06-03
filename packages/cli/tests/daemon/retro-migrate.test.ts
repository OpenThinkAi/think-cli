/**
 * Tests for the `retro_migrate` daemon handler — iterative-learning v3.
 *
 * Verifies the fold-into-home-cortex migration:
 *   - dry-run counts what would migrate and mutates nothing.
 *   - apply copies each source retro onto the target tagged repo:<source> +
 *     migrated:<source>, and tombstones the source copy (deleted_at).
 *   - re-running after a full apply is a no-op (sources drained).
 *   - the migrated:<source> marker makes a still-present source retro skip when
 *     the target already holds it (idempotency).
 *
 * embed() is mocked to a content-dependent ORTHOGONAL vector so the
 * near-duplicate fold and supersession worker stay inert (distinct contents →
 * ~0 cosine), keeping copy counts exact.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIM = 384;

// Content-dependent orthogonal unit vector: a single 1.0 at a hashed axis.
function vecFor(text: string): Float32Array {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  const v = new Float32Array(DIM);
  v[h % DIM] = 1.0;
  return v;
}

vi.mock('../../src/lib/embed.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/embed.js')>();
  return {
    ...actual,
    default: (text: string) => Promise.resolve(vecFor(text)),
  };
});

let thinkHome: string;

beforeEach(async () => {
  thinkHome = mkdtempSync(join(tmpdir(), 'think-migrate-test-'));
  process.env.THINK_HOME = thinkHome;
  const configDir = join(thinkHome, 'config');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({ peerId: 'test-peer', syncPort: 9999, cortex: { author: 'tester' } }) + '\n',
    { mode: 0o600 },
  );

  const { getCortexDb, closeAllCortexDbs } = await import('../../src/db/engrams.js');
  closeAllCortexDbs();
  // Touch all cortexes so they exist for handleSync's cortexExists check.
  for (const c of ['home', 'src-a', 'src-b']) getCortexDb(c);
  closeAllCortexDbs();

  const { pushDebouncer } = await import('../../src/daemon/push-debouncer.js');
  pushDebouncer._gitOverride = async () => '';
});

afterEach(async () => {
  const { pushDebouncer } = await import('../../src/daemon/push-debouncer.js');
  pushDebouncer._gitOverride = undefined;
  const { closeAllCortexDbs } = await import('../../src/db/engrams.js');
  closeAllCortexDbs();
  vi.resetModules();
  rmSync(thinkHome, { recursive: true, force: true });
  delete process.env.THINK_HOME;
});

/** Seed a retro row directly into a source cortex's L2 (kind=retro, embedded). */
async function seedRetro(cortex: string, content: string, topics: string[] = []): Promise<string> {
  const { getCortexDb } = await import('../../src/db/engrams.js');
  const { insertMemory } = await import('../../src/db/memory-queries.js');
  const db = getCortexDb(cortex);
  const mem = insertMemory(cortex, { ts: '2026-05-01T00:00:00Z', author: 'tester', content });
  const vec = vecFor(content);
  const blob = new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
  db.prepare('UPDATE memories SET embedding = ?, activity_seq = ?, kind = ?, topics_json = ? WHERE id = ?')
    .run(blob, 1, 'retro', JSON.stringify(topics), mem.id);
  return mem.id;
}

async function liveRetros(cortex: string): Promise<{ id: string; content: string; topics_json: string | null }[]> {
  const { getCortexDb } = await import('../../src/db/engrams.js');
  const db = getCortexDb(cortex);
  return db.prepare(
    `SELECT id, content, topics_json FROM memories WHERE kind = 'retro' AND deleted_at IS NULL`,
  ).all() as { id: string; content: string; topics_json: string | null }[];
}

describe('handleRetroMigrate', () => {
  it('dry-run counts candidates and mutates nothing', async () => {
    await seedRetro('src-a', 'lesson a1');
    await seedRetro('src-a', 'lesson a2');
    await seedRetro('src-b', 'lesson b1');

    const { handleRetroMigrate } = await import('../../src/daemon/retro-migrate-handler.js');
    const res = await handleRetroMigrate({ from: ['src-a', 'src-b'], to: 'home', apply: false });

    expect(res.totalMigrated).toBe(3);
    expect(res.totalSkipped).toBe(0);
    expect(res.apply).toBe(false);
    // Nothing moved.
    expect((await liveRetros('home')).length).toBe(0);
    expect((await liveRetros('src-a')).length).toBe(2);
    expect((await liveRetros('src-b')).length).toBe(1);
  });

  it('apply copies tagged retros to target and tombstones sources', async () => {
    await seedRetro('src-a', 'lesson a1', ['ux']);
    await seedRetro('src-a', 'lesson a2');
    await seedRetro('src-b', 'lesson b1');

    const { handleRetroMigrate } = await import('../../src/daemon/retro-migrate-handler.js');
    const res = await handleRetroMigrate({ from: ['src-a', 'src-b'], to: 'home', apply: true });

    expect(res.totalMigrated).toBe(3);

    const home = await liveRetros('home');
    expect(home.length).toBe(3);
    // Sources are tombstoned.
    expect((await liveRetros('src-a')).length).toBe(0);
    expect((await liveRetros('src-b')).length).toBe(0);

    // Each migrated copy carries repo:<source> + migrated:<source>; the original
    // free topic survives.
    const a1 = home.find((r) => r.content === 'lesson a1')!;
    const a1topics = JSON.parse(a1.topics_json ?? '[]') as string[];
    expect(a1topics).toContain('repo:src-a');
    expect(a1topics).toContain('migrated:src-a');
    expect(a1topics).toContain('ux');

    const b1 = home.find((r) => r.content === 'lesson b1')!;
    const b1topics = JSON.parse(b1.topics_json ?? '[]') as string[];
    expect(b1topics).toContain('repo:src-b');
  });

  it('re-running after a full apply is a no-op (sources drained)', async () => {
    await seedRetro('src-a', 'lesson a1');
    const { handleRetroMigrate } = await import('../../src/daemon/retro-migrate-handler.js');

    await handleRetroMigrate({ from: ['src-a'], to: 'home', apply: true });
    const again = await handleRetroMigrate({ from: ['src-a'], to: 'home', apply: true });

    expect(again.totalMigrated).toBe(0);
    expect((await liveRetros('home')).length).toBe(1);
  });

  it('skips a source retro already present in target (migrated marker idempotency)', async () => {
    // Source retro still present, and target already holds a marked copy.
    await seedRetro('src-a', 'shared lesson');
    await seedRetro('home', 'shared lesson', ['repo:src-a', 'migrated:src-a']);

    const { handleRetroMigrate } = await import('../../src/daemon/retro-migrate-handler.js');
    const res = await handleRetroMigrate({ from: ['src-a'], to: 'home', apply: true });

    expect(res.totalSkipped).toBe(1);
    expect(res.totalMigrated).toBe(0);
    // Source NOT tombstoned (it was skipped, not migrated).
    expect((await liveRetros('src-a')).length).toBe(1);
  });

  it('excludes the target from sources and ignores empty source lists', async () => {
    const { handleRetroMigrate } = await import('../../src/daemon/retro-migrate-handler.js');
    const res = await handleRetroMigrate({ from: ['home'], to: 'home', apply: true });
    expect(res.sources.length).toBe(0);
    expect(res.totalMigrated).toBe(0);
  });
});
