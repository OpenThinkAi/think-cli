/**
 * Tests for the supersession structural evidence gate (issue #87).
 *
 * The accept/reject fixtures are the real entry pairs from the issue report:
 * the telex/hivedb mislink must be rejected; the ui-quiver and ANGL-2041
 * consolidations (correct links from the same curation run) must pass.
 */

import { describe, it, expect } from 'vitest';
import {
  extractEntities,
  hasSupersessionEvidence,
  gateSupersedes,
} from '../../src/lib/supersession-guard.js';

// The mislinked pair from issue #87 — vocabulary overlap, no shared subject.
const HIVEDB_DECISION = {
  content:
    'In the Anglepoint-Inc/hivedb repository, PR #49 (merged 2026-06-09, branch ' +
    '`recall-cli-not-mcp`) rewrote the `# Team Context` block in `setup.sh` to replace ' +
    'all MCP-based recall guidance with the plain `think recall` CLI command.',
  topics: ['agent-recall-guidance', 'setup-sh', 'mcp-removal'],
};
const TELEX_ENTRY = {
  content:
    'telex-agentd team context: workers briefed from compiled instructions + read-only ' +
    'eng-index + think recall output appended to job prompt, recording shipments to ' +
    'cortex/engineering marked [telex-worker].',
  topics: ['telex', 'think-recall', 'agent-memory'],
};

// Correct consolidations sampled in the issue.
const UI_QUIVER_OLD = {
  content: 'PR #137 in Anglepoint-Engineering/ui-quiver was closed without merging after review feedback.',
  topics: ['ui-quiver', 'pr'],
};
const UI_QUIVER_NEW = {
  content: 'ui-quiver package: reverted to standalone repository model after the monorepo experiment.',
  topics: ['ui-quiver', 'repo-structure'],
};
const ANGL_OLD = {
  content: 'The work in PR #116 is part of a larger domain migration tracked as ANGL-2041.',
  topics: ['domain-migration'],
};
const ANGL_NEW = {
  content: 'ANGL-2041 domain migration: non-production environments moved from legacy DNS to the new zone.',
  topics: ['angl-2041', 'dns'],
};

describe('extractEntities', () => {
  it('extracts repo slugs and their segments', () => {
    const e = extractEntities('work in Anglepoint-Inc/hivedb continues');
    expect(e).toContain('anglepoint-inc/hivedb');
    expect(e).toContain('hivedb');
  });

  it('extracts ticket ids, PR refs, filenames, hyphenated identifiers', () => {
    const e = extractEntities('ANGL-2041 via PR #49 touched setup.sh in telex-agentd');
    expect(e).toContain('angl-2041');
    expect(e).toContain('#49');
    expect(e).toContain('setup.sh');
    expect(e).toContain('telex-agentd');
  });

  it('does not treat version numbers or plain prose as entities', () => {
    const e = extractEntities('version 2.4.0 was released and everyone was happy about it');
    expect(e).not.toContain('2.4.0');
    expect(e).not.toContain('version');
    expect(e).not.toContain('released');
  });

  it('ignores dotted stopwords like e.g', () => {
    expect(extractEntities('some tools, e.g the linter')).not.toContain('e.g');
  });
});

describe('hasSupersessionEvidence', () => {
  it('rejects the telex/hivedb mislink from issue #87', () => {
    expect(hasSupersessionEvidence(TELEX_ENTRY, HIVEDB_DECISION)).toBe(false);
  });

  it('accepts the ui-quiver consolidation (shared topic and entity)', () => {
    expect(hasSupersessionEvidence(UI_QUIVER_NEW, UI_QUIVER_OLD)).toBe(true);
  });

  it('accepts the ANGL-2041 consolidation (shared ticket entity, no shared topic)', () => {
    expect(hasSupersessionEvidence(ANGL_NEW, ANGL_OLD)).toBe(true);
  });

  it('accepts on shared topic alone (case-insensitive)', () => {
    expect(hasSupersessionEvidence(
      { content: 'nothing structural here', topics: ['Repo:HiveDB'] },
      { content: 'also nothing structural', topics: ['repo:hivedb'] },
    )).toBe(true);
  });

  it('rejects vocabulary-only overlap when both sides carry structure', () => {
    expect(hasSupersessionEvidence(
      { content: 'we improved agent memory and recall quality', topics: ['memory'] },
      { content: 'agent recall and memory tuning for the other project', topics: ['tuning'] },
    )).toBe(false);
  });

  it('defers to the LLM when either side is structure-free (plain prose retros)', () => {
    // "use pnpm" superseding "use npm": no topics, no extractable entities —
    // nothing to compare, so the gate must not block the legitimate case.
    expect(hasSupersessionEvidence(
      { content: 'use pnpm in this repo', topics: [] },
      { content: 'use npm', topics: [] },
    )).toBe(true);
    // One structured side, one structure-free side: still defer.
    expect(hasSupersessionEvidence(
      TELEX_ENTRY,
      { content: 'we should keep improving things', topics: [] },
    )).toBe(true);
  });
});

describe('gateSupersedes', () => {
  const targets = new Map([
    ['good', { ...UI_QUIVER_OLD, similarity: 0.8 }],
    ['mislink', { ...HIVEDB_DECISION, similarity: 0.7 }],
    ['weak', { ...UI_QUIVER_OLD, similarity: 0.1 }],
  ]);
  const lookup = (id: string) => targets.get(id);

  it('accepts evidence-backed ids and rejects mislinks with reasons', () => {
    const result = gateSupersedes(UI_QUIVER_NEW, ['good', 'mislink'], lookup);
    expect(result.accepted).toEqual(['good']);
    expect(result.rejected).toEqual([
      { id: 'mislink', reason: 'structural signals disjoint (no shared topic or named entity)' },
    ]);
  });

  it('applies the pairwise similarity floor when provided', () => {
    const result = gateSupersedes(UI_QUIVER_NEW, ['good', 'weak'], lookup, 0.4);
    expect(result.accepted).toEqual(['good']);
    expect(result.rejected[0].id).toBe('weak');
    expect(result.rejected[0].reason).toMatch(/below floor/);
  });

  it('rejects unknown ids', () => {
    const result = gateSupersedes(UI_QUIVER_NEW, ['ghost'], lookup);
    expect(result.accepted).toEqual([]);
    expect(result.rejected[0].reason).toBe('target not found');
  });
});
