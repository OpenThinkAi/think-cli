# Changelog

## [Unreleased]

## [1.11.1] — 2026-05-31

### Fixed

- **Dirty shared worktree no longer wedges branch switching for every cortex (#69).** The daemon time-shares one git worktree across all cortex branches (one orphan branch per cortex). A cycle that crashed or aborted after appending to an L1 page but before committing could leave that worktree dirty; from then on, every `git switch`/`git merge --ff-only` for **any** cortex aborted with "Your local changes to the following files would be overwritten by checkout", wedging read/write across all cortexes with no self-heal until a human cleaned the tree by hand. think now self-heals before switching/merging: it salvages the leftover with a commit on the current branch (every tracked path belongs to the checked-out cortex by the orphan-branch invariant, so the data is preserved — not discarded as `git reset --hard` would). Applied to both git seams (the synchronous CLI/compaction path and the async push-debouncer). Staging is tracked-only (`git add -u`), so stray untracked files are never swept into cortex history.
- **Daemon error messages are no longer truncated mid-sentence.** The `retro`, `log`, and `event` commands capped daemon-sourced errors at 200 characters, clipping git's remediation hint (e.g. "Please commit your changes or stash them…") exactly when the user needed it. The cap is now 1000 characters so the actionable part of the message survives.

## [1.11.0] — 2026-05-29

### Added

- **Local-first LLM curation (opt-in) — route `think curate` to a local model, fall back to Claude only on size.** think can now run curation on a local, OpenAI-compatible model server (oMLX/Qwen — the same kind of endpoint hal9k's local review targets) instead of Anthropic. A new `lib/llm/` adapter introduces a single `LlmClient` interface with two backends — `LocalLlmClient` (on-device, `/chat/completions`) and `AnthropicLlmClient` (the existing gated Claude Agent SDK path) — behind a `RouterLlmClient` that implements the policy: **default to local when configured, fall back to Anthropic only when a task overflows the local context budget _and_ LLM consent is granted.** Local calls never leave the machine, so they bypass the consent gate entirely; consent now gates only the cloud path. Configure via `cortex.llmProvider` (`auto` | `local` | `anthropic`, default `auto`) and `cortex.local.{endpoint, model, apiKey, ctxBudget}`, or the `THINK_LOCAL_ENDPOINT` / `THINK_LOCAL_MODEL` / `THINK_LOCAL_API_KEY` / `THINK_LLM_PROVIDER` env vars.
- **Two-pass local curation closes the event-detection gap.** Small local models do engram→memory triage well but drop long-term-event detection when both run in one prompt; given a focused prompt they match Claude on events. So when curation routes local, think splits it into two passes — tier A (engrams → memories + purges) then tier B (memories → long-term events) — both on the local model. Anthropic-only curation keeps the single combined pass (no behaviour change, no doubled call).

### Changed

- **Configured-but-unreachable local server now skips gracefully instead of failing.** If `cortex.local` is set but the server is down, `think curate` skips the run (engrams stay pending for the next run), prints `can't reach your local LLM server at <endpoint> — is it running?` plus how to switch to Claude, and exits cleanly — it does **not** hard-fail and does **not** silently reroute to the cloud (availability is treated differently from size overflow). Size-overflow fallback to Claude (with consent) is unchanged.

### Upgrade notes

- **No action required; inert by default.** With no local endpoint configured — i.e. every existing install and fresh install — curation behaves exactly as in 1.10.x (Claude via the Agent SDK). The local-first path activates only when you explicitly set `cortex.local.endpoint`.

## [1.9.4] — 2026-05-24

### Added

- **`THINK_ANTHROPIC_KEY` — think-namespaced Anthropic API key (AGT-436).** The proxy's raw Messages API curation backend (`THINK_CURATION_BACKEND=api`) previously required exporting `ANTHROPIC_API_KEY`. Because every Anthropic SDK tool in the same shell reads that variable, setting it to satisfy think's curation backend would silently re-route tools like Claude Code from their subscription billing path to per-token API billing — with no indication to the user. The fix: think now reads a namespaced key `THINK_ANTHROPIC_KEY` first and falls back to `ANTHROPIC_API_KEY` only as a deprecated legacy path (emitting a one-time warning to stderr). With `THINK_ANTHROPIC_KEY` set and `ANTHROPIC_API_KEY` absent, Claude Code and other tools in the same shell keep their subscription billing unaffected. All three raw-API sites are fixed (`curator.ts:890`, `daemon/supersession/call.ts`, `daemon/compaction/call.ts`) via a single shared `resolveThinkApiKey()` helper.

### Changed

- **`ANTHROPIC_API_KEY` is now a deprecated fallback for think's API calls.** Existing deployments continue to work without any changes (back-compat). A one-time warning is emitted to stderr (never stdout — the daemon/proxy paths may have stdout consumers) when `ANTHROPIC_API_KEY` is the only key available. Migrate to `THINK_ANTHROPIC_KEY` at your next convenient opportunity.

### Upgrade notes

- **New installs:** set `THINK_ANTHROPIC_KEY` (not `ANTHROPIC_API_KEY`) in your proxy environment. This is the only key think needs; it stays scoped to think and does not interfere with other Anthropic tools.
- **Existing installs:** no immediate action required. `ANTHROPIC_API_KEY` still works; you'll see a one-time deprecation warning in daemon logs. To suppress the warning and isolate billing, rename `ANTHROPIC_API_KEY` → `THINK_ANTHROPIC_KEY` in your deployment config and remove `ANTHROPIC_API_KEY` from the daemon's environment.
- **Daemon restart required** after changing env vars, as always (the daemon inherits env at spawn time).

## [1.9.3] — 2026-05-24

### Added

- **`think serve` scheduler telemetry — per-tick and per-curation timing.** The scheduler already measured each tick's poll vs curate phases (the `TickReport` timestamps) but never surfaced them, leaving the proxy a black box for performance. It now logs a structured line per tick — `[open-think serve] [tick] total_ms=… poll_ms=… curate_ms=… polled=… curated=… errored=… curate_backend=api|agent-sdk curate_skip=…` — and one per curated event — `[open-think serve] [curate] event=… backend=… ms=… status=… memories=…`. This makes where a tick's wall-clock actually goes (poll vs curation vs idle) and each curation's real latency + backend directly readable from `railway logs`, instead of inferred. Pure observability; no behavior change.

## [1.9.2] — 2026-05-24

### Added

- **`THINK_CURATION_BACKEND=api` — opt-in raw Messages API curation backend for `think serve` (proxy).** By default, terminal-event curation runs through the Claude Agent SDK (`query`), which on a user's machine authenticates via their Claude Code login/subscription — so local `think` usage stays covered by the subscription and is **not** billed per-token. That default is unchanged. The Agent SDK, however, spins up the full agent runtime per call (~12s of harness overhead for a zero-tool single-shot generation); measured against the raw Anthropic Messages API the same curation is ~4s. An operator can now set `THINK_CURATION_BACKEND=api` (which engages only when `THINK_ANTHROPIC_KEY` or `ANTHROPIC_API_KEY` is also present) to curate via the raw Messages API instead — ~4–5× faster, on the same pay-as-you-go billing the proxy already uses. Subscription users never set the flag and are completely unaffected; if the flag is set without a key it falls back to the Agent SDK. **Note:** prefer `THINK_ANTHROPIC_KEY` over `ANTHROPIC_API_KEY` — see 1.9.4 for the billing-isolation rationale. This is the real throughput fix for large backfills (the per-event push coalescing in 1.9.1 was a genuine but secondary inefficiency).

## [1.9.1] — 2026-05-24

### Fixed

- **Proxy curation now pushes once per curate-batch instead of once per event (#66).** The `think serve` curate drain processes a batch of events, each writing memories and (previously) notifying the push-debouncer individually. Because curation writes are spaced by LLM latency (seconds), they always outran the debouncer's 500 ms window, so the proxy did a full `git pull --rebase` + commit + push round-trip to the shared cortex branch **per event** — those serialized git ops dominated each scheduler tick and throttled curation to ~10× below its ceiling on large backfills. The drain now suppresses the per-event push and fires a single batch push after the whole batch (one `git add -- <cortex>` stages everything written during the drain), cutting git round-trips ~Nx and shrinking cortex commit history to one commit per batch. Surfaced during the Phase 3 anglepoint-engineering backfill.

## [1.8.2] — 2026-05-23

### Added

- **`THINK_POLL_TIMEOUT_SECONDS` — configurable per-poll timeout for `think serve`.** The scheduler aborts any single connector poll after a fixed budget (default 60s). Because the GitHub connector enriches every fetched closed item with several sequential API calls, a repo with many items in the ingest window can blow past 60s, and a timeout discards the entire poll with **no** cursor progress — so such a repo never backfills (it times out identically every tick). Operators can now raise the budget (e.g. `THINK_POLL_TIMEOUT_SECONDS=300`) so large backfills complete; unset preserves the 60s default. Unit is seconds, matching `THINK_POLL_INTERVAL_SECONDS`; validated as a positive integer at boot. (Phase 3 / AGT-410 — needed for repos with >100 closed PRs since the ingest cutoff.)

## [1.8.1] — 2026-05-23

### Added

- **`THINK_GITHUB_INGEST_SINCE` — an ISO-8601 ingest floor for the GitHub connector.** When set, a fresh subscription only ingests issues/PRs updated on/after the cutoff (it becomes the `since` floor, so no per-subscription cursor seeding is needed) and skips releases published before it. A subscription whose cursor has already advanced past the floor keeps its progress — the floor never rewinds. Malformed values are ignored. This makes a date-limited backfill of a large org cheap and clean: it bounds the historical volume and, because GitHub's `/releases` endpoint has no `since` parameter, it's also the only date gate that keeps CI auto-tag releases (e.g. a repo that publishes `v2.x.x` on every deploy) out of the cortex. (Phase 3 / AGT-410 prep.)

## [1.8.0] — 2026-05-23

### Added

- **The GitHub connector now walks every page of a repo's closed issues/PRs (and releases), so backfilling a large org no longer silently stalls or skips.** Previously each poll fetched a single page (`per_page=100`) and advanced the `since` cursor by +1ms unconditionally — a busy repo drained one page per tick, and because GitHub's `updated_at`/`since` are *second*-granularity, a run of >100 items sharing one second across a page boundary could be skipped permanently. The connector now follows `Link: rel="next"` within a tick, bounded by a per-tick page cap and an `X-RateLimit-Remaining` floor so a heavy backfill can't exhaust a PAT mid-walk. It only bumps the cursor +1ms once it has fully drained *and* enriched everything; otherwise it resumes from the exact boundary second and lets the `events` unique index dedup the harmless overlap. A rate-limit hit mid-walk now returns the partial batch with a resumable cursor instead of discarding the tick. New env knobs: `THINK_GITHUB_MAX_LIST_PAGES` (default 10), `THINK_GITHUB_RATE_FLOOR` (default 200). Paginated `Link` URLs are followed only on the same origin as the API base, so a crafted `Link` header can't forward the PAT to another host. This is the prerequisite for expanding proxy ingestion to large orgs (Phase 3). (AGT-409)

### Changed

- **Type errors now block merges.** The repo's `build` (tsup/esbuild) and `test` (vitest) steps never ran `tsc`, so 20 strict-mode type errors had accumulated on `main` unnoticed. All are fixed, and a `typecheck` script (`tsc --noEmit`) is now a required stamp check on `main` — type regressions can no longer land silently.

## [1.7.0] — 2026-05-22

### Added

- **Ingested GitHub PRs and Slack threads now land in memory at their real date, not the import time.** Previously every curated memory was stamped with the moment the proxy processed it, so backfilling a source's history would pile all of it into "now" — and because recall weights recent memories more heavily, years-old PRs would surface as if they just happened. Now a PR's merge/close date (and a Slack thread's date) becomes the memory's timestamp, so historical items sort to their true place and recall ranking stays trustworthy. Live ingestion is unchanged (still stamped at processing time); only items with a clean source date override it, and anything missing or malformed falls back to processing time. This is the prerequisite for safely backfilling an older org's PR history and, later, importing old Slack threads.

  Implementation: new `EventInput.occurredAt?` (ISO-8601) populated by the GitHub connector (`merged_at ?? closed_at` for PRs, `closed_at` for issues, `published_at` for releases) and the Slack connector (thread root time); persisted on a new nullable `events.occurred_at` column (additive migration); `cortex-writer` sets `ts = occurredAt ?? now()` with a `Date.parse` validity guard so an unparseable override falls back rather than corrupting `ts`.

## [1.6.0] — 2026-05-22

### Fixed

- **Union merge driver is now set in `.git/info/attributes`, not just committed `.gitattributes` — fixes the rebase bootstrap deadlock from 1.5.0.** 1.5.0 committed a `.gitattributes` (`*.jsonl merge=union`) onto cortex branches, but that alone cannot bootstrap itself: during `git pull --rebase`, git reads merge attributes from the *checked-out* tree, which is the `onto` (origin) commit — and origin doesn't carry the new `.gitattributes` yet. So the very rebase trying to introduce the driver runs *without* it and still throws a conflict on a divergent page. (Observed live: the proxy logged "added union merge driver" and then "Rebase conflict" on the same cycle.) The fix is `.git/info/attributes` — git's per-repo, **non-committed** attributes file, consulted for every merge/rebase regardless of which commit is checked out. It's active immediately, so the first reconciling push succeeds.
  - New `ensureLocalUnionMergeAttribute()` writes `*.jsonl merge=union` to `.git/info/attributes` (idempotent; no-op outside a normal `.git` directory — worktrees and test fixtures are skipped).
  - Wired into `ensureRepoCloned` (both fresh-clone and existing-clone paths, so clones created before this self-heal), `ensureUnionMergeAttribute` (CLI/daemon write path), and the proxy's `push-debouncer`.
  - The committed `.gitattributes` from 1.5.0 is kept and still useful: once a node's *local* driver lets the first push land, the committed file rides along to origin and propagates the mapping to every other clone (including ones running older versions — the `union` driver is built into git and honored from a pulled `.gitattributes` thereafter). Local file = bootstrap + this node; committed file = propagation to all nodes.
  - Validated end-to-end on the Railway proxy: after `.git/info/attributes` was present, the previously-conflicting `cortex/engineering` pushes succeeded and `HiveDB Proxy`-authored commits landed on the team cortex.

## [1.5.0] — 2026-05-22

### Fixed

- **Cortex branches now carry a `union` merge driver for `*.jsonl`, so divergent nodes reconcile without losing data.** Page numbers (`000006.jsonl`) are assigned from the *local* highest-page-on-disk, but the page namespace is *global* (the shared cortex branch). Any node whose local view has drifted — a laptop returning from a long offline stretch, a crashed daemon, a proxy that was on the wrong branch — mints a page number that already exists on the remote with *different* content. Without a union driver the `pull --rebase` before each push conflicts, and naive resolution (`-X ours`/`theirs`) silently drops one side's lines. This change commits a `.gitattributes` (`*.jsonl merge=union`) onto every cortex branch; git's built-in `union` driver concatenates both sides on conflict, so concurrent appends reconcile losslessly (consumers already dedup by `id` and sort by `ts` on read).
  - `createOrphanBranch` stamps `.gitattributes` into a new cortex's *first* commit, so every clone is born union-merged.
  - Both write paths self-heal pre-existing branches: `appendAndCommit` (CLI/daemon) and the proxy's `push-debouncer` ensure the attribute is committed **before** their `pull --rebase`, so the very first reconciliation already benefits. Because the file lives on the shared branch, one node stamping it propagates to all others on pull.
  - New exports `UNION_MERGE_ATTRIBUTE` + `withUnionMergeAttribute(current)` (pure content-shaper) so the sync and async write paths emit byte-identical `.gitattributes`.
  - Tradeoff: a reconciled page can briefly exceed the soft `L1_PAGE_SIZE` rotation target (it now holds two nodes' lines). Cosmetic — size drives *when* to rotate, not correctness.
  - Discovered live on a Railway proxy co-writing `cortex/engineering` with an operator's local daemon: every `pull --rebase` threw a rebase conflict on the shared page until the union driver landed.

## [1.4.0] — 2026-05-22

### Fixed

- **Push-debouncer now pulls `--rebase` before pushing, with bounded retry on non-fast-forward.** The cortex branch (`cortex/<name>`) is a *shared* ref — the proxy is not the only writer; an operator's local daemon (or a second proxy) commits to the same branch. The push-debouncer did a bare `git push` with no preceding pull, so the moment `origin` carried any commit the local clone lacked, every push bounced with `! [rejected] … (fetch first)` and curated memories piled up locally, never reaching the team cortex. The CLI write path (`lib/git.ts:appendAndCommit` → `pullRebaseOrAbort`) already rebased before pushing; the proxy's `push-debouncer` path did not. Now `_executePush` rebases the just-made commit onto `origin/<branch>` (append-only JSONL rebases cleanly — distinct writers append distinct lines) and pushes, retrying up to 3 times if `origin` advances again in the window between pull and push. Rebase conflicts abort cleanly (no lingering rebase-in-progress) and surface a clear error; non-rejection push errors (auth, network) are surfaced immediately rather than spun on. This is the last of a sequence of proxy-write-path divergences from the proven CLI path (shebang `env -S` → curator-drain orchestrator → git identity → branch checkout in 1.3.0 → this); the proxy's commit-and-push cycle now mirrors `appendAndCommit`'s switch → pull-rebase → commit → push end to end. Discovered live on a Railway proxy whose pushes bounced indefinitely because an operator's local daemon was co-writing `cortex/engineering`.

## [1.3.0] — 2026-05-22

### Fixed

- **Daemon/proxy writes now switch to the cortex's branch before appending.** The L1 write paths (`sync-handler`, `compaction/apply`, `supersession/apply`, and the proxy `cortex-writer`) resolve every page to `<repo>/<branch>/<file>`, but the shared working tree only contains the *checked-out* branch's files. If something else had moved the tree to a different branch (an operator command, or an earlier write to another cortex), the append physically landed on that wrong branch and the push-debouncer committed it there. Each write now calls `ensureBranchCheckedOut(cortex)` first, and the push-debouncer re-establishes the branch before its `git add → commit → push` cycle in case a concurrent write switched the tree during the debounce window. No-ops when there is no `.git` repo (test fixtures).

## [1.2.0] — 2026-05-22

### Added

- **`think cortex migrate-layout [cortex]` — one-time move to the nested cortex layout.** Every cortex's git files (numbered memory pages, `long-term.jsonl`, `<peer>-retros.jsonl`) now live under a single per-branch subdir: `<repo>/<branch>/<file>`. Two write paths historically disagreed — the legacy `git-adapter` wrote flat at the branch root while the daemon + proxy paths wrote nested — leaving branches with files in both places and making `reindex --force` silently drop the nested pages (it listed via a non-recursive `ls-tree`). The migration command renumbers and relocates the flat files into the canonical subdir, preserving linear history: flat pages keep their numbers, pre-existing nested pages get bumped past them, and any non-canonical sibling subdir (e.g. a `hivedb/` dir on the `cortex/hivedb` branch) folds into the canonical path. Supports `--dry-run` and `--no-push`. Restores the originally-checked-out branch when it finishes so a running daemon keeps writing to the right tree.
- **`think serve` scheduler now drains uncurated events on every tick.** The pre-1.2.0 proxy pipeline landed terminal events in the `events` table but had no orchestrator to run `processTerminalEvent` over them — events would accumulate forever with `curated_at IS NULL`, no Claude calls would fire, and nothing would land on the team cortex. The drain pass now runs after each per-subscription poll cycle.
  - Reads up to `curateBatchSize` uncurated rows (default 10) and runs each through the existing curator → cortex-writer → mark-curated pipeline.
  - Per-event failures are isolated: one rate-limit / SDK error / malformed LLM response does not block the rest of the batch, and the failed row stays `curated_at = NULL` so the next tick retries.
  - Drain-infrastructure failures (a thrown config read, a sqlite error in `selectEvents`) are caught at the drain boundary and surfaced as `curate_skip_reason: 'error'`. They cannot escape into the surrounding tick loop or abort polls — the proxy stays alive even if curation breaks.
- **Operator can switch the active cortex against a running proxy.** `boot-entry.ts` wires the drain with a `getCortexName` closure that re-reads `config.cortex.active` on every tick, so `think cortex switch <new>` against a live proxy takes effect on the next tick without a restart. Setting it to `null` (no active cortex) cleanly skips the drain — diagnosed as `curate_skip_reason: 'no-active-cortex'`.
- **New `SchedulerOptions` fields:** `peerId`, `getCortexName`, `curateBatchSize`, plus `processEvent`/`selectEvents` test seams. All optional — schedulers constructed without `peerId`/`getCortexName` keep drain-off behaviour, so embedders that don't want the drain stay unaffected. `curateBatchSize` is clamped to `>= 1` so an operator typo (`0`, negative) does not silently disable the drain.

### Changed

- **Canonical cortex layout is now `<repo>/<branch>/<file>`.** `createOrphanBranch`, `appendAndCommit`, `migrateToBuckets`, `countBranchFileLines`, and the `git-adapter` push/pull paths all resolve cortex files through the branch subdir. `listBranchFiles` reads the union of the canonical subdir and the branch root (deduped by basename, canonical wins) so a cortex that has not yet been through `migrate-layout` stays readable instead of silently appearing empty; `readCortexFile` mirrors that with a read-side fallback (canonical first, then root). The legacy top-level `memories.jsonl` (pre-v2) remains the one intentional flat-layout read.
- **`TickReport` shape grew three required fields:** `poll_finished_at` (the timestamp after the poll loop finishes, before drain begins — operators alerting on poll-cycle latency should subtract `started_at` from this, not from `finished_at`), `curate_outcomes` (per-event drain results, always present, possibly empty), and `curate_skip_reason` (`'disabled-no-peer-id' | 'disabled-no-cortex-resolver' | 'no-active-cortex' | 'empty-queue' | 'error' | null` — `null` means the drain ran and touched at least one event; otherwise the reason it produced no outcomes). **Direct constructors of `TickReport` will need to supply these fields**; callers that consume reports returned from `tickOnce()` see the new fields automatically and can ignore them.
- **`finished_at` semantics widened.** Pre-1.2.0 it approximated poll-loop wall time. Post-1.2.0 it includes the drain pass, which can add up to `curateBatchSize` × LLM round-trip seconds per tick. **Operators monitoring poll latency on `finished_at - started_at` should migrate to `poll_finished_at - started_at`** to keep the prior signal. The total tick duration is now `finished_at - started_at`.

### Operational impact

- A properly-configured proxy (one passing `peerId` + `getCortexName` — i.e. anything booted via `runServe()`) now spends Claude tokens. First poll after a fresh subscribe fetches every closed PR/issue/release (GitHub's no-`since` semantics), so expect a one-time backfill burst of ~1 Sonnet call per item. Steady state is ~1 call per new closed item afterwards. Tighten via `curateBatchSize` if the per-tick LLM-spend ceiling matters.
- The 9-test scheduler-drain suite covers the 5 skip reasons (including the new `'error'` infrastructure-failure path), happy-path ordering, batch-size pass-through + clamp, per-event failure isolation, dynamic cortex resolution, and the `poll_finished_at`/`finished_at` separation.

## [1.1.0] — 2026-05-22

### Added
- **Forward slashes are now allowed in cortex names.** `sanitizeName` previously rejected anything outside `[a-zA-Z0-9_-]`, which flattened namespaced names (e.g. `cortex/engineering`) into single-segment strings. The regex now also permits `/` while keeping the path-traversal guards (`..`, `//`, `\\`, leading/trailing `/` all still rejected). `getCortexDb` now calls a new `ensureCortexParentDirs(name)` helper so the nested on-disk DB path (`<index>/cortex/engineering.db`) gets its parent directory created before SQLite tries to open the file. Lets cortex names mirror namespaced git refs without forcing a separate branch-name mapping.
- **Notion source connector** (AGT-395, think-proxy-events Phase 4). `think serve` now ships a `notion` connector that emits a terminal event each time a subscribed Notion page is observed with a configured "canonical" property asserted (default: a checkbox named `canonical` set to `true`). Subscription pattern accepts `db:<database-uuid>` (recommended; uses `databases.query` with a `last_edited_time` filter) or `ws:<alias>` (workspace-scoped search). Re-canonicalization after an edit emits a fresh terminal event under the same `episodeKey`, so each settled version becomes its own curated memory while recall groups them. Credential is a Notion internal-integration token stored via the existing vault surface (`THINK_NOTION_PAT` env var or stdin). See `packages/cli/docs/serve.md` for the canonical-page team convention and pattern grammar.
- **`slack` source connector for `think serve` (AGT-394, think-proxy-events Phase 4).** Adds an opt-in capture path for settled Slack threads. Slack threads have no native "closed" state, so capture is gated on a **team convention**: a designated reaction on the thread ROOT (default `lock` — bare reaction name, no colons; configurable via `THINK_SLACK_CLOSING_REACTION`) signals "this thread is settled — curate it now." On detection the connector fetches the thread via `conversations.replies` (first 100 messages; `has_more: true` is surfaced in the payload when the thread is longer than that — pagination is a v2 follow-on) and emits one terminal event keyed `slack:<workspace>:<channel>:<thread-ts>`, payload carrying participants (user IDs), message text in order, and the time range. Per poll the connector walks `users.conversations` (channels the bot is a member of) → `conversations.history` (most recent page per channel) → for each thread root carrying the closing reaction not already in the cursor's `emittedThreadKeys` set, `conversations.replies` to fetch the thread. Cursor is `{ emittedThreadKeys: string[] }`, FIFO-trimmed to 500; below the cap, dedup falls through to the events table's `events_sub_id_unique`. `verifyCredential` probes `auth.test`. Subscription `pattern` is a free-form workspace label (no slash semantics, just an `episodeKey` namespace). Required bot scopes: `channels:history`, `groups:history`, `channels:read`, `groups:read`, `reactions:read`. Adopting teams should announce the convention to their team; teams that don't adopt get nothing — no central infrastructure burden. See `docs/serve.md` for the operator runbook.

### Deprecated
- **`think subscribe poll` default behavior is now a deprecation no-op** (AGT-389, think-proxy-events Phase 3). The pre-think-proxy-events model had every machine poll the proxy and write external events into its own local engrams table, then individually curate them. The new model: the proxy curates centrally and publishes memories to a team cortex; team members `git pull` like any other cortex. The local engram-write path stays available behind a `--legacy-engrams` flag during the migration window so v2 installs don't break.

### Fixed
- **Bundled CLI shebang now uses `env -S`, unblocking Linux container deployments.** The dist banner was `#!/usr/bin/env node --no-warnings=ExperimentalWarning` (no `-S`). On Linux the kernel passes everything after `env` as a single literal arg, so GNU coreutils env (Debian 12 / 9.1 — every common container base) couldn't find a binary named `"node --no-warnings=ExperimentalWarning"` and fell back to exec'ing the next arg — the script itself — re-triggering the shebang dispatch. Result: infinite re-exec loop. `think serve` / `think --version` / `think --help` all hung at CPU pegged with no stdout. macOS BSD env silently tolerates the missing `-S`, which is why the bug never surfaced in dev. Surfaced during a Railway deploy of the proxy where the container reported Online for ~30 minutes with zero log output before `strace` revealed the loop. Fix: `tsup.config.ts` banner now emits `#!/usr/bin/env -S node --no-warnings=ExperimentalWarning`. Verified end-to-end on `node:22-bookworm-slim` — `think --version` prints instantly via the shebang path (vs. infinite loop before). `env -S` has been in GNU coreutils since 8.30 (Aug 2018), so no floor regression.

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
- **Daemon must have `THINK_ANTHROPIC_KEY` (or the deprecated `ANTHROPIC_API_KEY`) in its env.** The daemon process inherits env at spawn time. As of 1.9.4, `THINK_ANTHROPIC_KEY` is the preferred key (it keeps think's billing isolated from other Anthropic tools in the same shell); `ANTHROPIC_API_KEY` is accepted as a deprecated fallback. If your shell exports either key conditionally (e.g. via a wrapper function), restart the daemon under that wrapper so it picks up the new variable.

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
