# Security TODO

Pending hardening work identified in a pre-distribution audit of `open-think` (think-cli). The audit was run on 2026-04-19 against commit `a5750d0` (v0.4.1). Line numbers in this doc reference that commit; verify against `main` before editing — several files have churned since then.

Everything in this document is actionable in one PR, roughly 20–40 lines of real changes. Nothing is blocked on external review or design.

---

## Before you start

1. Pull latest `main` and re-verify line numbers with:
   ```bash
   grep -n "runGit\|execFileSync('git'" src/lib/git.ts
   grep -n "engramsDir\|\.db" src/commands/cortex.ts
   ```
2. Re-read `src/lib/git.ts` and `src/commands/cortex.ts` end-to-end. The fixes are spread across these two files almost entirely.
3. The audit also declared a number of things **already hardened** (see "Verified clean" at the bottom). Do not re-do those — they're listed so you know what to leave alone.

---

## Priority 1 — HIGH: git argument-injection (`--upload-pack` CVE class)

### What

Several `git` invocations in `src/lib/git.ts` pass config- or caller-controlled strings as positional arguments without a `--` separator. If any of those values begins with `--`, git interprets it as an option. The classic weaponization is `--upload-pack=<shell command>`, which executes when git connects to a remote. That's an RCE in this process.

### Why it matters

The "user" supplying these values isn't always a human typing at a prompt. `config.cortex.repo` is stored in `~/.config/think/config.json` and written verbatim from whatever `think cortex setup` accepts (no shape check, see Priority 2). An attacker who can get a malicious string into that config — via a tutorial, a "paste this to join our cortex" link, a compromised onboarding flow, or direct tampering — can achieve code execution the next time the user runs any command that touches the remote.

Exploitability for branch-name positionals is more limited today because cortex branch names flow through `sanitizeName()` in `src/lib/paths.ts:12` (alphanumeric + `-_` only, no `..`, non-empty). But that's a single guard-rail; we want defense-in-depth because:
- `config.cortex.active` is read and used as a branch name in several places, and it's also written to config without re-validation.
- Direct config.json tampering (e.g. `"active": "--upload-pack=..."`) bypasses the create-path sanitization entirely.

### The fix

For every git invocation that takes a user- or config-sourced positional argument, insert `--` immediately before the first such positional. Git guarantees that everything after `--` is treated as a positional, not a flag.

**Affected call sites in `src/lib/git.ts`** (line numbers as of `a5750d0`):

| Line | Call | Controlled value | Required change |
|------|------|------------------|-----------------|
| 59 | `execFileSync('git', [..., 'clone', '--no-checkout', config.cortex.repo, repoPath], ...)` | `config.cortex.repo` | `'clone', '--no-checkout', '--', config.cortex.repo, repoPath` |
| 68 | `runGit(['ls-remote', '--exit-code', '--heads', 'origin', branchName])` | `branchName` | `'ls-remote', '--exit-code', '--heads', 'origin', '--', branchName` (note: `--` after `origin` is OK for `ls-remote`; double-check against `git ls-remote --help` on your system) |
| 76 | `runGit(['checkout', '--orphan', branchName])` | `branchName` | `'checkout', '--orphan', '--', branchName` |
| 87 | `runGit(['push', '--set-upstream', 'origin', branchName])` | `branchName` | `'push', '--set-upstream', 'origin', '--', branchName` |
| 91 | `runGit(['fetch', 'origin', branchName])` | `branchName` | `'fetch', 'origin', '--', branchName` |
| 113 | `runGit(['switch', branchName])` | `branchName` | `'switch', '--', branchName` |
| 115 | `runGit(['switch', '-c', branchName, \`origin/${branchName}\`])` | `branchName` | `'switch', '-c', '--', branchName, \`origin/${branchName}\`` (but verify `-c` still binds — you may need to construct as `'switch', '-c', branchName, '--', \`origin/${branchName}\`` or restructure; read `git switch --help`) |
| 119 | `runGit(['pull', '--rebase', 'origin', branchName])` | `branchName` | `'pull', '--rebase', 'origin', '--', branchName` |
| 138 | `runGit(['push', 'origin', branchName])` | `branchName` | `'push', 'origin', '--', branchName` |
| 144 | `runGit(['pull', '--rebase', 'origin', branchName])` | `branchName` | `'pull', '--rebase', 'origin', '--', branchName` |
| 183 | `runGit(['switch', branchName])` | `branchName` | `'switch', '--', branchName` |
| 184 | `runGit(['switch', '-c', branchName, \`origin/${branchName}\`])` | `branchName` | same caveat as line 115 |
| 190 | `runGit(['pull', '--rebase', 'origin', branchName])` | `branchName` | `'pull', '--rebase', 'origin', '--', branchName` |
| 206 | `runGit(['push', 'origin', branchName])` | `branchName` | `'push', 'origin', '--', branchName` |
| 216 | `runGit(['pull', '--rebase', 'origin', branchName])` | `branchName` | `'pull', '--rebase', 'origin', '--', branchName` |

