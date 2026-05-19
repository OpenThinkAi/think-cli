# Changelog

## [1.0.0-alpha.10] — 2026-05-18

### Fixed
- **Sync now writes `kind` and `topics_json` to L2** — entries synced via `think sync` were missing `kind` and `topics_json` in the L2 SQLite index (the columns existed from migration 14 but the INSERT in `sync-handler.ts` never populated them). All new synced entries now have `kind` and `topics_json` set immediately. Pre-alpha.10 entries have `kind = NULL`; run `think reindex <cortex>` to backfill `kind` and `topics_json` on entries synced before this release.
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
