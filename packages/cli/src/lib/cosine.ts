/**
 * Cosine similarity for L2-normalized Float32Array vectors.
 *
 * Callers' contract: both vectors are already unit-length (L2-normalized).
 * Under that contract cosine similarity reduces to a plain dot product —
 * no division by norms is needed or correct here. Adding re-normalization
 * would silently hide a caller bug and add unnecessary FLOPs per call.
 *
 * Benchmark: dot product over 384-d floats is sub-microsecond per call on
 * M-series (Apple Silicon) — well within the <100ms recall budget.
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(
      `cosine: vector length mismatch — a.length=${a.length}, b.length=${b.length}`,
    );
  }
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}
