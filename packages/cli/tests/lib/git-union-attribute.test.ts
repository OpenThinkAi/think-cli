import { describe, it, expect } from 'vitest';
import {
  UNION_MERGE_ATTRIBUTE,
  withUnionMergeAttribute,
} from '../../src/lib/git.js';

// Pure-function coverage for the `.gitattributes` union-merge helper. The
// I/O wrappers (`ensureUnionMergeAttribute`, `createOrphanBranch`) are
// exercised through the git-adapter / push-debouncer integration paths; this
// pins the content-shaping logic that both the sync and async write paths
// share, so they can't drift into emitting different `.gitattributes` bytes.

describe('withUnionMergeAttribute', () => {
  it('adds the union line to an empty file', () => {
    expect(withUnionMergeAttribute('')).toBe(`${UNION_MERGE_ATTRIBUTE}\n`);
  });

  it('returns null when the line is already present (idempotent)', () => {
    expect(withUnionMergeAttribute(`${UNION_MERGE_ATTRIBUTE}\n`)).toBeNull();
  });

  it('returns null even when the line has surrounding whitespace', () => {
    expect(withUnionMergeAttribute(`  ${UNION_MERGE_ATTRIBUTE}  \n`)).toBeNull();
  });

  it('appends to existing unrelated attributes, preserving them', () => {
    const existing = '*.png binary\n*.md text\n';
    const result = withUnionMergeAttribute(existing);
    expect(result).toBe(`${existing}${UNION_MERGE_ATTRIBUTE}\n`);
  });

  it('inserts a separating newline when the existing content lacks a trailing one', () => {
    const existing = '*.png binary'; // no trailing newline
    const result = withUnionMergeAttribute(existing);
    expect(result).toBe(`*.png binary\n${UNION_MERGE_ATTRIBUTE}\n`);
  });

  it('does not duplicate when the line is among other attributes', () => {
    const existing = `*.png binary\n${UNION_MERGE_ATTRIBUTE}\n*.md text\n`;
    expect(withUnionMergeAttribute(existing)).toBeNull();
  });
});
