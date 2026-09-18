/**
 * Unit tests for checkUnmigratedEngrams() — AGT-1308 AC1/AC4.
 *
 * The migration is injected in every test: nothing here opens a cortex
 * database, and nothing here can write one. What is asserted is that the
 * check asks for a DRY RUN (AGT-1302's read-only counting path) and maps the
 * summary onto a status the way the ticket describes.
 */

import { describe, it, expect } from 'vitest';
import {
  checkUnmigratedEngrams,
  ENGRAM_ROWS_CHECK_ID,
} from '../../../src/lib/doctor/engram-rows.js';
import type {
  CortexEngramMigration,
  EngramMigrationSummary,
  MigrateEngramsOptions,
} from '../../../src/lib/engram-migration.js';

function cortex(partial: Partial<CortexEngramMigration> & { cortex: string }): CortexEngramMigration {
  return {
    events: 0,
    memories: 0,
    skippedSubscribe: 0,
    skippedInvalid: 0,
    failed: 0,
    repaired: 0,
    warnings: [],
    ...partial,
  };
}

function summary(cortexes: CortexEngramMigration[]): EngramMigrationSummary {
  return {
    dryRun: true,
    cortexes,
    totals: {
      events: cortexes.reduce((n, c) => n + c.events, 0),
      memories: cortexes.reduce((n, c) => n + c.memories, 0),
      skippedSubscribe: cortexes.reduce((n, c) => n + c.skippedSubscribe, 0),
      skippedInvalid: cortexes.reduce((n, c) => n + c.skippedInvalid, 0),
      failed: cortexes.reduce((n, c) => n + c.failed, 0),
      repaired: cortexes.reduce((n, c) => n + c.repaired, 0),
    },
  };
}

describe('checkUnmigratedEngrams (AGT-1308)', () => {
  it('passes when no cortex holds a stranded row', async () => {
    const result = await checkUnmigratedEngrams({
      migrate: async () => summary([cortex({ cortex: 'personal' }), cortex({ cortex: 'work' })]),
    });

    expect(result).toEqual({
      id: ENGRAM_ROWS_CHECK_ID,
      status: 'pass',
      detail: 'No unmigrated engram rows.',
      fixable: false,
    });
  });

  it('AC4: asks AGT-1302 for a dry run, never a real pass', async () => {
    const seen: MigrateEngramsOptions[] = [];
    await checkUnmigratedEngrams({
      migrate: async (options) => {
        seen.push(options);
        return summary([]);
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].dryRun).toBe(true);
  });

  it('fails, fixable, with a per-cortex count of the stranded rows', async () => {
    const result = await checkUnmigratedEngrams({
      migrate: async () => summary([
        cortex({ cortex: 'personal', events: 12, memories: 217 }),
        cortex({ cortex: 'work' }),
      ]),
    });

    expect(result.status).toBe('fail');
    expect(result.fixable).toBe(true);
    expect(result.detail).toContain('229 stranded engram rows');
    expect(result.detail).toContain('personal: 229');
    expect(result.detail).not.toContain('work:');
  });

  it('counts subscribe-only rows as nothing to rescue', async () => {
    // `subscribe:*` rows are deliberately left where they are (AGT-1302 AC2),
    // so a cortex holding only those is healthy, not stranded.
    const result = await checkUnmigratedEngrams({
      migrate: async () => summary([cortex({ cortex: 'personal', skippedSubscribe: 40 })]),
    });

    expect(result.status).toBe('pass');
  });

  it('reports a cortex it could not read rather than counting it as zero', async () => {
    const result = await checkUnmigratedEngrams({
      migrate: async () => summary([
        cortex({ cortex: 'personal' }),
        cortex({ cortex: 'work', error: 'unable to open database file' }),
      ]),
    });

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('could not read 1 cortex');
    expect(result.detail).toContain('work (unable to open database file)');
  });

  it('passes the caller-supplied cortex list through', async () => {
    const seen: MigrateEngramsOptions[] = [];
    await checkUnmigratedEngrams({
      cortexes: ['personal'],
      migrate: async (options) => {
        seen.push(options);
        return summary([]);
      },
    });

    expect(seen[0].cortexes).toEqual(['personal']);
  });
});