**Caveats on `--` placement:**

Not every git subcommand accepts `--` in the same position. In particular, `git switch -c <new-branch> <start-point>` with a `--` separator needs the separator placed such that git still pairs `-c` with its argument. Test each change with a real branch name to confirm git still parses it. If a particular subcommand won't accept `--` cleanly, fall back to a direct guard in `runGit` — reject any positional argument (not prefixed with `-`) that itself starts with `-`.

**Lines that also interpolate `branchName` but are lower risk** (included for completeness; fix if trivial, skip if it complicates things):

- Line 96: `runGit(['show', \`origin/${branchName}:${filePath}\`])` — single composed argument; `--` doesn't help, but consider validating that `branchName` and `filePath` have no `\n`, `;`, or `:` in unexpected places.
- Line 150: `runGit(['log', '--oneline', \`origin/${branchName}\`, '--', filePath])` — already has `--` for `filePath`; `branchName` is interpolated into a ref, so the `-` prefix risk doesn't apply (git would read `origin/--foo` as a ref name, not a flag).
- Line 163: `runGit(['ls-tree', '--name-only', \`origin/${branchName}\`])` — same logic as line 150.

### Test case

Add a unit test (or ad-hoc script) that sets `config.cortex.repo = '--upload-pack=echo PWNED'`, runs `ensureRepoCloned()`, and asserts the process does not print `PWNED`. Similarly test with `config.cortex.active = '--upload-pack=echo PWNED'` and call any flow that does `pull --rebase origin <active>`.

---

## Priority 2 — HIGH: validate `config.cortex.repo` on input

### What

`src/commands/cortex.ts:32-34` — `think cortex setup` prompts for a git remote URL and writes whatever the user types to `config.cortex.repo`. No shape check, no prefix check, no rejection of leading `-`.

### The fix

In the `setup` action in `src/commands/cortex.ts`, after collecting `repo` from the argument or prompt, validate it before calling `saveConfig`:

