// Repo-URL validation shared between setup-time (think cortex setup) and
// read-time (ensureRepoCloned). Keeping a single implementation means the
// two validation layers can't drift — if the allowlist changes, both sites
// pick up the change at once.

// Scheme match is case-insensitive (git itself accepts HTTPS://host/repo).
// Empty input is handled by the caller; this regex only gates non-empty
// values against the allowed transport shapes.
//
// The SCP-shortcut arm is `[\w.-]+@[^:\s]+:` rather than the naive
// `git@[^:\s]+:` — git's actual syntax is `<user>@<host>:<path>` with any
// username, and configs like `gitlab@self-hosted:group/repo.git` or
// `bob@host:repo.git` are real (self-hosted GitLab/Gitea deployments,
// custom CI setups). Restricting to literal `git@` would silently break
// existing users on upgrade.
const ALLOWED = /^(https?:\/\/|[\w.-]+@[^:\s]+:|ssh:\/\/|git:\/\/)/i;

export function validateRepoUrl(url: string): void {
  if (!url) return; // empty is valid — offline-only mode
  if (url.startsWith('-')) {
    throw new Error(
      `Invalid repo URL: "${url}" starts with '-'. URLs cannot begin with a hyphen.`,
    );
  }
  if (!ALLOWED.test(url)) {
    throw new Error(
      `Invalid repo URL: "${url}". Must start with https:// (preferred), ssh://, git://, <user>@<host>:<path> (ssh shortcut — any username), or http:// (not recommended — traffic is unencrypted). Fix with 'think cortex setup' or edit ~/.config/think/config.json.`,
    );
  }
}
