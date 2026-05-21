# Changelog

## [Unreleased]

### Added
- **`slack` source connector for `think serve` (AGT-394, think-proxy-events Phase 4).** Adds an opt-in capture path for settled Slack threads. Slack threads have no native "closed" state, so capture is gated on a **team convention**: a designated reaction on the thread ROOT (default `:lock:`, configurable via `THINK_SLACK_CLOSING_REACTION`) signals "this thread is settled — curate it now." On detection the connector fetches the thread via `conversations.replies` (first 100 messages; `has_more: true` is surfaced in the payload when the thread is longer than that — pagination is a v2 follow-on) and emits one terminal event keyed `slack:<workspace>:<channel>:<thread-ts>`, payload carrying participants (user IDs), message text in order, and the time range. Per poll the connector walks `users.conversations` (channels the bot is a member of) → `conversations.history` (most recent page per channel) → for each thread root carrying the closing reaction not already in the cursor's `emittedThreadKeys` set, `conversations.replies` to fetch the thread. Cursor is `{ emittedThreadKeys: string[] }`, FIFO-trimmed to 500; below the cap, dedup falls through to the events table's `events_sub_id_unique`. `verifyCredential` probes `auth.test`. Subscription `pattern` is a free-form workspace label (no slash semantics, just an `episodeKey` namespace). Required bot scopes: `channels:history`, `groups:history`, `channels:read`, `groups:read`, `reactions:read`. Adopting teams should announce the convention to their team; teams that don't adopt get nothing — no central infrastructure burden. See `docs/serve.md` for the operator runbook.

### Deprecated
- **`think subscribe poll` default behavior is now a deprecation no-op** (AGT-389, think-proxy-events Phase 3). The pre-think-proxy-events model had every machine poll the proxy and write external events into its own local engrams table, then individually curate them. The new model: the proxy curates centrally and publishes memories to a team cortex; team members `git pull` like any other cortex. The local engram-write path stays available behind a `--legacy-engrams` flag during the migration window so v2 installs don't break.

### Upgrade notes — migrating from local subscribe-poll to proxy-curated cortex pulls

Under the new flow, you no longer poll the proxy and write engrams locally. Instead, the proxy (running `think serve` with connectors enabled) curates terminal events from external sources and pushes memories to a team-shared cortex repo. Each team member adds that cortex to their local install once, and gets future memories via `think pull`.

**One-time migration**:

```sh
# 1. Add the team cortex (URL provided by whoever runs the proxy).
think cortex add <team-cortex-name> <git-url>

# 2. Pull existing memories.
think pull <team-cortex-name>

# 3. Remove the auto-subscribe LaunchAgent that ran `subscribe poll --quiet` every 600s.
think subscribe disable
```

**During the migration window** (while some team members are still on the old flow), the legacy path stays available:

```sh
think subscribe poll --legacy-engrams        # explicit opt-in to the old engram-write path
```

`--legacy-engrams` prints a soft notice each run so it doesn't quietly become the steady state. The flag will be removed in a future release once all team members have migrated.

**The auto-subscribe LaunchAgent** (`think subscribe install-agent`) continues to invoke `think subscribe poll --quiet`. Under the new default, that's a silent no-op — so installed agents will stop ingesting events without spamming the user. Run `think subscribe disable` to remove the LaunchAgent entirely once you've moved to `think pull <team-cortex>`.

---

## [1.0.3] — 2026-05-19

