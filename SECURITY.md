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
- Local storage — SQLite DBs under `~/.think/index/`, the git-backed L1 store under `~/.think/repo/`, the config file at `~/.config/think/config.json`.
- Subprocess invocations — git, npm (used by the update check), launchctl (used by the daemon LaunchAgent and `think subscribe install-agent`).
- Input validation on any value that flows from config, CLI arguments, or remote memory content into a subprocess argv or filesystem path.
- The LLM call sites (Agent SDK and direct Messages API) — see [Agent topology](#agent-topology) for the full inventory and the architectural defense (no agentic tool access, with one deliberate, allowlisted exception).
- Data flow to external destinations — see [Data destinations](#data-destinations) for the inventory and per-destination retention.

### Out of scope

- Vulnerabilities in Anthropic's Claude models or the `@anthropic-ai/claude-agent-sdk` package itself — report those directly to Anthropic.
- Attacks that require the attacker to already have write access to your `~/.config/think/` or `~/.think/` directories (the local filesystem is trusted).
- The security properties of any third-party git host you configure as your cortex remote — GitHub, GitLab, a self-hosted server, etc., are your trust anchor for the remote side.
- Reviewer or curator prompt engineering — the quality of AI-generated summaries and memory promotion decisions is a product concern, not a security vulnerability.

### Untrusted content — pulled memories, proxy events, file imports

The primary residual risk worth naming explicitly:

**Memories pulled from peer cortexes are untrusted content.** When `think pull <cortex>` or `think cortex pull` fetches memories written by another peer, those memories eventually get fed into your Claude agent via `think recall`, or into an LLM call the daemon makes on your behalf (write-time compaction, retro supersession, `think summary`, `think dashboard`, `think long-term backfill`, `think curate-retros`). We take three defensive measures:

1. `wrapData()` in `src/lib/sanitize.ts` escapes `<data>` delimiters so peer content can't close the delimiter block and inject new top-level instructions.
2. A short regex list warns on obvious prompt-injection phrasings ("ignore previous instructions," "override instructions," etc.).
3. `think recall` wraps each entry in `<recall-result cortex="..." kind="..." id="...">` delimiters when stdout is non-TTY or `--for-agent` is set, so peer-authored content reaches the downstream agent as bounded data rather than free-floating text. Literal `<recall-result` / `</recall-result` substrings inside entry content are HTML-escaped at render time so a crafted memory cannot break out of the envelope. Cross-reference [Agent topology / Two untrusted-input surfaces](#two-untrusted-input-surfaces) which already names peer-pulled memories as the relevant surface.
4. `think recall` derives and emits a `provenance` tag for every entry — `self` (your cortex), `peer:<name>` (a locally-cloned peer cortex), `proxy:<connector>` (an external subscription source like GitHub or Linear), or `unknown` (unclassifiable). The tag appears as a `[provenance]` bracket in human-readable output and as a `provenance="..."` attribute on the `<recall-result>` envelope (AGT-465). This lets a downstream agent — and a human reader — see at a glance where each piece of content originated. Combined with `--source` / `--exclude-source` filtering, a consuming agent can, for example, restrict a sensitive task to `self`-sourced entries or drop all `proxy:*` content before acting on it.
5. `think recall` classifies every entry into a **trust tier** based on the user's configured `cortex.trustTiers.rules` policy (AGT-466). The default shipped rules: `self → trusted`, everything else → `untrusted`. Nothing is `quarantined` by default. Quarantined entries are silently excluded from recall output by default — they never enter the model's context unless `--include-quarantined` is explicitly passed. See [Trust tiers: labelling-plus-policy, still opportunistic](#trust-tiers-labelling-plus-policy-still-opportunistic) below for the full details and explicit caveats.

**None of these is a security boundary.** The regex is opportunistic — a malicious peer bypasses with paraphrase, translation, or novel wording. The `<recall-result>` wrap only helps a consuming agent that has been instructed (by its own system prompt) to treat `<recall-result>` blocks as inert data; if the downstream agent has no such instruction, the wrap provides zero protection. The actual boundary is the system prompt in the agent itself, which instructs the model to treat delimited content as inert data, not instructions.

The provenance tag carries the same opportunistic-warning caveat:

- The tag is derived from two locally-persisted fields: the entry's `cortex` name and its `episode_key` (stamped by the proxy's terminal-event curator when it publishes a memory to the team cortex, e.g. `github:owner/repo#123`). Both fields are inside your own `~/.think/` storage, so trusting them requires the same trust level you already extend to your local cortex contents.
- **`peer:` tells you origin, not intent.** A malicious peer who has sync access could write a row claiming a benign-sounding cortex name. The `peer:` tag is honest about where the data came from (a cortex that differs from yours), but it is not a judgment about the author's trustworthiness.
- **`proxy:` is the highest-fidelity tag** because the connector kind (the part after `proxy:`) is set by your local subscribe code on a key the proxy server does not control — a GitHub proxy can't make its entries appear as `proxy:linear`. But a malicious proxy *can* craft arbitrary content within its own connector's entries; `proxy:github` means "arrived via the github connector," not "safe to trust."
- **`unknown` means unclassifiable**, not "untrusted by exception." It surfaces when `cortex.active` is unset (no active cortex configured), so the system can't distinguish self from peer. Under the AGT-466 trust tier system, `unknown` provenance resolves to `untrusted` by default (via the implicit `* → untrusted` fail-safe rule).

The actual security boundary remains the consuming agent's own system prompt, which must instruct the model to treat `<recall-result>` blocks as inert data regardless of provenance tag. Provenance tagging (AGT-465) is the labelling layer; trust tiers (AGT-466) are the policy layer built on top of it. See [Trust tiers: labelling-plus-policy, still opportunistic](#trust-tiers-labelling-plus-policy-still-opportunistic) for the full treatment.

**The same opportunistic-warning treatment applies to imports.** As of AGT-059, `validateEngramContent` (the function keeps its original name; it validates any entry content on its way into a cortex, not a specific write tier) runs both at caller-side edges (`commands/memory.ts`, `commands/log.ts`, `commands/event.ts`, `commands/import.ts`) and inside the shared DB write path (`insertMemoryIfNotExists` in `db/memory-queries.ts`) and the sync adapters (`git-adapter.ts`, `local-fs-adapter.ts`, `hub-adapter.ts`), so:

- Memories arriving via `cortex pull` / `cortex sync` from any adapter (git, local-fs, or hub) are length-capped and prompt-injection-scanned before they land locally.
- Memories imported with `think import` and memories migrated via `think cortex migrate` (from a git-backed cortex into the local-fs backend) get the same scan. Warnings surface to stderr (batch-printed at the end for a migration or import run).

**`think subscribe poll` no longer has a local write path to scan.** It used to feed proxy events into a local pre-daemon DB via `insertEngram`, redacted and validated on the way in. That local ingestion path is gone — `think subscribe poll` is now a deprecated no-op that prints a pointer to `think pull <team-cortex>`, and `--legacy-engrams` exits non-zero with a removal note rather than doing anything. The proxy (`think serve`) curates connector events centrally and publishes memories straight into the team-shared cortex (see [`packages/cli/docs/serve.md`](packages/cli/docs/serve.md#team-shared-cortex-where-proxy-curated-memories-land)); that server-side path wraps the event payload in `<data>` tags before the LLM call but does **not** run `validateEngramContent`'s length-cap/regex scan or the CLI-side redaction selectors described in `serve.md` — those became dead code when proxy-curated events (AGT-389) replaced local polling, and 3.0.0 only formalized that by removing the flag that used to drive it. If you rely on a proxy source you don't fully trust, treat every row the team cortex pulls in as unfiltered third-party content.

These caller + DB-layer chokepoints mean validation does not depend on every future caller remembering to run it first. As with peer-pulled memories, this is **opportunistic warning, not a security boundary** — paraphrase still bypasses, the agent's system prompt is still the actual line of defense.

Do not add a cortex peer, configure a proxy, or import a file you don't trust at the same level as any other source of input your AI agent will read.

### Trust tiers: labelling-plus-policy, still opportunistic

AGT-466 added a configurable trust tier layer on top of AGT-465's provenance labels. Every recall entry is classified as `trusted`, `untrusted`, or `quarantined` based on the user's `cortex.trustTiers.rules` list in config (first-match-wins, implicit final rule `* → untrusted`). Default shipped rules: `self → trusted`, everything else → `untrusted`.

**What trust tiers DO:**

- **Reduce attack surface.** `quarantined` entries are excluded from `think recall` output by default. A quarantined entry never enters the model's context unless the user explicitly passes `--include-quarantined`. This shrinks the prompt-injection surface for operators who have proxy sources they want to contain.
- **Label entries declaratively.** Every `<recall-result>` envelope now carries a `trust="..."` attribute alongside `provenance="..."`, so a downstream agent can branch on tier (e.g., refuse to act on `untrusted` entries without human confirmation) if its system prompt instructs it to.
- **Provide a policy knob.** Operators can configure fine-grained rules: quarantine all `proxy:github` entries while allowing `proxy:linear` and `peer:*` through as `untrusted` (the default), for example.

**What trust tiers do NOT do:**

- **Do not authenticate authorship.** A `trusted` tier on a `self` entry means the entry's `cortex` field matches your active cortex — it does not mean you authored the content, or that a previous sync didn't inject a malicious row. Trust tiers are built on provenance labels, and provenance labels are locally-derived heuristics, not cryptographic guarantees.
- **Do not validate content.** A `trusted` entry can still contain a prompt injection written by a prior model run or a malicious sync. Tier classification does not parse, sanitize, or verify entry content.
- **Do not block paraphrase.** The quarantine tier prevents a known-quarantined entry from entering the context. A malicious actor who can inject an entry into a non-quarantined source (e.g., a `peer:*` cortex you have not quarantined) bypasses quarantine entirely. This is the same opportunistic-warning caveat that applies to the regex scan and the `<recall-result>` delimiter.
- **Do not change the actual security boundary.** The real line of defense is the consuming agent's own system prompt, which must instruct the model to treat `<recall-result>` blocks as inert data regardless of the `trust="..."` attribute. Tiers reduce what the prompt sees; they do not change what the prompt must do with what it sees.

**Relationship to AGT-465 provenance labels:**

AGT-465 (provenance labelling) is the *labelling layer*: it derives `self`, `peer:*`, `proxy:*`, or `unknown` from locally-persisted fields and carries it through the recall pipeline. AGT-466 (trust tiers) is the *policy layer* built on top: it maps each provenance class to a tier via the configured `trustTiers.rules` list, then gates visibility at recall and curation boundaries. The two are orthogonal — a user can use `--source` / `--exclude-source` (provenance) and `--trust-tier` / `--exclude-trust-tier` (tier) independently. At the post-rerank filter site the order is: source filter → quarantine drop → tier filter.

**The default is deliberately conservative but backward-compatible.** The default tier for everything except `self` is `untrusted` (not `quarantined`) — if the default were `quarantined`, every existing user's peer/proxy entries would silently disappear from recall after upgrading, which is a backward-compat catastrophe. `untrusted` preserves recall behaviour while still distinguishing "yours" from "everyone else's" for any future policy layer a downstream agent wants to apply. Nothing is `quarantined` unless the user explicitly writes a rule.

**Silent-drop with a stderr count.** When entries are dropped because they are quarantined and `--include-quarantined` was not passed, think emits a single informational line to stderr (not stdout): `note: dropped N quarantined entries; pass --include-quarantined to surface`. The entry *content* is never in this line — surfacing quarantined content even as a marker defeats the tier's purpose. The stderr count is the compromise: it tells a user they configured something without re-injecting the untrusted text.

**In summary:** trust tiers are a useful reduce-attack-surface knob that an operator can layer onto an already-defended pipeline. They are not, and must never be described as, a security boundary.

### Configuration tampering

`~/.config/think/config.json` is written with mode 0600 and contains values that flow into git subprocesses. If an attacker gains write access to that file, they can achieve code execution on the next cortex operation (via the classic `--upload-pack=<cmd>` git CVE class).

We defend against this with two layers:

1. Both `think cortex setup` (on input) AND `ensureRepoCloned()` (on read) run the same validator in `src/lib/repo-url.ts` against the allowlist `^(https?://|<user>@<host>:|ssh://|git://)` (case-insensitive; SCP-shortcut accepts any username, matching git's own syntax). Leading `-` rejected separately. A value that only got into `config.json` via direct editing still gets rejected the next time git would be invoked.
2. The git wrapper further guards every subprocess invocation site with leading-hyphen checks on branch names and inserts `--` separators where git supports them. Belt-and-suspenders against any bypass of layer 1.

Neither layer defends against an attacker who has full write access to your home directory — at that point they could install a trojaned `think` binary directly. The layered validation exists to make less-privileged compromises (a tutorial with a malicious "paste this command" step, a stale onboarding link) unexploitable.

## Agent topology

Where LLM calls live in this codebase, what they can and can't do, and why the architecture bounds the blast radius of a malicious model output. Every LLM-backed operation routes through the provider registry (`lib/llm/router.ts`), which resolves to one of two transports on the Anthropic client (`lib/llm/anthropic.ts`) — an equivalent no-tools posture on any configured OpenAI-compatible provider — plus exactly one operation that deliberately runs an agentic loop.

### Two no-agentic-capability transports

- **Agent SDK, `tools: []`.** The default transport for `curate-retros` (retro dedupe), `think summary`, `think dashboard`'s panel summaries, `think long-term backfill`, and the proxy's terminal-event curation (`lib/curator.ts`, driving `think serve`'s connector pipeline — see [`packages/cli/docs/serve.md`](packages/cli/docs/serve.md)). Every call goes through `lib/claude-sdk.ts`'s wrapped re-export of `query()`, configured with `tools: []`: with no tools the model can produce text but cannot invoke a function, write a file, run a shell command, fetch a URL, or escape the context. Output is parsed back into structured rows by code we control.
- **Raw Anthropic Messages API, forced `tool_use` as a JSON-schema enforcer.** The daemon's write-time compaction and retro supersession workers (`daemon/compaction/call.ts`, `daemon/supersession/call.ts`) bypass the Agent SDK entirely and call `@anthropic-ai/sdk` directly with `strictSchema: true`, so the API validates the output shape server-side instead of the model self-reporting valid JSON. The "tool" here is a schema definition the model fills in, not an invokable capability — there is no MCP server, no shell, no file access on this path either. Because this transport bypasses the Agent SDK's own consent wrapper, `lib/llm/anthropic.ts` calls `requireLlmConsent()` explicitly before every strict-schema request so the gate still applies.

Grep for `query({` and `strictSchema: true` in `packages/cli/src/` to enumerate call sites; the count and shape will move as the codebase evolves. A new call site with either transport that grants tool access, or a strict-schema call that skips the explicit consent check, would be a security regression — land it as a separate ticket with explicit threat-model review.

### The one exception: `think dashboard`'s `ask`

`answerThinkQuestion` (`lib/claude.ts`) is genuinely agentic: a multi-turn Agent SDK loop (`maxTurns`, default 16) that calls MCP tools before producing an answer. It is not selectable via `cortex.llm.operations` and stays on Anthropic regardless of any configured local provider (an OpenAI-compatible tool-calling loop is a real feature, not a port; `mlx_lm.server` also crashes on a `tools` field). The defense here is an explicit **allowlist**, not `tools: []`: only `mcp__think__think_recall` and `mcp__think__think_expand` are granted by default (both read-only), plus whatever MCP servers and tools the operator explicitly configures for the dashboard. A misconfigured allowlist naming a write-capable tool is the risk to watch on this one path; everything else in this section has no tool surface to misconfigure.

### Two untrusted-input surfaces

1. **Peer-pulled memories.** `cortex pull` / `cortex sync` ingest content authored by other peers. Sanitized via `validateEngramContent` and wrapped with `<data>` delimiters before reaching the model. Treat as untrusted at the same level as any external input. See [Untrusted content — pulled memories, proxy events, file imports](#untrusted-content--pulled-memories-proxy-events-file-imports).
2. **Connector-emitted proxy events.** GitHub/Linear/Notion/Slack payloads authored by third parties, curated server-side by `think serve`'s terminal-event curator and wrapped in `<data>` tags before the LLM call. This path does **not** run `validateEngramContent`'s length-cap/regex scan — see the note in [Untrusted content — pulled memories, proxy events, file imports](#untrusted-content--pulled-memories-proxy-events-file-imports) on why the older CLI-side scan no longer applies here.

### Model-output sinks

What the model can produce that lands somewhere persistent, per operation:

- `memories` table — write-time compaction (a compacted `kind=memory` row), the proxy's terminal-event curation (`writeMemoriesForEvent` appends JSONL directly to the team cortex, bypassing the local DB).
- `retros` table (`tombstone_reason`, `promoted`, `topics`) — retro supersession (marks a superseded retro tombstoned) and `curate-retros`' merge/promote/relegate passes.
- `long_term_events` table — `think long-term backfill`.

Model output is parsed via JSON-shaped responses (or a server-enforced tool schema on the strict-schema transport); structurally-malformed output is rejected before any write rather than retried with a laxer parse. A curated memory only reaches outside the machine if the user explicitly syncs that cortex (or, for proxy-curated memories, whenever the operator has wired `think serve` to a git remote).

Cross-reference: [Threat model — Untrusted content](#untrusted-content--pulled-memories-proxy-events-file-imports), [Per-curation data envelope](#per-curation-data-envelope-llm-consent).

## Data destinations

User data leaves the local SQLite cortex via these paths. All are gated behind explicit user action (config + invocation); none happen silently on a fresh install.

| Destination | Trigger | Content shipped | Retention story |
|---|---|---|---|
| **Configured LLM provider** (Anthropic by default; any OpenAI-compatible endpoint via `cortex.llm`) | Write-time compaction, retro supersession, `think curate-retros`, `think long-term backfill`, `think summary`, `think dashboard` | Per-operation envelope (see [Per-curation data envelope](#per-curation-data-envelope-llm-consent)) — memories, retro pairs, connector event payloads | Anthropic's API retention applies for that provider; a self-hosted provider's retention is whatever you configured it with. Gated by `THINK_LLM_CONSENT` / `cortex.llmConsent` for any off-machine provider (AGT-065); loopback providers need no consent. |
| **Cortex sync remote** (git remote OR fs folder) | `think cortex push`, `think cortex sync`, the daemon's own push-debouncer/pull-loop | Memories, long-term events and retros as JSONL. The legacy write-tier table (read-only, migration-only) is never synced. | Whatever the remote retains — git history is permanent unless rewritten; iCloud/Dropbox/Syncthing follow their own retention. Memory tombstones do NOT propagate (BLOOM-122). |
| **Connector sources** (GitHub, Linear, Notion, Slack — via a `think serve` instance) | The proxy's per-subscription poll scheduler, running on whatever host operates `think serve` — not the local `think` CLI | Read requests against each connector's API using the stored credential; the returned event payload is stored and curated server-side, then published to the team cortex, which reaches this CLI as an ordinary `cortex pull`. | See [`SECURITY-serve.md`](packages/cli/SECURITY-serve.md) for the proxy's own threat model (credential-at-rest, connector egress). |
| **npm registry** (update check) | First CLI invocation per 24h | Just an `npm view` HEAD against `@openthink/think` — no cortex content shipped. Disable with `THINK_NO_UPDATE_CHECK=1`. | npm logs the package query (standard registry telemetry). |
| **Audit log** (`~/.local/share/think/sync-audit.log`) | Every export, import, network-send, network-receive | Local-only metadata trail (entry IDs, peer IDs, timestamps, file paths, counts) — NOT the message content itself. | Local file, rotates at 2MB to `sync-audit.log.1`; `think audit prune --before <date>` available (AGT-063). |

Re-audit this inventory whenever a new connector lands on the subscribe surface — a new connector kind expands the third-party-content path and may add a new destination.

## Per-curation data envelope (LLM consent)

Write-time compaction, retro supersession, `think curate-retros`, `think long-term backfill`, `think summary`, `think dashboard`'s panel summaries, and the proxy's terminal-event curation all ship cortex content to an LLM. As of AGT-065, that is **gated behind explicit opt-in** for any provider that leaves the machine — the operation fails closed by default (compaction and supersession skip silently and leave the entry uncompacted / unchecked rather than erroring at a terminal, since they run inside the daemon rather than at a CLI invocation; the others exit with an actionable error pointing at this section).

**Which operations this covers.** Every LLM-backed operation routes through the provider registry and is individually assignable via `cortex.llm.operations`: `terminal-event`, `retro-dedupe`, `summary`, `dashboard`, `long-term`, `compaction`, `supersession`. (`curation`, `event-detection` and `episode` are also declared operation names in the router but have no live caller since the pre-daemon write tier and Episodes were removed in 3.0.0 — assigning a provider to one of them is a no-op today.) Point any live operation at an on-device provider and that operation's envelope never leaves the machine, independently of the others.

The one exception is the dashboard's **`ask`**, which is agentic rather than one-shot — it runs a multi-turn loop calling MCP tools. It stays on the Claude Agent SDK, is not selectable via `cortex.llm.operations`, and remains gated by `THINK_LLM_CONSENT` like any other Anthropic call.

**The gate keys on data egress, not on which provider you picked.** think can be pointed at any OpenAI-compatible endpoint (`cortex.llm.providers`, or the legacy `cortex.local`). Consent is required for any provider that puts cortex content on the network — Anthropic, OpenAI, DeepSeek, or an OpenAI-compatible server on another host — and is *not* required for a provider serving from loopback, because nothing leaves the machine.

A provider's egress is declared by `offMachine`. When omitted it is inferred from the endpoint: loopback (`localhost`, `127.0.0.1`, `::1`) is on-machine, everything else is off-machine, and an unparseable endpoint fails closed to off-machine. Set `offMachine: false` explicitly to declare a host on your own network as trusted.

> **Prior behaviour (fixed).** Consent used to be enforced inside the Anthropic client rather than at the routing layer, so the OpenAI-compatible client — then named "local" on the assumption it only ever talked to on-device servers — carried no gate. Pointing `THINK_LOCAL_ENDPOINT` at a public API therefore shipped the full curation envelope with no consent check. Egress is now evaluated in the router before any request is built. Loopback configurations are unaffected.

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

| Operation | Frequency | Envelope shipped |
|---|---|---|
| Write-time compaction | Automatic, ~1-2s after every `kind=memory` write (daemon queue) | The new entry's content plus up to 10 recent same-cortex entries retrieved by embedding similarity (skipped entirely — no LLM call — when nothing clears the triage similarity threshold). |
| Retro supersession | Automatic, after every `kind=retro` write | The new retro plus its top-K similar same-cortex retro candidates, for a REPLACES / DUPLICATE / COEXISTS judgment. |
| `think curate-retros` | Manual, or periodically from the daemon's curation loop | Pairs of retro candidates (FTS-matched) sent to the LLM for equivalence judgment (merge / promote / relegate). |
| `think long-term backfill` | Manual, one-time | One call per month of history. Each call ships that month's memories plus a digest of prior batches' proposed events for supersession context. `--dry-run` ships **nothing** (AGT-061). |
| `think summary` | Manual | Memory entries from the requested time window. Falls back to raw output on consent failure. |
| `think dashboard` panel summaries | Manual (on dashboard render) | Recent memories/events feeding each summarized panel. (The dashboard's `ask` is separate — see [Agent topology / The one exception](#the-one-exception-think-dashboards-ask) — and is gated by the same consent check even though it isn't assignable via `cortex.llm.operations`.) |
| Proxy terminal-event curation (`think serve`) | Automatic, per settled connector event | One connector event's payload (GitHub/Linear/Notion/Slack), wrapped in `<data>` tags, sent to produce the memory published to the team cortex. |

Nine `cortex.*` config keys that used to shape the removed curation prompt — including `curatorPromptCharCap` — are no longer read; think prints a one-line "no longer used" note if one is set, but setting it is not an error and nothing rewrites your config file. There is no prompt-size cap on the operations above beyond the daemon's own triage/candidate-count limits (10 candidates for compaction, top-K for supersession) — the shared prompt-size gate described in [Known trade-offs](#known-trade-offs) governs routing (local vs. `fallback`), not what gets included.

## Known trade-offs

These are intentional design choices, not vulnerabilities:

- **Legacy `cortex.local` keeps its original scope.** It governed curation before per-operation routing existed, and it still governs exactly that — upgrading does not silently start sending `summary`, `dashboard`, `long-term`, `compaction` or `supersession` envelopes to a local model. Widening it is done by writing `cortex.llm.operations`, where each destination is named explicitly.
- **Token estimates round against you, and that can change routing.** The prompt-size gate estimates ~3.5 chars/token (measured, not assumed: a real curation envelope of 109,252 chars tokenized to 31,780 on Qwen3.8-27B). The previous 4.0 under-counted by ~14% and let oversized prompts through. If you had tuned `ctxBudget` against the old estimate, tasks that used to fit may now route to your configured `fallback` — or be left pending when there isn't one. Raise `ctxBudget` to match your model's real context window.
- **Consent is per-machine-boundary, not per-destination.** Granting `THINK_LLM_CONSENT=1` permits sends to *every* off-machine provider configured, not just the one you had in mind. If you route different operations to different vendors, that single flag covers all of them. Scope it per shell session, or keep sensitive cortexes on a loopback-only provider where no consent is needed.
- **Consent is opt-in but irreversible per call.** Once consent is granted and an operation completes, the data has reached the off-machine provider. There is no per-turn confirmation; the gate is at the point the request would be sent. If you're working on a sensitive cortex, scope `THINK_LLM_CONSENT` to the shell session rather than committing it to your shell profile, and consider a separate cortex with consent disabled.
- **Memory tombstones do not propagate across sync** — see SyncAdapter contract test `enforceImmutableMemories`. A `think memory delete <id>` removes the row locally; peers retain their copy. Right-to-erasure across machines is architecturally not supported (BLOOM-122 invariant). Use `think pause` to suppress new `think sync` / `think event` writes if you don't want content to land in the first place.
- **`cortex pull` / `push` operates directly on a git remote you configured.** No sandbox, no content review. You're trusting the remote to hold honest data.
- **The resident daemon runs continuously as your user.** No privilege escalation, but any compromise of the daemon process (or `think subscribe install-agent`'s scheduler LaunchAgent) would run with your permissions and full access to the local cortex DBs.
