// Repo-URL validation shared between setup-time (think cortex setup) and
// read-time (ensureRepoCloned). Keeping a single implementation means the
// two validation layers can't drift — if the allowlist changes, both sites
// pick up the change at once.

// Scheme match is case-insensitive (git itself accepts HTTPS://host/repo).
// Empty input is handled by the caller; this regex only gates non-empty
// values against the allowed transport shapes.
const ALLOWED = /^(https?:\/\/|git@[^:\s]+:|ssh:\/\/|git:\/\/)/i;

export function validateRepoUrl(url: string): void {
  if (!url) return; // empty is valid — offline-only mode
  if (url.startsWith('-')) {
    throw new Error(
      `Invalid repo URL: "${url}" starts with '-'. URLs cannot begin with a hyphen.`,
    );
  }
  if (!ALLOWED.test(url)) {
    throw new Error(
      `Invalid repo URL: "${url}". Must start with https:// (preferred), ssh://, git://, git@<host>:<path>, or http:// (not recommended — traffic is unencrypted). Fix with 'think cortex setup' or edit ~/.config/think/config.json.`,
    );
  }
}
