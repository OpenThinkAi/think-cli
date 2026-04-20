# Security policy

## Supported versions

open-think is pre-1.0. Only the latest published version on npm receives security fixes. Run `think update` or `npm update -g open-think` to pick up new releases.

## Reporting a vulnerability

**Do not open a public GitHub issue for security reports.**

Use GitHub's private vulnerability reporting for this repository:

<https://github.com/OpenThinkAi/think-cli/security/advisories/new>

That routes the report directly to the maintainers without any public trace. Include:

- A description of the issue and which component is affected (CLI, cortex sync, curator, update-check, etc.).
- A proof-of-concept or step-by-step reproduction if you have one.
- Your assessment of impact.
- Any suggested fix or mitigation.

### What to expect

- Acknowledgment within **3 business days** of the report landing.
- A triage response within **7 business days** including severity assessment and likely fix timeline.
- Coordinated disclosure: once a fix is published, we'll credit you in the release notes unless you prefer to remain anonymous.

## Threat model

### In scope

- The `think` CLI (all subcommands).
- The cortex sync path — clone, fetch, pull, push, the git wrappers in `src/lib/git.ts`, the sync adapters in `src/sync/`.
- Local storage — SQLite DBs under `~/.think/engrams/`, the config file at `~/.config/think/config.json`, the curator at `~/.think/curator.md`.
- Subprocess invocations — git, npm (used by the update check), launchctl (used by the auto-curate LaunchAgent).
- Input validation on any value that flows from config, CLI arguments, or remote engram content into a subprocess argv or filesystem path.

### Out of scope

- Vulnerabilities in Anthropic's Claude models or the `@anthropic-ai/claude-agent-sdk` package itself — report those directly to Anthropic.
- Attacks that require the attacker to already have write access to your `~/.config/think/` or `~/.think/` directories (the local filesystem is trusted).
- The security properties of any third-party git host you configure as your cortex remote — GitHub, GitLab, a self-hosted server, etc., are your trust anchor for the remote side.
- Reviewer or curator prompt engineering — the quality of AI-generated summaries and memory promotion decisions is a product concern, not a security vulnerability.

### Untrusted content — pulled engrams

The primary residual risk worth naming explicitly:

**Engrams pulled from peer cortexes are untrusted content.** When `think pull <cortex>` or `think cortex pull` fetches memories written by another peer, those memories eventually get fed into your Claude agent via `think recall`, `think curate`, or similar. We take two defensive measures:

1. `wrapData()` in `src/lib/sanitize.ts` escapes `<data>` delimiters so peer content can't close the delimiter block and inject new top-level instructions.
2. A short regex list warns on obvious prompt-injection phrasings ("ignore previous instructions," "override instructions," etc.).

**Neither is a security boundary.** The regex is opportunistic — a malicious peer bypasses with paraphrase, translation, or novel wording. The actual boundary is the system prompt in the agent itself, which instructs the model to treat `<data>` content as inert data, not instructions.

Do not add a cortex peer you don't trust at the same level as any other source of input your AI agent will read.

### Configuration tampering

`~/.config/think/config.json` is written with mode 0600 and contains values that flow into git subprocesses. If an attacker gains write access to that file, they can achieve code execution on the next cortex operation (via the classic `--upload-pack=<cmd>` git CVE class).

We defend against this with two layers:

1. `think cortex setup` validates the repo URL on input — must match `^(https?://|git@host:|ssh://|git://)`, cannot start with `-`.
2. The git wrapper validates repo and branch-name values at every subprocess invocation site and inserts `--` separators where git supports them. A value that smuggled past input validation (because the config file was edited directly) still gets rejected at the subprocess boundary.

Neither layer defends against an attacker who has full write access to your home directory — at that point they could install a trojaned `think` binary directly. The layered validation exists to make less-privileged compromises (a tutorial with a malicious "paste this command" step, a stale onboarding link) unexploitable.

## Known trade-offs

These are intentional design choices, not vulnerabilities:

- **`think curate` invokes Claude with the current cortex's memories.** API costs and content leave your machine for Anthropic. This is the intended product behavior. Set `THINK_NO_UPDATE_CHECK=1` if you want to disable the separate `npm view` network call.
- **`cortex pull` / `push` operates directly on a git remote you configured.** No sandbox, no content review. You're trusting the remote to hold honest data.
- **LaunchAgent auto-curation runs as your user.** No privilege escalation, but any compromise of `~/.think/curator.md` or the cortex DB would run with your permissions.