### Changed
- **Compaction + supersession moved to `claude-haiku-4-5` via forced tool_use.** alpha.11 tried Haiku for these two sites with freeform JSON output and hit 100% `validateShape` rejection (reverted in alpha.13 back to `claude-sonnet-4-6`). This release retries the Haiku swap with a different shape contract: each call now declares a `submit_compaction` / `submit_supersession` tool with a full `input_schema`, and `tool_choice: { type: 'tool', name: ..., disable_parallel_tool_use: true }` forces the model to call it. The Anthropic API enforces the schema server-side, so structural conformance is no longer the model's job. `validateShape` (compaction) and `parseSupersessionToolInput` (supersession) remain as belt-and-braces for business rules that an input_schema can't express: non-empty `compacted_text`, the `is_duplicate → empty supersedes` invariant, the topics cap at 4. Smoke test on personal corpus showed 13/13 compactions completing cleanly with synthesized fold-entries showing real narrative awareness, vs. the 100% permanent-skip rate of alpha.11.
- **Three lower-frequency LLM call sites also switched to `claude-haiku-4-5`.** These were drop-in model swaps — output is freeform prose or lenient classification with no strict JSON contract that would bite Haiku:
  - `lib/claude.ts` `generateSummary` — weekly 1:1 work-log markdown summary
  - `lib/curator.ts` `runConsolidation` — narrative consolidation of aging memories
  - `lib/retro-curator.ts` `runRetroDedupe` — binary equivalence classification (bad-parse already skips, no data-loss risk)

### Unchanged
- **`lib/curator.ts` `runCuration` stays on `claude-sonnet-4-6`.** The main curator decision loop synthesizes across a 50k-char context window of memories + long-term events + pending engrams and emits a multi-field structured output (`memories[]`, `purge_ids[]`, `long_term_events[]`). Reasoning depth is the limiting factor, not output shape; Haiku has not been validated for this kind of multi-stage long-context judgment in this codebase.
- **`commands/long-term.ts` `runBackfillBatch` stays on `claude-sonnet-4-6`.** Bulk historical curation that emits durable long-term events. Low frequency (one-time / on-demand) and high stakes (durable writes), so the cost-saving math doesn't justify the model change.

### Upgrade notes
- **Behavior change, not interface change.** No code that calls the affected modules needs to update. The `CompactionResult` / `SupersessionResult` types are unchanged.
- **Daemon must have `ANTHROPIC_API_KEY` in its env.** Unchanged from prior releases, but worth re-stating: the daemon process inherits env at spawn time. If your shell exports `ANTHROPIC_API_KEY` only conditionally (e.g. via a wrapper function), restart the daemon under that wrapper so it picks up the key.

---

## [1.0.2] — 2026-05-19

