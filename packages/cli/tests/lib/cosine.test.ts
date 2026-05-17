import { describe, it, expect } from 'vitest';
import { cosine } from '../../src/lib/cosine.js';

describe('cosine (AGT-274)', () => {
  it('returns 1.0 for identical unit vectors', () => {
    // [1, 0, 0] is already unit-length
    const v = new Float32Array([1, 0, 0]);
    expect(cosine(v, v)).toBe(1.0);
  });

  it('returns -1.0 for a unit vector and its negation', () => {
    const v = new Float32Array([1, 0, 0]);
    const neg = new Float32Array([-1, 0, 0]);
    expect(cosine(v, neg)).toBe(-1.0);
  });

  it('returns ~0 for orthogonal unit vectors (within float epsilon)', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(Math.abs(cosine(a, b))).toBeLessThan(1e-7);
  });

  it('throws on length mismatch', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([1, 0]);
    expect(() => cosine(a, b)).toThrow('cosine: vector length mismatch');
  });
});
