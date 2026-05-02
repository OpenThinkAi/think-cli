import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { LocalFsSyncAdapter } from '../../src/sync/local-fs-adapter.js';
import { createPeerPair, type PeerPair } from '../fixtures/peer-pair.js';
import { saveConfig, getConfig, getPeerId } from '../../src/lib/config.js';
import {
  insertMemory,
  getMemoryCount,
  getMemoriesBySyncVersion,
} from '../../src/db/memory-queries.js';
import { deterministicId } from '../../src/lib/deterministic-id.js';

function configurePeer(pair: PeerPair, peer: 'A' | 'B', root: string) {
  const target = peer === 'A' ? pair.peerA : pair.peerB;
  target.activate();
  const existing = getConfig();
  saveConfig({
    ...existing,
    cortex: {
      fs: { path: root },
      author: `test-peer-${peer}`,
      bucketSize: 3,
    },
  });
}

interface Setup {
  pair: PeerPair;
  root: string;
  cleanup: () => void;
}

function setup(): Setup {
  const root = mkdtempSync(path.join(tmpdir(), 'think-fs-crash-'));
  const pair = createPeerPair();
  configurePeer(pair, 'A', root);
  configurePeer(pair, 'B', root);
  return {
    pair,
    root,
    cleanup() {
      pair.cleanup();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe('LocalFsSyncAdapter — crash and corner-case behaviour', () => {
  let active: Setup | null = null;

  afterEach(() => {
    active?.cleanup();
    active = null;
  });

  it('partial trailing line is skipped on next read; rest of the bucket parses', async () => {
    active = setup();
    const { pair, root } = active;
    const adapter = new LocalFsSyncAdapter();

    pair.peerA.activate();
    insertMemory(pair.cortexName, {
      id: deterministicId('2026-04-29T12:00:00Z', 'a', 'first'),
      ts: '2026-04-29T12:00:00Z', author: 'a', content: 'first',
    });
    insertMemory(pair.cortexName, {
      id: deterministicId('2026-04-29T12:01:00Z', 'a', 'second'),
      ts: '2026-04-29T12:01:00Z', author: 'a', content: 'second',
    });
    pair.peerA.activate();
    await adapter.push(pair.cortexName);

    // Find peer A's bucket file and corrupt the trailing line. This
    // simulates `think log` getting SIGKILLed mid-write — the OS flushed
    // a partial line that fails JSON.parse.
    const peerAId = (() => { pair.peerA.activate(); return getPeerId(); })();
    const bucketPath = path.join(root, pair.cortexName, `${peerAId}-0001.jsonl`);
    appendFileSync(bucketPath, '{"ts":"2026-04-29T12:02:00Z","author":"a","content":"par'); // truncated

    pair.peerB.activate();
    const result = await adapter.pull(pair.cortexName);
    expect(result.errors).toEqual([]);
    expect(result.pulled).toBe(2); // full lines, partial dropped
    expect(getMemoryCount(pair.cortexName)).toBe(2);
  });

  it('bucket rotation crosses the cap and produces a new file on disk', async () => {
    active = setup();
    const { pair, root } = active;
    const adapter = new LocalFsSyncAdapter();

    pair.peerA.activate();
    // bucketSize is 3 (set by configurePeer); 5 inserts spans two buckets.
    for (let i = 0; i < 5; i++) {
      insertMemory(pair.cortexName, {
        id: deterministicId('2026-04-29T12:00:00Z', 'a', `m-${i}`),
        ts: '2026-04-29T12:00:00Z', author: 'a', content: `m-${i}`,
      });
    }
    pair.peerA.activate();
    const result = await adapter.push(pair.cortexName);
    expect(result.errors).toEqual([]);
    expect(result.pushed).toBe(5);

    const peerAId = getPeerId();
    const cortexDir = path.join(root, pair.cortexName);
    const files = fs.readdirSync(cortexDir).filter(n => n.endsWith('.jsonl')).sort();
    expect(files).toEqual([`${peerAId}-0001.jsonl`, `${peerAId}-0002.jsonl`]);

    const first = readFileSync(path.join(cortexDir, files[0]), 'utf-8').trim().split('\n');
    const second = readFileSync(path.join(cortexDir, files[1]), 'utf-8').trim().split('\n');
    expect(first).toHaveLength(3);
    expect(second).toHaveLength(2);
  });

  it('iCloud-style conflict-suffixed file is parsed and dedups via deterministic ids', async () => {
    active = setup();
    const { pair, root } = active;
    const adapter = new LocalFsSyncAdapter();

    pair.peerA.activate();
    insertMemory(pair.cortexName, {
      id: deterministicId('2026-04-29T12:00:00Z', 'a', 'shared-line'),
      ts: '2026-04-29T12:00:00Z', author: 'a', content: 'shared-line',
    });
    pair.peerA.activate();
    await adapter.push(pair.cortexName);

    // Simulate iCloud renaming peer A's bucket to a conflict copy. Same
    // bytes; design doc says the renamed file still parses and dedupes.
    const peerAId = (() => { pair.peerA.activate(); return getPeerId(); })();
    const cortexDir = path.join(root, pair.cortexName);
    const original = path.join(cortexDir, `${peerAId}-0001.jsonl`);
    const conflict = path.join(cortexDir, `${peerAId}-0001 (conflict).jsonl`);
    writeFileSync(conflict, readFileSync(original, 'utf-8'));

    pair.peerB.activate();
    const first = await adapter.pull(pair.cortexName);
    expect(first.errors).toEqual([]);
    // The line lands once even though it was on disk twice — deterministic
    // ids collapse the duplicate.
    expect(getMemoryCount(pair.cortexName)).toBe(1);
    // Both files were read this round (`pulled` counts inserts; one
    // file's worth was duplicate so didn't add).
    expect(first.pulled).toBe(1);
  });

  it('per-file pull cursor advances; re-pull is a no-op even when no new bytes', async () => {
    active = setup();
    const { pair } = active;
    const adapter = new LocalFsSyncAdapter();

    pair.peerA.activate();
    insertMemory(pair.cortexName, {
      id: deterministicId('2026-04-29T12:00:00Z', 'a', 'one'),
      ts: '2026-04-29T12:00:00Z', author: 'a', content: 'one',
    });
    pair.peerA.activate();
    await adapter.push(pair.cortexName);

    pair.peerB.activate();
    const first = await adapter.pull(pair.cortexName);
    const second = await adapter.pull(pair.cortexName);

    expect(first.pulled).toBe(1);
    expect(second.pulled).toBe(0);
    expect(getMemoryCount(pair.cortexName)).toBe(1);
  });

  it('appended lines after a pull cursor are picked up on the next pull', async () => {
    active = setup();
    const { pair } = active;
    const adapter = new LocalFsSyncAdapter();

    pair.peerA.activate();
    insertMemory(pair.cortexName, {
      id: deterministicId('2026-04-29T12:00:00Z', 'a', 'first'),
      ts: '2026-04-29T12:00:00Z', author: 'a', content: 'first',
    });
    pair.peerA.activate();
    await adapter.push(pair.cortexName);

    pair.peerB.activate();
    await adapter.pull(pair.cortexName);
    expect(getMemoryCount(pair.cortexName)).toBe(1);

    pair.peerA.activate();
    insertMemory(pair.cortexName, {
      id: deterministicId('2026-04-29T12:01:00Z', 'a', 'second'),
      ts: '2026-04-29T12:01:00Z', author: 'a', content: 'second',
    });
    pair.peerA.activate();
    await adapter.push(pair.cortexName);

    pair.peerB.activate();
    const result = await adapter.pull(pair.cortexName);
    expect(result.pulled).toBe(1);
    expect(getMemoryCount(pair.cortexName)).toBe(2);
  });

  it('externally-injected line without origin_peer_id falls back to the writer-peer from the filename', async () => {
    active = setup();
    const { pair, root } = active;
    const adapter = new LocalFsSyncAdapter();

    // Fabricate a bucket file as if dropped by an external writer (HiveDB,
    // direct fs injection). The line lacks origin_peer_id; the filename
    // carries a synthetic peer id that should be inferred and stamped.
    const fakePeer = '11111111-1111-4111-8111-111111111111';
    const cortexDir = path.join(root, pair.cortexName);
    fs.mkdirSync(cortexDir, { recursive: true });
    const line = JSON.stringify({
      ts: '2026-04-29T12:00:00Z',
      author: 'external',
      content: 'from-an-external-writer',
      source_ids: [],
    }) + '\n';
    writeFileSync(path.join(cortexDir, `${fakePeer}-0001.jsonl`), line);

    pair.peerB.activate();
    const result = await adapter.pull(pair.cortexName);
    expect(result.errors).toEqual([]);
    expect(result.pulled).toBe(1);
    const rows = getMemoriesBySyncVersion(pair.cortexName, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0].origin_peer_id).toBe(fakePeer);
  });
});