### Fixed
- **Daemon orphan-leak spawn race (#60).** Concurrent CLI invocations during the ~30s embed-model warmup window could each spawn their own daemon, because `connectDaemon()` decided whether to spawn based purely on socket connectivity. The loser kept running its compaction queue, pull loop, and resident embedding model independently of the supervised daemon — `think daemon stop` only terminated the supervised one, and orphans accumulated across a dev session (99 observed in one report). Each orphan held hundreds of MB resident and independently called `claude-sonnet-4-6` on its own backfill schedule. Fix: before spawning, `connectDaemon()` now (1) consults the PID file and skips the spawn if a daemon is already alive (mid-warmup), and (2) acquires an atomic `O_EXCL` spawn-mutex so concurrent CLIs serialize through one spawn instead of all racing it. Stale locks (dead holder PID or older than `SPAWN_TIMEOUT_MS`) are reclaimed automatically. No interface changes.

### Upgrade notes
- **Clean up pre-1.0.2 orphans.** The fix is preventative — it stops new orphans from being created, but does not terminate orphans already running from earlier sessions. After upgrading, run `pkill -f "dist/daemon/index.js"` (macOS/Linux) to terminate any leftover daemons, then `think daemon start` to spawn a fresh supervised one. `think daemon stop` alone will only terminate the supervised daemon and leave the orphans behind.
- **New state file.** `~/.think/daemon.spawn.lock` may appear briefly in `~/.think/` during daemon startup. It is held only while a CLI is in the spawn-or-connect retry loop and is removed automatically on success or timeout — safe to delete if found stale.

---

## [1.0.1] — 2026-05-19

### Fixed
- **`UserPromptSubmit` hook no longer SyntaxErrors at line 2** — Claude Code emitted `UserPromptSubmit hook error … :2` on every prompt for many users. Root cause: the bundled `dist/hooks/user-prompt-submit.js` had TWO shebangs. The source file started with `#!/usr/bin/env node`, and tsup's `banner.js` config prepends `#!/usr/bin/env node --no-warnings=ExperimentalWarning` on top of that. Node parses the FIRST shebang as a shebang line, then hits the SECOND `#!` on line 2 — which is a SyntaxError under ESM. The hook crashed before any logic ran. Fix: remove the source-file shebang from `src/hooks/user-prompt-submit.ts`; the tsup banner is the canonical shebang and is already correct. After upgrading, the hook loads cleanly and writes either `additionalContext` (when recall returns hits) or `{}` (fail-open).
- **Script-detection guard hardened to handle symlinked paths.** The same hook entry's `if (fileURLToPath(import.meta.url) === process.argv[1])` guard would silently fail when either path traversed a symlink (e.g. macOS `/tmp` → `/private/tmp`, or any nvm-global setup where the binary lives behind a `lib/` symlink). `main()` was never invoked in those cases, the script exited 0 with no output, and Claude Code surfaced it as the same `:2` error. Both sides are now `fs.realpathSync`-normalized before comparison — same idiom as the `daemon/index.ts` fix in alpha.7. Together with the shebang fix this closes the entire family of "hook script silently misbehaves on macOS" failures.

---

## [1.0.0] — 2026-05-19

The v3 architecture — vector recall, write-time compaction, and a resident daemon — graduates from alpha to stable. Same code path as `1.0.0-alpha.14`, dropping the prerelease suffix and flipping the npm `latest` tag from `0.6.12` to `1.0.0`.

### What's in 1.0
- **Vector recall** via the resident `bge-small-en-v1.5` embedding model. `think recall <query>` returns semantically similar entries even when query and stored text share no vocabulary. FTS5 keyword search remains as `--no-embed` and as the automatic fallback when the embedding model is unavailable.
- **Write-time compaction** folds new memory entries into a one-line summary that bakes the relevant trajectory in, via `claude-sonnet-4-6` (see alpha.13 for the alpha-period Haiku experiment + revert). Compacted entries supersede their raw inputs in default recall; `--full` surfaces the originals.
- **Resident daemon** at `~/.think/daemon.sock` holds the embedding model in memory after the first launch (~30s OS-cache-cold, otherwise instant on subsequent spawns). Every CLI command reuses the same daemon process. `think daemon start|stop|status` exposes lifecycle.
- **Agent integration**: `think hook install` wires a `UserPromptSubmit` hook into Claude Code so context is auto-injected on every prompt. `think mcp install` registers an MCP server exposing `think_recall`, `think_sync`, and `think_expand` as tools the agent can call mid-conversation.
- **Cross-cortex federation**: `think recall --scope accessible` (the default) queries all locally-cloned cortexes in parallel and merges results. `--scope active` constrains to the active cortex.
- **Filter flags** on `think recall`: `--kind memory|retro|event`, `--topic <topic>`, `--since <iso-date>`, `--limit <n>`, `--full`, `--json` (with the documented entry schema: `id, ts, cortex, kind, content, topics, supersedes, compacted_from, similarity, activity_seq`).
- **Three kinds**: `think sync` writes a memory, `think retro` writes durable wisdom about a codebase, `think event` writes a milestone/decision. All routed through the daemon.

### Upgrading from v0.6.x
Run `npm install -g @openthink/think` to upgrade. The first interactive run prompts to consolidate `~/.think/engrams/` into `~/.think/index/` (the v3 storage location). Existing JSONL data in `~/.think/repo/` is read-compatible; the daemon's first launch backfills the L2 vector index. v0.6.x commands all continue to work; the daemon-routed equivalents are recommended.

### Upgrading from an alpha install
If you installed via `npm install -g @openthink/think@alpha`, your install is pinned to the `@alpha` dist-tag and will NOT pick up the stable `1.0.0` automatically. Switch tags explicitly:

```sh
npm install -g @openthink/think     # or @latest — both resolve to 1.0.0 now
```

### Stable known issues (file GitHub issues if you hit these)
- `think audit` reports "No sync activity" against v3 data — v2 audit-log path needs updating.
- `--scope all` is documented but not yet wired to remote-peer federation; the CLI emits a `note:` warning each time it's used and the daemon falls back to `--scope accessible` (queries all locally-cloned cortexes).
- `think hook install` / `think mcp install` no-op when an existing entry is present but stale (e.g. left over from an alpha install pointing at a different install prefix). Re-running these commands does not refresh; a `--force` flag is on the roadmap. **Interim workaround**: remove the existing `think` entry from `~/.claude/settings.json` (hook) or `~/.claude.json` (MCP), then re-run the install command.

---

## [1.0.0-alpha.14] — 2026-05-18

### Fixed
- **`push-debouncer` and `proxy-subscribe` log lines now reach `daemon.log`** — alpha.13 extended the dual-write pattern (stderr + `daemon.log`) to `compaction-queue` only. Real-corpus testing by a personal-machine test agent confirmed the other two logging subsystems were still silent: `grep -c 'push-debouncer' daemon.log` returned 0 on a running alpha.13 daemon. Root cause: both modules had local `log()` functions writing only to `process.stderr`, which the detached daemon discards. Fix: a shared `daemon/log.ts` helper (`daemonLog(subsystem, msg)`) is extracted and wired into all three subsystems — `compaction-queue`, `push-debouncer`, and `proxy-subscribe` — replacing the per-module stderr-only implementations. Every future subsystem gains the dual-write pattern for free by calling `daemonLog`.
- **Successful compaction is now visible in `daemon.log`** — the `processJobWithRetry` success path called `setCompactionStatus(..., 'completed')` with no log line, so a working compaction produced no trace in `daemon.log`. Operators saw backfill and triage-skip messages but never "compacted entry X". A single `log('compaction completed: entry=… cortex=…')` line is now emitted after `setCompactionStatus('completed')` returns.
- **`think reindex` `kind`/`topics_json` backfill confirmed correct** — a test agent reported that pre-alpha.10 entries still showed `kind = NULL` after `think reindex`. Code review confirmed the reindex command already uses `INSERT OR REPLACE` with both `kind` and `topics_json` sourced from L1 JSONL (`parseMemoriesJsonl` defaults `kind` to `'memory'` for v2-era entries that omit the field). The report was a misdiagnosis — the fix shipped in alpha.10 is intact and correct. No code change needed; documented here so the record is clear.

---

## [1.0.0-alpha.13] — 2026-05-18

### Fixed
- **Compaction queue log lines now reach `daemon.log`** — the daemon spawns detached with `stdio: 'ignore'`, so compaction-queue messages written via `process.stderr.write` (the worker's `log()`) were going to `/dev/null` in production. Result: 100%-failing compaction was completely invisible to users — entries silently piled up with `compaction_status = 'permanently_skipped'` (content-fault) and no log evidence outside `--foreground` mode. The `log()` function in `daemon/compaction/queue.ts` now appends to `daemon.log` in addition to stderr, so detached runs leave a permanent record.
- **Compaction now strips markdown code fences before `JSON.parse`** — mirrors the supersession path, which has had this defensive parse since AGT-303. Even with the schema-respecting prompt, models occasionally wrap structured output in ``` fences; tolerating it costs nothing and prevents a legitimate response from being marked `response_invalid`.

### Reverted
- **Compaction and retro-supersession switched back from `claude-haiku-4-5` to `claude-sonnet-4-6`.** alpha.11 moved both LLM call sites to Haiku 4.5 for cost containment. Real-corpus testing showed Haiku's output failed the `validateShape` JSON contract on **100%** of compaction calls — every entry hit `permanently_skipped` (content-fault), no compactions ever completed, and the cost saving turned into pure waste (Haiku still charges for the failed attempts). The detached-daemon observability bug above hid this failure: `[compaction-queue] [ERROR] compaction permanently skipped` lines existed only in foreground-mode stderr. Sonnet was the working baseline through alpha.10; restoring it brings compaction back to a known-good state. Haiku is worth revisiting only after the prompt has been re-engineered for smaller-model output conformance — likely via `tool_use` for forced-JSON output rather than relying on schema discipline in plain text.

### Unsticking entries marked permanently_skipped by alpha.11/alpha.12

If your daemon ran alpha.11 or alpha.12 with `THINK_LLM_CONSENT=1`, the corpus may have entries flagged `compaction_status = 'permanently_skipped'` from the failed Haiku attempts. To allow them to retry on Sonnet:

```sh
THINK_DIR="${THINK_HOME:-$HOME/.think}"
for db in "$THINK_DIR"/index/*.db; do
  sqlite3 "$db" "UPDATE memories SET compaction_status = NULL WHERE compaction_status = 'permanently_skipped'"
done
# Restart the daemon to re-scan and enqueue:
think daemon stop && think daemon start
```

---

## [1.0.0-alpha.12] — 2026-05-18

### Fixed
- **Engrams→index consolidation prompt now works on macOS zsh** — on alpha.11, pressing Enter at the "Press Enter to consolidate, or Ctrl-C to cancel:" prompt was silently treated as a cancellation, causing the prompt to re-fire on every subsequent `think` invocation and the consolidation to never happen. Root cause: `fs.readSync(0, …)` throws `EAGAIN` (errno -35) on macOS when npm or the shell puts stdin into non-blocking mode before the process starts; the catch block treated any throw as Ctrl-C. The fix reads confirmation from `/dev/tty` (the controlling terminal) via `execSync('head -n 1 < /dev/tty')` instead — `/dev/tty` is always in canonical blocking mode regardless of what has been done to stdin, so Enter is reliably accepted and only a real Ctrl-C (SIGINT) is treated as cancellation.

---

## [1.0.0-alpha.11] — 2026-05-18

### Changed
- **Compaction and retro-supersession switched from `claude-sonnet-4-6` to `claude-haiku-4-5`** during alpha for cost containment. A real-corpus smoke test came in at ~$0.07 per Sonnet compaction call; at team scale (10 people × ~30 compactions/day each, post-triage-gate) that's roughly $300/mo of LLM spend on a single subsystem before any real-world signal on whether the corpus benefits from Sonnet-class quality. The compaction task is structured rewrite with a JSON-schema-validated output and a supersession judgment — Haiku is acceptable here with the trade-off that hairy multi-entry trajectories may be flattened or over-superseded. Re-evaluate after real-corpus A/B with usage data on hand. Source comments in `daemon/compaction/call.ts` and `daemon/supersession/call.ts` document the revisit trigger.

---

## [1.0.0-alpha.10] — 2026-05-18

### Fixed
- **Sync now writes `kind` and `topics_json` to L2** — entries synced via `think sync` were missing `kind` and `topics_json` in the L2 SQLite index (the columns existed from migration 14 but the INSERT in `sync-handler.ts` never populated them). All new synced entries now have `kind` and `topics_json` set immediately. Pre-alpha.10 entries have `kind = NULL`; run `think reindex <cortex>` to backfill `kind` and `topics_json` on entries synced before this release. The `sync` RPC no longer emits advisory `warnings` for non-memory kinds or topics; these limitations have been resolved.
- **Recall RPC response now includes `activity_seq`, `compacted_from`, and `supersedes`** — the `recall` daemon RPC (used by `think recall --json` and the `think_recall` MCP tool) was silently dropping three fields from every result entry. `activity_seq` is now always present (null for pre-backfill rows). `compacted_from` is populated for compacted entries via a single batched `compaction_links` query (not N+1). `supersedes` equals `compacted_from` for compacted memory entries, and `[]` for raw entries.
- **`think reindex` now backfills `kind` and `topics_json`** — the reindex command reads `kind` and `topics` from L1 JSONL and writes them to L2 via `INSERT OR REPLACE`, so running `think reindex <cortex>` after upgrading to alpha.10 fully repairs the L2 index for existing data.

### Known limitation
- **`--since` filter interacts with vector overfetch** — recall does: vector search → top-K candidates → filter by `since`/`kind`/`topic`. If filters reject most of the top-K, results can be sparse even when many matching entries exist. Workaround: increase `--limit` to widen the candidate pool.

---

## [1.0.0-alpha.9] — 2026-05-18

### Fixed
- **`think hook install` now writes the correct Claude Code hook schema** — the previous shape (`{ type: 'command', command: '/abs/path/user-prompt-submit.js' }` at the top level of `UserPromptSubmit`) is a flat structure that Claude Code's `/doctor` rejects. The correct shape is a matcher-group wrapper: `{ matcher: '', hooks: [{ type: 'command', command: 'node "…"' }] }`. An empty-string `matcher` means "always fire", which is correct for `UserPromptSubmit` context injection. This was a silent bug — the hook was written to settings but never executed by Claude Code.
- **`think hook install` now prefixes the hook command with `node`** — Claude Code executes `command` via shell. A bare `.js` path (no interpreter) silently failed; the command is now `node "/abs/path/user-prompt-submit.js"` with the path quoted to handle spaces in install prefixes.
- **Migration: `think hook install` self-heals existing broken entries** — users on alpha.4–alpha.8 already have the flat shape on disk. Re-running `think hook install` on alpha.9 detects any existing entries referencing `user-prompt-submit.js` (in either the old flat shape or the new matcher-group shape), removes them all, and writes exactly one correct entry. Unrelated `UserPromptSubmit` hooks are preserved. The operation is idempotent: running install multiple times produces exactly one entry.
- **`think hook uninstall` also clears old flat-shape entries** — the removal path now recognises both the old flat shape and the new matcher-group shape, so `uninstall` is a reliable cleanup regardless of which alpha version originally wrote the entry.

---

## [1.0.0-alpha.8] — 2026-05-18

### Fixed
- **`think recall` now actually uses the daemon's vector search.** The headline v3 feature — semantic similarity recall via `bge-small-en-v1.5` — was unreachable from the CLI: every `think recall <query>` call went straight to local FTS5 keyword search regardless of whether the daemon was running, because the AGT-289 daemon-routing hook in `commands/recall.ts` was left as a placeholder comment ("Currently FTS is the only path"). Vector search worked correctly when invoked through the `think_recall` MCP tool, but not from the CLI. The fix wires `commands/recall.ts` to `connectDaemon()` and the daemon's `recall` RPC, with the existing FTS5 path retained as a fallback when (a) the user passes `--no-embed`/`THINK_NO_EMBED=1`, (b) the daemon spawn/connect fails, or (c) the daemon itself auto-falls-back to FTS (embedding model unavailable, surfaced as `note: semantic recall unavailable …`). All daemon-only flags (`--kind`, `--topic`, `--since`, `--include-superseded`, `--scope`) now apply on the primary path; the FTS fallback continues to warn that they are no-ops in degraded mode. The `--full` flag, `--json` output, and the AGT-318 kind-grouped formatter all route through the daemon path. End-to-end: a query like "experimental prototype status" against a corpus containing "experimental, non-production prototype" now returns semantic matches under default mode and zero matches under `--no-embed`, confirming the two paths are doing what their names say.

---

## [1.0.0-alpha.7] — 2026-05-18

### Fixed
- **Daemon: bind socket *after* warmup, not before.** alpha.6 made the daemon log "ready" only after the model was loaded, but the listening socket was still bound at the top of startup. Clients connected during warmup and their RPC handlers awaited the same warmup promise, blowing through the CLI's 30s per-call timeout exactly as before. The real fix is to defer `bindServer()` until after warmup completes — then there is no socket for the CLI to connect to during the warmup window, and the CLI's spawn-or-connect retry loop (already bumped to 90s in alpha.6) naturally absorbs the wait. The PID file is still written *before* warmup so a second `think daemon start` racing during warmup sees the daemon process and waits instead of double-spawning. End-to-end: cold spawn sync ~4s on warm OS page cache (~38s on a fully-cold cache, once per OS lifetime), every subsequent sync ~400ms.

---

## [1.0.0-alpha.6] — 2026-05-18

### Fixed
- **Daemon: block "ready" until embedding model is loaded** — alpha.5 added `warmupEmbedModel()` as a fire-and-forget after the daemon logged "ready", which left the root cause untouched: if a `think sync` arrived during the ~34s warmup window, it blocked on the same in-flight `getPipeline()` promise and the CLI's 30s call timeout fired before the model finished loading. The fix promotes warmup to a blocking `await` that runs *before* the "ready" log line. The daemon logs `embed-model: loading…` at startup, then `embed-model: loaded (…, 34259ms)` once the model is resident, then `think daemon ready`. If warmup fails (optional dep missing, ONNX ABI break), the daemon still becomes ready in FTS-only mode and logs a `WARN` — the existing FTS fallback in the sync handler handles the missing-embed case gracefully. The CLI's spawn-or-connect retry window (`SPAWN_TIMEOUT_MS`) has been bumped from 5s to 90s to accommodate the now-blocking startup.

---

## [1.0.0-alpha.5] — 2026-05-18

### Fixed
- **Daemon: pre-load embedding model at startup** — the first `think sync` after daemon start previously triggered a cold load of `Xenova/bge-small-en-v1.5` (~30 s even with the model cached on disk), hitting the CLI's 30 s call timeout and falling back to a v2-shape local write. The daemon now kicks off `warmupEmbedModel()` as a fire-and-forget immediately after binding its socket and logging "ready". The socket bind (and the "ready" log) happen before model load, so spawn-or-connect latency is unchanged. Any sync call that arrives during warmup awaits the same in-flight load via the existing `pipelinePromise` singleton — no duplicate model instantiation, no race.
- **engrams/ consolidation: decide for the user, not at them** — the "both engrams/ and index/ exist" warning was printed on every CLI invocation, putting file-management burden on users. The new behaviour: if stdin is a TTY, think prints a single clear prompt (with an explicit IRREVERSIBLE warning and a Ctrl-C escape hatch), blocks synchronously for the user to press Enter, then moves all `.db` files from `engrams/` into `index/` and removes `engrams/`. For cortex DBs that exist in both dirs, `index/` (v3 canonical) is kept and the `engrams/` copy is backed up to a timestamped `engrams-backup-<ts>/` sibling so the user can recover it. In non-interactive sessions (hooks, MCP, scripts) the check is silently skipped — the next interactive `think` invocation will handle it.

---

## [1.0.0-alpha.4] — 2026-05-18

### Fixed
- `think hook install` and `think mcp install` now resolve the correct dist paths on a global npm install (`npm install -g @openthink/think`). Both commands were using `process.argv[1]`-based path math which resolves to the `bin/` symlink directory instead of the `dist/` directory, producing errors like `hook script not found at …/bin/hooks/user-prompt-submit.js`. Both resolvers now use the same package-root sentinel-walk pattern as `daemon-client.ts` (`fileURLToPath(import.meta.url)` + walking outward to find the `@openthink/think` `package.json`). The shared helper is extracted into `lib/pkg-paths.ts` to avoid duplication across the three callers.
- `think mcp install` (and `think mcp` stdio mode) now work on the published alpha. The MCP server entry point (`src/mcp/server.ts`) was missing from the tsup build configuration, so `dist/mcp/server.js` did not exist in the published package. It is now included as a first-class tsup entry alongside the daemon and hook entries.

---

## [1.0.0-alpha.3] — 2026-05-18

### Fixed
- `think recall` semantic similarity search now works on the published alpha. tsup was bundling `@huggingface/transformers` into a single chunk that stripped the native `onnxruntime-node` backend bindings, producing a broken runtime import (`listSupportedBackends is not a function`). The daemon's embed call caught the failure and the CLI silently fell back to writing v2-shape engrams that v3 `recall` does not query — recall always returned `note: no entries matched`. Mark the package `external` in `tsup.config.ts` so Node resolves it from node_modules at runtime, with its native binary siblings intact.

---

## [1.0.0-alpha.2] — 2026-05-18

### Fixed
- `think daemon start` (background mode) now works correctly on the published alpha (#58). Two compounding bugs were addressed:
  - The daemon binary path resolution used brittle `../..` relative math that overshot the package root under the bundled `dist/` layout, surfacing as `daemon binary not found at @openthink/dist/...` (missing the `/think/` segment).
  - The daemon entry exported `runDaemon` but didn't auto-execute when invoked as a script, so spawning `node <entry>` imported the module and silently exited with no daemon process. Foreground mode was unaffected.

---

## [1.0.0-alpha.1] — 2026-05-18

### v3 — Vector recall, write-time compaction, resident daemon (AGT-311 through AGT-323)

v3 is a major architectural redesign. Full design: [think-v3 project README](https://github.com/OpenThinkAi/think-cli/blob/main/docs/think-v3.md).

**Phase 0 (AGT-311):** L1/L2 schema extensions — kind, compacted_from, supersedes, topics, embedding column; v2 JSONL stays readable.

**Phase 1 (AGT-312):** Embedding pipeline — @huggingface/transformers wrapper (bge-small-en-v1.5), think reindex command.

**Phase 2 (AGT-313):** Daemon scaffold — Unix socket server, JSON-line protocol, auto-start on first CLI call, think daemon start|stop|status.

**Phase 3 (AGT-314):** Activity-based recency — stable activity_seq column, exponential-decay recency weighting in retrieval.

**Phase 4 (AGT-315):** Write commands through daemon — think sync, think retro, think event routed over socket.

**Phase 5 (AGT-316):** Write-time compaction — background queue, vector-gated triage (skips LLM when no similar candidates), compaction prompt, supersession links.

**Phase 6 (AGT-317):** Retro supersession check — async LLM-based conflict detection between retros; events accumulate unconditionally.

**Phase 7 (AGT-318):** Cross-cortex federation — parallel per-cortex queries, merged + re-ranked recall, cortex provenance in output.

**Phase 8 (AGT-319):** Sync push debounce + proxy-subscribe client — 500ms debounce on L1 writes, WebSocket subscribe client with polling fallback.

**Phase 9 (AGT-320):** Hook + MCP integration — UserPromptSubmit hook for per-prompt grounding, MCP server exposing think_recall/think_sync/think_expand; think init --hook and think init --mcp.

**Phase 10 (AGT-321):** v3 think init block — v3-aware CLAUDE.md init output with hook + MCP guidance; --hook/--mcp flags.

**Phase 11 (AGT-322):** v3 think brief — cortex-aware status report combining daemon health, recent memories, and retros; --cortex and --json flags; --kind/--topic/--since recall filters.

**Phase 12 (AGT-323):** Version bump to 1.0.0-alpha.1, README v3 overview, workflow alpha-tag fix, release/v1.0.0-alpha branch cut.


### Upgrading from v0.6

**Install:** `npm install -g @openthink/think@alpha`

The alpha label is deliberate — v3 ML features (vector recall via
`@huggingface/transformers`, daemon-resident embedding model) are
opt-in and experimental. v2 storage is read-compatible; first launch
reindexes automatically and all existing JSONL entries are preserved.

**Removed flags:** `--no-sync` is deprecated (replaced by `--no-push`).
A deprecation warning is emitted on use; `--no-push` is the forward path.

**Optional ML dependency:** semantic recall requires
`@huggingface/transformers@4.2.0` (shipped as an optional dependency).
Without it, `think recall` falls back to full-text search with no data
loss. The daemon startup message tells you if the model is unavailable.

**Two Anthropic SDKs in the dependency tree:** `@anthropic-ai/claude-agent-sdk`
drives all interactive LLM calls (recall curator, retro extraction), gated
behind the `THINK_LLM_CONSENT` guard. `@anthropic-ai/sdk` is used directly
for background daemon operations (compaction, supersession) that run without
a live Claude session. Both are intentional; neither is being phased out.

---

## [0.6.12] and earlier

See git log for v0.x history.