```ts
function validateRepoUrl(url: string): void {
  if (!url) return; // empty is valid — offline-only mode
  if (url.startsWith('-')) {
    throw new Error(`Invalid repo URL: starts with '-'. URLs cannot begin with a hyphen.`);
  }
  const allowed = /^(https?:\/\/|git@[^:\s]+:|ssh:\/\/|git:\/\/)/;
  if (!allowed.test(url)) {
    throw new Error(
      `Invalid repo URL: "${url}". Must start with https://, http://, git@host:, ssh://, or git://.`,
    );
  }
}
```

Call it immediately after the user supplies the value, before `config.cortex.repo = repo`. Surface the error message and re-prompt (or exit 1) — don't silently persist invalid input.

Also worth considering: validate the same way when `config.cortex.repo` is **read** (in `getConfig()` or in `ensureRepoCloned()` at `src/lib/git.ts:44`), so a config file that was tampered with directly still gets rejected. A single `validateRepoUrl` called at read-time covers both input paths.

---

## Priority 3 — MEDIUM: `dbPath` bypasses `sanitizeName`

### What

`src/commands/cortex.ts:177-178`:

```ts
const engramsDir = getEngramsDir();
const dbPath = `${engramsDir}/${name}.db`;
```

`name` is the argument to `cortex switch`, passed through unchanged. Everywhere else in the codebase, engram DB paths go through `getEngramDbPath()` in `src/lib/paths.ts:47`, which calls `sanitizeName()`. This one site skips it.

**Why it's medium, not high**: there's no malicious `.db` file sitting on disk unless someone went through `cortex create`, which does sanitize. And `fs.existsSync` on a path with `..` segments won't execute anything. But defense-in-depth matters — a future refactor that adds actual file ops to this code path would inherit the hole.

### The fix

Replace the manual path construction at `src/commands/cortex.ts:178` with:

```ts
import { getEngramDbPath } from '../lib/paths.js';
// ...
const dbPath = getEngramDbPath(name);
```

This reuses the already-sanitizing helper. `sanitizeName` throws on invalid input, which is the right behavior — let the error propagate and print a readable message.

Audit the rest of `src/commands/cortex.ts` for any other sites that build engram paths manually. The one at line 178 is the only one the audit found, but confirm with `grep -n "engramsDir\|\\.db" src/commands/cortex.ts`.

---

## Priority 4 — MEDIUM: document the limits of prompt-injection defense

### What

`src/lib/sanitize.ts` uses a 9-entry regex list of English-language patterns (`ignore previous instructions`, `override instructions`, etc.) and a `wrapData()` helper that escapes `<data>` tags. The regex is opportunistic warning, not a security boundary. The actual boundary is the system prompt in `src/agent/claude.ts` and `src/agent/curator.ts` (verify exact paths) telling the model to treat `<data>` content as inert.

### Why it matters

Downstream users of open-think — especially anyone consuming pulled engrams from a peer's cortex — may assume the regex is a filter that makes peer-content safe. It isn't. A malicious peer can trivially bypass with paraphrase, translation, or novel phrasing.

### The fix

Add an explicit note to:

1. `README.md` — a new "Security model" section near the bottom, or a brief callout in any "cortex pull" / "peering" section if one exists.
2. A new `SECURITY.md` at the repo root (see Priority 5 — the two overlap; do them together).

Suggested language:

> **Pulled engrams from peers are untrusted content.** We escape `<data>` delimiters and pattern-match some obvious injection attempts, but agentic prompt injection from a malicious peer is a residual risk. Treat a cortex peer with the same trust level you'd give any source of data your AI agent will read — do not add a cortex peer you don't trust.

---

## Priority 5 — LOW

### 5a. No `SECURITY.md`

Standard expectation for a public, security-adjacent tool distributed on npm. Create `SECURITY.md` at repo root. Cover:
- How to report vulnerabilities (email? private GitHub advisory?)
- Supported versions (probably just "latest" for now)
- Threat model summary (what is and isn't in scope — e.g. "we assume the local machine is trusted; we do not assume peer cortexes are trusted")
- Link to or inline the Priority 4 disclaimer.

### 5b. Add `THINK_NO_UPDATE_CHECK=1` escape hatch

`src/lib/update-check.ts:69` spawns `npm view open-think version` in the background on a 24h cadence. Hardcoded args — safe from injection. But it makes an outbound network call, which is not desirable in all environments (air-gapped machines, corporate networks that care, privacy-minded users).

Add an env-var bypass at the top of `checkForUpdate()`:

```ts
export function checkForUpdate(): string | null {
  if (process.env.THINK_NO_UPDATE_CHECK === '1') return null;
  // ... rest unchanged
}
```

Document the flag in README.

### 5c. Asymmetric conflict handling in `appendAndCommit` retry loop

`src/lib/git.ts:136-146`:

```ts
for (let attempt = 1; attempt <= maxRetries; attempt++) {
  try {
    runGit(['push', 'origin', branchName]);
    return;
  } catch {
    if (attempt === maxRetries) { throw ... }
    runGit(['pull', '--rebase', 'origin', branchName]);
  }
}
```

Compare to the earlier pull at line 118-128, which catches `CONFLICT`/`could not apply` and calls `rebase --abort` before throwing. The retry-loop pull at line 144 has no such guard — a rebase conflict inside the retry loop would leave the working tree in a "rebase-in-progress" state, and the next `push` attempt would either fail (good) or succeed with polluted state (bad, but unlikely with append-only files).

Fix: extract the conflict-handling block from lines 120-127 into a helper (`function pullRebaseOrAbort(branchName: string)`) and call it from both sites. Append-only semantics make the real-world risk tiny, but the code should be consistent.

---

## Verified clean (do not re-do these)

The audit explicitly confirmed these were already handled correctly. Mentioned here so you know what's already tight and don't waste time on it:

- `safeGitEnv()` in `src/lib/git.ts:9` strips every dangerous git env var (`GIT_SSH_COMMAND`, `GIT_PROXY_COMMAND`, `GIT_ASKPASS`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, `GIT_WORK_TREE`, `GIT_DIR`, `GIT_EXEC_PATH`) and sets `GIT_CONFIG_NOSYSTEM=1`, `GIT_TEMPLATE_DIR=''`.
- Every git call injects `-c core.hooksPath=/dev/null -c core.fsmonitor=` — neutralizes CVE-2024-32002-class hook-execution-on-clone attacks.
- All git invocations use `execFileSync` with an argv array — no shell interpolation anywhere.
- All SQL uses prepared statements with `?` placeholders.
- `wrapData()` in `src/lib/sanitize.ts` correctly escapes `<data>` delimiters to prevent block injection.
- `config.json` is written with mode `0600`, parent dir `0700`.
- Git history has been scanned for `BEGIN PRIVATE KEY`, `sk-ant`, `ghp_` — zero hits.
- Dev-loop artifacts (`LOG.raw.jsonl`, `PROMPT.md`, `QUEUE.md`, `STATUS.md`, `run.sh`, `design-drafts/`) are gitignored and verified never committed (via `git log --diff-filter=A`).
- LaunchAgent plist generation uses `escapeXml` on every interpolated value.
- `docs/` static site has no leaked credentials, emails, or paths.

---

## Verification checklist before opening the PR

- [ ] `npm run build` succeeds
- [ ] Existing tests still pass
- [ ] New test: `config.cortex.repo = '--upload-pack=...'` does not execute the injected command
- [ ] New test: `validateRepoUrl` rejects values starting with `-` and values not matching the allowed prefix list
- [ ] `think cortex setup` with a valid URL still works end-to-end (clone a real repo)
- [ ] `think cortex switch <nonexistent>` still produces a readable error (path goes through `getEngramDbPath` which throws on invalid names)
- [ ] `think cortex pull` / `push` / `sync` against a real remote still works
- [ ] `README.md` has the security-model note
- [ ] `SECURITY.md` exists at repo root
- [ ] `THINK_NO_UPDATE_CHECK=1 think <any-command>` — confirm no `npm view` subprocess spawns

---

## Scope guardrails

- **Don't** rewrite `runGit` to parse arguments. Adding `--` at call sites is lower-risk and easier to review.
- **Don't** rename or export `sanitizeName` just to call it at more sites — use the existing `getEngramDbPath` helper instead.
- **Don't** expand the `SUSPICIOUS_PATTERNS` regex list. It's best-effort warning and not worth the churn. The docs fix (Priority 4) is the right response, not regex-hardening.
- **Don't** bundle unrelated refactors. This PR is "close a CVE class + two mediums + a couple of low-effort wins." Keep it surgical.

---

## References

- Audit source: agent audit run 2026-04-19 against `a5750d0` (v0.4.1), findable via `think recall "think-cli security audit git argument injection"`
- Related CVE class: `CVE-2024-32002` (git clone hook execution — already mitigated via `core.hooksPath=/dev/null`, mentioned for context)
- `--upload-pack` injection technique: well-known git CVE pattern. See any recent writeup on git option-injection via config-controlled URLs.
