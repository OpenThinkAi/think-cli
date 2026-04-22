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

// Parse any accepted repo URL into (host, path) so callers can decide two URLs
// point at the same repo despite transport differences. Returns null when the
// input doesn't match a known shape — callers fall back to strict comparison.
function parseRepoUrl(url: string): { host: string; path: string } | null {
  if (!url) return null;
  let host: string;
  let path: string;

  const scp = url.match(/^[\w.-]+@([^:\s]+):(.+)$/);
  if (scp) {
    host = scp[1];
    path = scp[2];
  } else {
    const withScheme = url.match(/^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/\s]+)\/(.+)$/i);
    if (!withScheme) return null;
    host = withScheme[1];
    path = withScheme[2];
  }

  path = path.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  return { host: host.toLowerCase(), path };
}

// Two remote URLs are equivalent when they resolve to the same host and path,
// ignoring transport (ssh vs https), `.git` suffix, trailing slashes, and
// userinfo. Falls back to strict equality if either URL can't be parsed.
export function repoUrlsEquivalent(a: string, b: string): boolean {
  if (a === b) return true;
  const pa = parseRepoUrl(a);
  const pb = parseRepoUrl(b);
  if (!pa || !pb) return false;
  return pa.host === pb.host && pa.path === pb.path;
}
