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
- The Claude Agent SDK call sites — see [Agent topology](#agent-topology) for the full inventory and the architectural defense (`tools: []` on every call).
- Data flow to external destinations — see [Data destinations](#data-destinations) for the inventory and per-destination retention.

### Out of scope

- Vulnerabilities in Anthropic's Claude models or the `@anthropic-ai/claude-agent-sdk` package itself — report those directly to Anthropic.
- Attacks that require the attacker to already have write access to your `~/.config/think/` or `~/.think/` directories (the local filesystem is trusted).
- The security properties of any third-party git host you configure as your cortex remote — GitHub, GitLab, a self-hosted server, etc., are your trust anchor for the remote side.
- Reviewer or curator prompt engineering — the quality of AI-generated summaries and memory promotion decisions is a product concern, not a security vulnerability.

### Untrusted content — pulled engrams, proxy events, file imports

The primary residual risk worth naming explicitly:

**Engrams pulled from peer cortexes are untrusted content.** When `think pull <cortex>` or `think cortex pull` fetches memories written by another peer, those memories eventually get fed into your Claude agent via `think recall`, `think curate`, or similar. We take two defensive measures:

1. `wrapData()` in `src/lib/sanitize.ts` escapes `<data>` delimiters so peer content can't close the delimiter block and inject new top-level instructions.
2. A short regex list warns on obvious prompt-injection phrasings ("ignore previous instructions," "override instructions," etc.).

**Neither is a security boundary.** The regex is opportunistic — a malicious peer bypasses with paraphrase, translation, or novel wording. The actual boundary is the system prompt in the agent itself, which instructs the model to treat `<data>` content as inert data, not instructions.

**The same opportunistic-warning treatment applies to proxy event payloads and file imports.** As of AGT-059, `validateEngramContent` runs inside the DB write functions (`insertEngram` and `insertMemoryIfNotExists`) rather than only at caller-side edges, so:

- Events arriving via `think subscribe poll` from a configured proxy (GitHub PR/issue webhooks, Linear ticket events, etc.) are length-capped and prompt-injection-scanned before they land as engrams. Warnings surface to stderr in the poll loop.
- Memories migrated via `think cortex migrate` from a legacy git-backed cortex into the local-fs backend get the same scan during import. Warnings batch-print at the end of the migration.

These paths previously bypassed validation entirely. The chokepoint covers them now without requiring every caller to remember to validate first. As with peer-pulled engrams, this is **opportunistic warning, not a security boundary** — paraphrase still bypasses, the agent's system prompt is still the actual line of defense.

Do not add a cortex peer, configure a proxy, or import a file you don't trust at the same level as any other source of input your AI agent will read.

### Configuration tampering

`~/.config/think/config.json` is written with mode 0600 and contains values that flow into git subprocesses. If an attacker gains write access to that file, they can achieve code execution on the next cortex operation (via the classic `--upload-pack=<cmd>` git CVE class).

We defend against this with two layers:

1. Both `think cortex setup` (on input) AND `ensureRepoCloned()` (on read) run the same validator in `src/lib/repo-url.ts` against the allowlist `^(https?://|<user>@<host>:|ssh://|git://)` (case-insensitive; SCP-shortcut accepts any username, matching git's own syntax). Leading `-` rejected separately. A value that only got into `config.json` via direct editing still gets rejected the next time git would be invoked.
2. The git wrapper further guards every subprocess invocation site with leading-hyphen checks on branch names and inserts `--` separators where git supports them. Belt-and-suspenders against any bypass of layer 1.

Neither layer defends against an attacker who has full write access to your home directory — at that point they could install a trojaned `think` binary directly. The layered validation exists to make less-privileged compromises (a tutorial with a malicious "paste this command" step, a stale onboarding link) unexploitable.

## Agent topology

Where the Claude Agent SDK lives in this codebase, what it can and can't do, and why the architecture bounds the blast radius of a malicious model output.

### Six call sites, all `tools: []`

Every `query()` call is gated through `lib/claude-sdk.ts`'s wrapped re-export ([Per-curation data envelope](#per-curation-data-envelope-llm-consent) below) and configured with `tools: []`. That posture is the load-bearing defense: with no tools the model can produce text but cannot invoke a function, write a file, run a shell command, fetch a URL, or escape the context. Output is parsed back into structured memory rows by code we control.

| Module | Command | Purpose |
|---|---|---|
| `lib/curator.ts` | `think curate` | Promote pending engrams to memories |
| `lib/curator.ts` | `think curate --consolidate` | Consolidate older memories into long-term summary |
| `lib/curator.ts` | `think curate --episode <key>` | Synthesize episode engrams into a narrative memory |
| `lib/retro-curator.ts` | `think curate-retros` | Pairwise equivalence judgment for retro dedupe |
| `lib/claude.ts` | `think summary` | AI-generated work-log summaries |
| `commands/long-term.ts` | `think long-term backfill` | Per-month curation of historical memories into long-term events |

Grep for `query({` in `packages/cli/src/` to enumerate; the count and shape will move as the codebase evolves.

A new `query()` call site without `tools: []` would be a security regression. A future contributor adding an agentic feature should land it as a separate ticket with explicit threat-model review.

### Two untrusted-input surfaces

Both feed into the agent path via curation:

1. **Peer-pulled memories.** `cortex pull` / `cortex sync` ingest content authored by other peers. Sanitized via `validateEngramContent` and wrapped with `<data>` delimiters before reaching the model. Treat as untrusted at the same level as any external input. See [Untrusted content — pulled engrams, proxy events, file imports](#untrusted-content--pulled-engrams-proxy-events-file-imports).
2. **`think subscribe poll` events.** Connector-emitted payloads (GitHub webhooks, Linear ticket events, etc.) authored by third parties. Routed through the same `validateEngramContent` chokepoint as peer memories (AGT-059), the baseline PII strip + per-subscription redact selectors (AGT-066), and `wrapData()` delimiters before reaching the curator.

### Four model-output sinks

What the model can produce that lands somewhere persistent:

- `memories` table (curator promotion)
- `long_term_events` table (long-term backfill, consolidation)
- `longterm_summary` (consolidate)
- Episode `memories` rows with `episode_key` set (episode curation)

All four sinks are local SQLite. Model output is parsed via JSON-shaped responses; structurally-malformed output is rejected before any write. The `narrative` field of an episode memory is the only free-form text sink — it lands in the local DB and only reaches outside the machine if the user explicitly syncs that cortex.

Cross-reference: [Threat model — Untrusted content](#untrusted-content--pulled-engrams-proxy-events-file-imports), [Per-curation data envelope](#per-curation-data-envelope-llm-consent).

## Data destinations

User data leaves the local SQLite cortex via these paths. All are gated behind explicit user action (config + invocation); none happen silently on a fresh install.

| Destination | Trigger | Content shipped | Retention story |
|---|---|---|---|
| **Anthropic (Claude API)** | `think curate`, `think curate --consolidate`, `think curate --episode`, `think long-term backfill`, `think curate-retros`, `think summary` | Per-curation envelope (see below) — memories, summaries, engrams, retro pairs | Anthropic's API retention applies; no per-call deletion. Gated by `THINK_LLM_CONSENT` / `cortex.llmConsent` (AGT-065). |
| **Cortex sync remote** (git remote OR fs folder) | `think cortex push`, `think cortex sync`, auto-sync LaunchAgent | Curated memories + long-term events as JSONL. Engrams never leave. | Whatever the remote retains — git history is permanent unless rewritten; iCloud/Dropbox/Syncthing follow their own retention. Memory tombstones do NOT propagate (BLOOM-122). |
| **Subscription proxy** (`think serve` instance) | `think subscribe poll` (CLI → proxy GET /v1/events) | Read-only fetch from the proxy's `events` table — content originated upstream, not from this CLI. | Proxy's SQLite retention; cleanup is operator's responsibility. |
| **npm registry** (update check) | First CLI invocation per 24h | Just an `npm view` HEAD against `@openthink/think` — no cortex content shipped. Disable with `THINK_NO_UPDATE_CHECK=1`. | npm logs the package query (standard registry telemetry). |
| **Audit log** (`~/.local/share/think/sync-audit.log`) | Every export, import, network-send, network-receive | Local-only metadata trail (entry IDs, peer IDs, timestamps, file paths, counts) — NOT the message content itself. | Local file, rotates at 2MB to `sync-audit.log.1`; `think audit prune --before <date>` available (AGT-063). |

Re-audit this inventory whenever a new connector lands on the subscribe surface — a new connector kind expands the third-party-content path and may add a new destination.

## Per-curation data envelope (LLM consent)

`think curate`, `think long-term backfill`, `think curate --episode <key>`, `think curate-retros`, and `think summary` all ship cortex content to Anthropic via the Claude Agent SDK. As of AGT-065, that is **gated behind explicit opt-in** — the CLI fails closed by default and exits with an actionable error pointing at this section.

**Opt in via either:**

```sh
# Environment variable (one-shot or in your shell profile)
export THINK_LLM_CONSENT=1
```

```json
// Persistent config at ~/.config/think/config.json
{
  "cortex": { "llmConsent": true, ... }
}
```

**What ships, per call:**

| Command | Frequency | Envelope shipped |
|---|---|---|
| `think curate` | Manual or auto-curate scheduler (every 5 min when pending engrams exist) | Long-term summary; up to 30 most-recent long-term events; recent memories (last 14 days, capped at `cortex.curatorPromptCharCap` chars — default 50_000); contributor's `~/.think/curator.md`; up to 200 pending engrams. The cap trims recent memories oldest-first when assembled size exceeds it. |
| `think long-term backfill` | Manual, one-time | One Claude call per month of history. Each call ships that month's memories plus a digest of prior batches' proposed events for supersession context. `--dry-run` ships **nothing** (AGT-061). |
| `think curate --episode <key>` | Manual | All engrams tagged with the episode key, plus the existing narrative memory if re-curating. |
| `think curate-retros` | Manual | Pairs of retro candidates (FTS-matched) sent to Claude for equivalence judgment. |
| `think summary` | Manual | Engram entries from the requested time window. Falls back to raw output on consent failure. |

**Auto-curate amplifies frequency.** The LaunchAgent at `~/Library/LaunchAgents/dev.openthink.curate.plist` runs `think curate` every 5 minutes when pending engrams exist. With consent granted, the same envelope ships on every run; without consent the LaunchAgent fails closed and the failure is logged to the agent's log file.

**The prompt cap is a hard ceiling, not a target.** Override per cortex:

```json
{ "cortex": { "curatorPromptCharCap": 25000, ... } }
```

Lowering the cap reduces volume but trims older recent-memory context the curator uses to recognize already-recorded facts. Raising it lets larger cortexes ship more context per call.

## Known trade-offs

These are intentional design choices, not vulnerabilities:

- **Claude Agent SDK consent is opt-in but irreversible per call.** Once consent is granted and a curate run completes, the data has reached Anthropic. There is no per-turn confirmation; the gate is at process entry. If you're working on a sensitive cortex, scope `THINK_LLM_CONSENT` to the shell session rather than committing it to your shell profile, and consider a separate cortex with consent disabled.
- **Memory tombstones do not propagate across sync** — see SyncAdapter contract test `enforceImmutableMemories`. A `think memory delete <id>` removes the row locally; peers retain their copy. Right-to-erasure across machines is architecturally not supported (BLOOM-122 invariant). Use `think pause` to suppress engram creation if you don't want content to land in the first place.
- **`cortex pull` / `push` operates directly on a git remote you configured.** No sandbox, no content review. You're trusting the remote to hold honest data.
- **LaunchAgent auto-curation runs as your user.** No privilege escalation, but any compromise of `~/.think/curator.md` or the cortex DB would run with your permissions.
