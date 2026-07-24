/**
 * Tests for topic merge helpers (issue #86).
 */

import { describe, it, expect } from 'vitest';
import {
  mergeTopics,
  isStructuralTopic,
  parseTopicsJson,
  MAX_MERGED_TOPICS,
} from '../../src/lib/topics.js';

describe('isStructuralTopic', () => {
  it('recognises repo: tags case-insensitively', () => {
    expect(isStructuralTopic('repo:hivedb')).toBe(true);
    expect(isStructuralTopic('REPO:hivedb')).toBe(true);
  });

  it('rejects descriptive topics', () => {
    expect(isStructuralTopic('mcp')).toBe(false);
    expect(isStructuralTopic('repository')).toBe(false);
  });
});

describe('mergeTopics', () => {
  it('preserves existing topics verbatim and in order', () => {
    const merged = mergeTopics(['mcp', 'repo:hivedb'], []);
    expect(merged).toEqual(['mcp', 'repo:hivedb']);
  });

  it('appends derived topics not already present', () => {
    const merged = mergeTopics(['mcp'], ['sqlite', 'auth']);
    expect(merged).toEqual(['mcp', 'sqlite', 'auth']);
  });

  it('dedupes case-insensitively, keeping the existing spelling', () => {
    const merged = mergeTopics(['Claude-MD'], ['claude-md', 'think']);
    expect(merged).toEqual(['Claude-MD', 'think']);
  });

  it('returns derived topics unchanged when nothing existed', () => {
    expect(mergeTopics([], ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('caps the merge at MAX_MERGED_TOPICS with existing topics winning', () => {
    const existing = Array.from({ length: MAX_MERGED_TOPICS }, (_, i) => `e${i}`);
    const merged = mergeTopics(existing, ['derived']);
    expect(merged).toHaveLength(MAX_MERGED_TOPICS);
    expect(merged).not.toContain('derived');
  });
});

describe('parseTopicsJson', () => {
  it('parses a valid topics array', () => {
    expect(parseTopicsJson('["a","b"]')).toEqual(['a', 'b']);
  });

  it('returns [] for null, undefined, and empty string', () => {
    expect(parseTopicsJson(null)).toEqual([]);
    expect(parseTopicsJson(undefined)).toEqual([]);
    expect(parseTopicsJson('')).toEqual([]);
  });

  it('returns [] for malformed JSON and non-array values', () => {
    expect(parseTopicsJson('{ nope')).toEqual([]);
    expect(parseTopicsJson('"just-a-string"')).toEqual([]);
  });

  it('drops non-string elements', () => {
    expect(parseTopicsJson('["a", 3, null, "b"]')).toEqual(['a', 'b']);
  });
});
