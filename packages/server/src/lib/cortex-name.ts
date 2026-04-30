/**
 * Cortex name validation — mirrors the CLI's sanitizeName so a name accepted
 * locally is also accepted on the server. Alphanumerics, hyphens, underscores;
 * no traversal sequences.
 */
export function isValidCortexName(name: string): boolean {
  if (!name || /[\/\\.]{2}/.test(name)) return false;
  return /^[a-zA-Z0-9_-]+$/.test(name);
}
