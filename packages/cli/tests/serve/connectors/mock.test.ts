import { describe, it, expect } from 'vitest';
import { mockConnector, type MockCursor } from '../../../src/serve/connectors/mock.js';

const SUB = { id: 'sub-1', kind: 'mock', pattern: '3' };

describe('mockConnector', () => {
  it('emits N events per poll when pattern is integer string "N"', async () => {
    const result = await mockConnector.poll({
      subscription: SUB,
      credential: null,
      cursor: null,
    });
    expect(result.events).toHaveLength(3);
    expect(result.events.map((e) => e.id)).toEqual(['mock-1', 'mock-2', 'mock-3']);
    expect(result.nextCursor).toEqual({ count: 3 });
  });

  it('advances ids monotonically across polls via cursor', async () => {
    const first = await mockConnector.poll({
      subscription: SUB,
      credential: null,
      cursor: null,
    });
    const second = await mockConnector.poll({
      subscription: SUB,
      credential: null,
      cursor: first.nextCursor,
    });
    expect(second.events.map((e) => e.id)).toEqual(['mock-4', 'mock-5', 'mock-6']);
    expect(second.nextCursor).toEqual({ count: 6 });
  });

  it('emits 1 event per poll when pattern is non-integer', async () => {
    const result = await mockConnector.poll({
      subscription: { ...SUB, pattern: 'whatever' },
      credential: null,
      cursor: null,
    });
    expect(result.events).toHaveLength(1);
    expect(result.events[0].id).toBe('mock-1');
    expect(result.nextCursor).toEqual({ count: 1 });
  });

  it('emits 1 event per poll when pattern is non-positive integer', async () => {
    const zero: MockCursor = { count: 0 };
    const result = await mockConnector.poll({
      subscription: { ...SUB, pattern: '0' },
      credential: null,
      cursor: zero,
    });
    expect(result.events).toHaveLength(1);
  });

  it('rejects loose integer-string coercion (e.g. "5abc" → 1, not 5)', async () => {
    // Strictness check: parseInt would coerce "5abc" → 5, but the README
    // claims integer-string semantics so we use Number() instead. Pin
    // the contract so a future regression to parseInt fails here.
    const result = await mockConnector.poll({
      subscription: { ...SUB, pattern: '5abc' },
      credential: null,
      cursor: null,
    });
    expect(result.events).toHaveLength(1);
  });

  it('payload carries the subscription id and the global seq', async () => {
    const result = await mockConnector.poll({
      subscription: SUB,
      credential: null,
      cursor: { count: 10 },
    });
    expect(result.events[0].payload).toEqual({ seq: 11, subscription_id: 'sub-1' });
  });
});
