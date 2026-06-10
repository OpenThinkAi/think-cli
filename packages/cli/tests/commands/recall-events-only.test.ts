/**
 * AGT-479 AC #3 + AC #6: `recall --all` renders long-term events correctly
 * and does NOT render a legacy long-term summary block after the
 * longterm_summary tier is removed.
 *
 * Strategy: call renderPersonalAll() directly against a temporary cortex
 * populated with a long-term event and (optionally) memories. Capture
 * console.log output via a spy and assert:
 *   - the legacy "Long-term context (legacy summary)" heading is absent
 *   - long-term events are still rendered under "Long-term history:"
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCortexDb, closeAllCortexDbs } from '../../src/db/engrams.js';
import { insertLongTermEvent } from '../../src/db/long-term-queries.js';
import { insertMemory } from '../../src/db/memory-queries.js';
import { renderPersonalAll } from '../../src/commands/recall.js';

function writeConfig(thinkHome: string, activeCortex: string): void {
  const configDir = join(thinkHome, 'config');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({ peerId: 'test-peer', syncPort: 19876, cortex: { active: activeCortex, author: 'tester' } }),
  );
}

describe('renderPersonalAll — events-only (AGT-479)', () => {
  let originalHome: string | undefined;
  let tmpHome: string;
  const cortex = 'recall-events-only-test';
  const logLines: string[] = [];

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-recall-events-test-'));
    process.env.THINK_HOME = tmpHome;
    writeConfig(tmpHome, cortex);
    closeAllCortexDbs();
    getCortexDb(cortex); // initialise DB + run migrations

    logLines.length = 0;
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logLines.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    closeAllCortexDbs();
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('renders long-term events under "Long-term history:" (AC #6)', () => {
    insertLongTermEvent(cortex, {
      ts: new Date().toISOString(),
      author: 'tester',
      kind: 'milestone',
      title: 'Shipped AGT-479: removed long-term summary tier',
      content: 'The long-term summary tier was deprecated in favour of structured events.',
      topics: ['architecture'],
      supersedes: null,
      source_memory_ids: [],
    });

    renderPersonalAll(cortex, { days: 30 });

    const combined = logLines.join('\n');
    expect(combined).toContain('Long-term history:');
    expect(combined).toContain('Shipped AGT-479: removed long-term summary tier');
  });

  it('does NOT render the legacy "Long-term context (legacy summary)" block (AC #3)', () => {
    // Even with a memory present, no legacy summary block must appear.
    insertMemory(cortex, {
      ts: new Date().toISOString(),
      author: 'tester',
      content: 'Some recent memory.',
    });

    renderPersonalAll(cortex, { days: 30 });

    const combined = logLines.join('\n');
    expect(combined).not.toContain('Long-term context (legacy summary)');
    expect(combined).not.toContain('legacy summary');
  });

  it('renders memories under "Team memories" when present and events are absent (AC #3)', () => {
    insertMemory(cortex, {
      ts: new Date().toISOString(),
      author: 'tester',
      content: 'A memory with no accompanying events.',
    });

    renderPersonalAll(cortex, { days: 30 });

    const combined = logLines.join('\n');
    expect(combined).toContain('Team memories');
    expect(combined).toContain('A memory with no accompanying events.');
    expect(combined).not.toContain('legacy summary');
  });

  it('shows "No results found." when there are no memories, events, or engrams', () => {
    renderPersonalAll(cortex, { days: 30 });

    const combined = logLines.join('\n');
    expect(combined).toContain('No results found.');
    expect(combined).not.toContain('legacy summary');
  });
});
