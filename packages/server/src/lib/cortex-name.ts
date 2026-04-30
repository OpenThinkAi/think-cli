/**
 * Cortex name validation — mirrors the CLI's sanitizeName so a name accepted
 * locally is also accepted on the server. Alphanumerics, hyphens, underscores,
 * length-bounded.
 */
const VALID = /^[a-zA-Z0-9_-]{1,64}$/;

export const CORTEX_NAME_ERROR =
  'invalid cortex name (use 1-64 chars, a-z, A-Z, 0-9, _, -)';

export function isValidCortexName(name: string): boolean {
  return VALID.test(name);
}
