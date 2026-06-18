import path from 'node:path';
import fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import { getThinkConfigDir } from './paths.js';

export interface FsBackendConfig {
  /**
   * Absolute path to the cortex root directory. Each cortex lives under
   * `<path>/<cortex>/` and stores per-peer JSONL buckets. Whatever sync
   * tool (iCloud, Drive, Syncthing, or none) governs the folder is opaque
   * to think — see `~/Ideas/think-cli-v2/01-local-fs-adapter.md`.
   */
  path: string;
}

/**
 * Tunable weights and thresholds for the composite retro value signal
 * (AGT-460 / design doc §5 M5). Every field is optional; omitted fields fall
 * back to the `DEFAULT_RETRO_VALUE_SIGNAL_*` constants in
 * `retro-value-signal.ts`. The composite is a weighted sum of deliberate-use
 * signals (independent re-reports, brief/session-start surfacings) plus a
 * recency bonus, with mid-session vector surfacings weighted well below them.
 */
export interface RetroValueSignalConfig {
  /** Weight per independent re-report (`occurrences`). The strongest signal. */
  occurrenceWeight?: number;
  /** Weight per `source='brief'` surfacing (deliberate task-start load). */
  briefWeight?: number;
  /** Weight per session-start surfacing (`session_seq=1`). */
  sessionStartWeight?: number;
  /** Weight per mid-session surfacing (`session_seq>1`) — vector noise. */
  midSessionWeight?: number;
  /**
   * Maximum bonus added when the last high-similarity surfacing is fresh. The
   * bonus decays exponentially with the age (in days) of that surfacing.
   */
  recencyWeight?: number;
  /** Exponential decay constant (per day) for the recency bonus. */
  recencyDecayPerDay?: number;
  /**
   * Score (`retro_surfacings.score`, the recency-weighted cosine) at or above
   * which a surfacing counts as "high-similarity" for the recency bonus.
   */
  highSimilarityThreshold?: number;
  /**
   * Composite-signal value at or above which the curator promotes a retro.
   * Replaces the old raw `occurrences >= 2` gate. The default is tuned so a
   * retro with two independent occurrences still promotes with no telemetry.
   */
  promoteThreshold?: number;
}

export interface CortexConfig {
  /** Git remote URL. Optional — only used by the git sync backend. */
  repo?: string;
  /** Local-fs backend. Mutually exclusive with `repo`. */
  fs?: FsBackendConfig;
  active?: string;
  author: string;
  curateEveryN?: number;
  confirmBeforeCommit?: boolean;
  selectivity?: 'low' | 'medium' | 'high';
  granularity?: 'detailed' | 'summary';
  maxMemoriesPerRun?: number;
  bucketSize?: number;
  onboardingDepth?: number;
  engramTTLDays?: number;
  idleWindowMinutes?: number;
  staleWindowMinutes?: number;
  retroRelegateAfterRuns?: number;
  /**
   * Cadence, in hours, at which the daemon runs retro curation (the merge →
   * promote → relegate passes that `think curate-retros` performs) for each
   * local repo cortex (AGT-462 / design doc §5 M6). The personal work-log
   * cortex (`cortex.active`) is never curated — curation is retro-scoped.
   *
   * Set to `0` (or any value ≤ 0) to disable the scheduled loop entirely; the
   * manual `think curate-retros` command is unaffected. Default 6 (see
   * `DEFAULT_CURATION_INTERVAL_HOURS` in `daemon/curation-loop.ts`).
   *
   * Requires a daemon restart to take effect.
   */
  curationIntervalHours?: number;
  /**
   * Cadence, in hours, at which the daemon prunes stale, locally-rebuildable
   * embedding BLOBs from each cortex L2 and VACUUMs reclaimed space. The prune
   * clears embeddings on tombstoned rows and on rows superseded longer than
   * {@link pruneSupersededGraceDays} ago — neither of which recall still uses —
   * so it frees disk and per-query RAM without losing content, keyword recall,
   * or the L1 source of truth (cleared rows can be re-embedded via `think
   * reindex`).
   *
   * Set to `0` (or any value ≤ 0) to disable the scheduled loop entirely.
   * Default 24 (see `DEFAULT_PRUNE_INTERVAL_HOURS` in
   * `daemon/embedding-prune-loop.ts`). Requires a daemon restart to take effect.
   */
  pruneIntervalHours?: number;
  /**
   * Grace window, in days, before a superseded row's embedding becomes
   * eligible for pruning. Keeps a freshly-superseded row's vector around
   * briefly in case it is still a useful recall bridge. Tombstoned rows are
   * pruned immediately and ignore this. Default 14 (see
   * `DEFAULT_PRUNE_SUPERSEDED_GRACE_DAYS`).
   */
  pruneSupersededGraceDays?: number;
  /**
   * Minimum trimmed-character length for a `kind=retro` write (AGT-455).
   * Retros below this are rejected at intake unless `--force` is set.
   * Default 40 (see `DEFAULT_RETRO_MIN_LENGTH`).
   */
  retroMinLength?: number;
  /**
   * Cosine-similarity threshold above which a new retro is folded into an
   * existing near-duplicate retro (occurrences++) instead of inserted
   * (AGT-455). Default 0.95 (see `DEFAULT_RETRO_NEAR_DUP_THRESHOLD`).
   */
  retroNearDupThreshold?: number;
  /**
   * Weights and thresholds for the composite retro value signal (AGT-460 /
   * design doc §5 M5). The composite replaces raw surface-count as the value
   * proxy in promotion logic and the `think retro-usage` ranking. See
   * `retro-value-signal.ts` for the formula and the per-field defaults.
   */
  retroValueSignal?: RetroValueSignalConfig;
  /**
   * Persistent opt-in to ship cortex content to Anthropic via the Claude
   * Agent SDK (`think curate`, `think long-term backfill`, episode
   * curation, retro dedupe). The CLI fails closed if this is `false`/
   * unset AND `THINK_LLM_CONSENT` env var is also unset (AGT-065).
   */
  llmConsent?: boolean;
  /**
   * Hard ceiling on the assembled curation prompt size in characters.
   * Default 50_000 (~12k tokens). When exceeded, the assembler trims
   * recent-memories oldest-first and prints a warning. AGT-065 INFO #20.
   */
  curatorPromptCharCap?: number;
  /**
   * Which LLM backend think's curation calls should use.
   *
   * - `'auto'` (default) — local-first: route to the local model when one is
   *   configured (`local.endpoint` set) and the task fits its context budget;
   *   fall back to Anthropic only when the task is too big AND LLM consent is
   *   granted. With no `local.endpoint` set, `'auto'` behaves exactly as
   *   pre-local-first think did (Anthropic via the Claude Agent SDK) — so the
   *   feature is inert until a user opts in by configuring an endpoint.
   * - `'local'` — local only. Never ships to Anthropic; if a task overflows the
   *   local context budget the call is skipped with a warning (engrams stay
   *   pending for a later run).
   * - `'anthropic'` — Anthropic only (the legacy path).
   *
   * Env override: `THINK_LLM_PROVIDER`.
   */
  llmProvider?: 'auto' | 'local' | 'anthropic';
  /** Local OpenAI-compatible LLM backend (oMLX/Qwen). See `LocalLlmConfig`. */
  local?: LocalLlmConfig;
  /**
   * Per-source trust tier policy (AGT-466). Declares a priority-ordered list
   * of `selector → tier` rules that classify every recall entry as one of
   * `trusted`, `untrusted`, or `quarantined`. First-match-wins. An implicit
   * final rule `* → untrusted` is always appended — the fail-safe default.
   *
   * When this block is absent OR `rules` is empty, the shipped defaults apply:
   *   - `self`    → `trusted`
   *   - everything else → `untrusted`   (implicit `* → untrusted`)
   *
   * Nothing is `quarantined` by default — a user who never writes a rule sees
   * byte-identical recall output compared to pre-AGT-466 (tier filtering is
   * entirely opt-in via `--trust-tier` / `--exclude-trust-tier` flags).
   *
   * Selector grammar: identical to `--source`/`--exclude-source` selectors
   * (`self`, `unknown`, `peer`, `proxy`, `peer:<name>`, `proxy:<connector>`),
   * extended to also accept `*` as a wildcard that matches every provenance.
   * See `validateTrustTierSelector` in `daemon/recall.ts`.
   */
  trustTiers?: TrustTiersConfig;
  /**
   * Use git plumbing (hash-object / read-tree / commit-tree / update-ref) to
   * append cross-cortex L1 writes directly to the cortex branch ref, instead
   * of checking that branch out into the shared worktree first (#70 Option B,
   * iterative-learning-v2 §6 / AGT-458).
   *
   * The plumbing path never runs `git switch` on the shared worktree, which
   * removes the cross-cortex switch race that was the root of the
   * #70/#65/#69 fragility class. Default `true`. Set to `false` to fall back
   * to the legacy switch+commit worktree path (kept as a reversible escape
   * hatch while the plumbing path soaks).
   */
  plumbingWrites?: boolean;
  /**
   * Minimum number of commits by which the local cortex clone must trail
   * `origin/<branch>` before the push-debouncer takes the force-reset path on
   * attempt 1, bypassing the normal append-then-push round-trip (AGT-478 AC #3).
   * Default 10.
   *
   * - A value of 1 means the force-reset path is taken on attempt 1 whenever
   *   the clone is at all behind origin.
   * - A value of 0 disables the large-behind short-circuit entirely (force-reset
   *   still happens on attempt 2+ after a push rejection, but attempt 1 always
   *   tries the normal append-then-push path first).
   */
  largeBehindThreshold?: number;
}

/**
 * Configuration for the local, OpenAI-compatible LLM backend (oMLX/Qwen, the
 * same server hal9k's `localqwen up` drives). think POSTs to
 * `<endpoint>/chat/completions` with a Bearer token. Every field has an env
 * override so CI/agents can point at a different server without editing config.
 */
export interface LocalLlmConfig {
  /**
   * OpenAI-compatible base URL, e.g. `http://localhost:8080/v1`. When unset,
   * local routing is disabled and `llmProvider: 'auto'` falls back to the
   * Anthropic path. Env override: `THINK_LOCAL_ENDPOINT`.
   */
  endpoint?: string;
  /**
   * Model id served at the endpoint (e.g. a Qwen id from `GET <endpoint>/models`).
   * Required when `endpoint` is set. Env override: `THINK_LOCAL_MODEL`.
   */
  model?: string;
  /**
   * Bearer token for the local endpoint. Defaults to `"lm-studio"` (matching
   * hal9k's default for local servers that ignore auth). Env override:
   * `THINK_LOCAL_API_KEY`.
   */
  apiKey?: string;
  /**
   * Token budget used to decide whether a task fits the local model. The router
   * estimates the prompt at ~chars/4 tokens; if the estimate exceeds this
   * budget it routes to Anthropic (auto) or skips (local). Leave headroom below
   * the model's true context window for the response. Default: 28_000.
   * Env override: `THINK_LOCAL_CTX_BUDGET`.
   */
  ctxBudget?: number;
}

export interface SubscriptionsConfig {
  /** Base URL of the `think serve` proxy (no trailing slash). */
  proxyUrl: string;
  /** Bearer token matching the proxy's `THINK_TOKEN`. */
  token: string;
  /**
   * Per-subscription cursor: highest `server_seq` already pulled into the
   * local engram DB. `think subscribe poll` resumes from `cursors[id] + 0`
   * via `?since=<cursor>`. Stored in the same `config.json` (mode 0600);
   * fine for tens of subscriptions, flag a follow-up if a real user racks
   * up hundreds and the file gets noisy.
   */
  cursors?: Record<string, number>;
  /**
   * Per-subscription JSONPath-subset redact selectors (AGT-066). Applied
   * during `think subscribe poll` after the baseline PII strip and before
   * the payload lands as engram content. Selector format is `$.a.b.c.d`
   * or `a.b.c.d` (leading `$.` optional, no array indices/wildcards/
   * filters). See `src/lib/subscribe-redact.ts`.
   */
  redact?: Record<string, string[]>;
}

export interface SearchConfig {
  /**
   * Vector search engine. `"brute-force"` runs cosine over all L2 BLOBs
   * in-process — fast enough for <50K vectors. `"sqlite-vec"` loads the
   * sqlite-vec extension for ANN-style search; falls back to brute-force if
   * the extension cannot be loaded (e.g. unsupported OS / Node build).
   * Default: `"brute-force"`.
   */
  engine?: 'brute-force' | 'sqlite-vec';
}

export interface DaemonConfig {
  /**
   * Windows-only TCP fallback port. On macOS/Linux the daemon binds a Unix
   * domain socket; this field is ignored on those platforms.
   * Default: 47821.
   */
  tcpPort?: number;
}

export interface RecallConfig {
  /**
   * Exponential decay constant for recency-weighted ranking.
   *
   * score = cosine × exp(-recencyDecay × (max_seq - entry_seq))
   *
   * At recencyDecay=0.05:
   *   seq_distance=0  → weight=1.00 (most recent entry, full weight)
   *   seq_distance=14 → weight≈0.50 (~half weight)
   *   seq_distance=28 → weight≈0.25 (~quarter weight)
   *
   * This ensures the most recent ~20 entries always dominate regardless of
   * corpus age or absolute timestamp spread — recency is corpus-relative,
   * not wall-clock-relative.
   *
   * Set to `0` to disable recency weighting and return pure cosine ranking.
   *
   * Default: 0.05
   */
  recencyDecay?: number;

  /**
   * Absolute cosine-similarity floor for recall (AGT-456 / design doc §5 M2).
   *
   * Any candidate whose raw cosine similarity (in [−1, 1], BEFORE recency
   * reweighting) is below this floor is excluded from the result set. This
   * stops sparse cortexes from surfacing garbage-tier matches just because
   * they are the best of a bad top-K — a query with no above-floor matches
   * returns zero entries rather than low-similarity junk.
   *
   * Reuses the compaction-triage 0.6 as a starting point; tune after a sweep
   * against the usage corpus (design doc §8 open question).
   *
   * The floor is inapplicable in the FTS-fallback path (no embeddings, hence
   * no cosine to compare) — FTS results are ranked by the FTS5 engine and
   * carry `similarity: 0`, so the floor is intentionally NOT applied there.
   *
   * Range: [−1, 1]. Set to `-1` (or any value ≤ −1) to disable the floor.
   *
   * Default: 0.6
   */
  relevanceFloor?: number;

  /**
   * Additive quality boost applied to a recall candidate whose retro is
   * curator-promoted (`retros.promoted = 1`), on top of the cosine × recency
   * score (AGT-459 / design doc §5 M4).
   *
   * The boost is intentionally small relative to the cosine spread so curated
   * quality breaks ties and lifts a promoted lesson above an equal-similarity
   * un-promoted one, WITHOUT letting a weak-but-promoted match drown a strong
   * exact match (design doc §8 open question). Memory rows and un-curated
   * cortexes have no matching `retros` row and receive no boost, so ranking is
   * unchanged for them (graceful degradation).
   *
   * Set to `0` to disable the boost.
   *
   * Default: 0.1
   */
  qualityBoost?: number;

  /**
   * Additive quality penalty (subtracted from the score) applied to a recall
   * candidate whose retro was curator-relegated — `retros.promoted = 0` with
   * prior recall history (`recalled_count > 0`), i.e. a retro that was once
   * promoted and later demoted by the relegation pass (AGT-457). This is
   * distinct from a never-curated retro (`promoted = 0`, `recalled_count = 0`),
   * which receives no penalty so un-curated cortexes do not regress.
   *
   * Stored as a non-negative magnitude; it is subtracted from the score.
   *
   * Set to `0` to disable the penalty.
   *
   * Default: 0.1
   */
  qualityPenalty?: number;

  /**
   * Additive boost (iterative-learning v3 — retro locality) applied to a recall
   * candidate retro tagged with the caller's active working context
   * (`repo:<context>`), where context is the git-repo basename the command runs
   * in. Surfaces lessons for the current codebase first without hard-filtering
   * out cross-context lessons (brief scopes; recall boosts). Applied after
   * recency weighting, like qualityBoost. Only affects rows carrying the
   * matching `repo:` topic; ignored when no context is supplied.
   *
   * Set to `0` to disable.
   *
   * Default: 0.1
   */
  contextBoost?: number;
}

/**
 * Tier value for a trust tier rule or a classified entry (AGT-466).
 *
 * - `trusted`      — content authored by sources the user explicitly trusts
 *                    (default: `self` entries). Surfaced normally.
 * - `untrusted`    — content from sources the user has not explicitly trusted
 *                    (default: all non-self entries). Surfaced normally unless
 *                    `--trust-tier` filtering is active.
 * - `quarantined`  — content the user wants excluded from recall and curation
 *                    by default. Silently dropped unless `--include-quarantined`
 *                    is passed. Nothing is quarantined by default.
 */
export type TrustTier = 'trusted' | 'untrusted' | 'quarantined';

/**
 * A single selector → tier rule in the `trustTiers.rules` list (AGT-466).
 *
 * `match` is a provenance selector (same grammar as `--source`/`--exclude-source`,
 * extended to accept `*` as a wildcard). `tier` is the trust tier to assign when
 * the entry's provenance matches `match`. First-match-wins across all rules.
 */
export interface TrustTierRule {
  /**
   * Provenance selector that triggers this rule. Valid values:
   *   `self`, `unknown`, `peer`, `proxy`, `peer:<name>`, `proxy:<connector>`, `*`.
   * `peer` matches all `peer:*` values; `proxy` matches all `proxy:*` values;
   * `*` matches everything. See `validateTrustTierSelector` in `daemon/recall.ts`.
   */
  match: string;
  /**
   * Trust tier assigned to entries whose provenance matches `match`.
   */
  tier: TrustTier;
}

/**
 * Per-source trust tier configuration (AGT-466). Lives at `cortex.trustTiers`
 * in `~/.config/think/config.json`.
 */
export interface TrustTiersConfig {
  /**
   * Ordered list of selector → tier rules. First-match-wins. The implicit
   * final rule `* → untrusted` is always appended after all explicit rules,
   * so any provenance not matched by a user-written rule resolves to `untrusted`.
   *
   * An empty (or absent) `rules` array is equivalent to having no `trustTiers`
   * block at all — the shipped defaults apply: `self → trusted`, everything
   * else → `untrusted`.
   */
  rules?: TrustTierRule[];
}

export interface CompactionConfig {
  /**
   * Master kill-switch for write-time compaction. Set to `false` to disable
   * all compaction LLM calls without revoking general LLM consent. Jobs
   * already in the queue are drained (no-op skips) rather than dropped —
   * consistent with triage-gate skip behaviour. Defaults to `true` when
   * absent.
   *
   * Use case: emergency stop when the LLM produces bad supersession results
   * without disabling retro supersession checks or other LLM features.
   *
   * Default: true
   */
  enabled?: boolean;

  /**
   * Cosine similarity threshold for the compaction triage gate (AGT-300).
   *
   * Before calling the LLM, the worker searches L2 for the top-K most
   * similar entries in the same cortex. If max(candidate.cosine) is below
   * this threshold, the LLM call is skipped — the new entry is net-new on
   * its topic and there is nothing to fold.
   *
   * Range: [−1, 1]. Higher = stricter (more entries skip LLM). The default
   * 0.6 is a rough heuristic; tune after observing your corpus in alpha.
   *
   * Default: 0.6
   */
  triageThreshold?: number;
}

export interface ProxyConfig {
  /**
   * WebSocket URL of the think-v3 proxy server (ws:// or wss:// only).
   * When set, the daemon connects and listens for near-realtime push
   * notifications; on push it fetches immediately instead of waiting for
   * the next poll interval.
   * Set via `think config set proxy.url <url>`.
   * Requires daemon restart for changes to take effect.
   */
  url?: string;
}

/**
 * A stdio MCP server an org wants the dashboard's agentic prompt box to be
 * able to search (e.g. a Linear MCP server, to cross-check tickets).
 */
export interface DashboardMcpServer {
  type?: 'stdio';
  command: string;
  args?: string[];
  /** Tool names to allow, namespaced `mcp__<name>__<tool>`. */
  allowedTools?: string[];
}

/** One panel on the dashboard. */
export interface DashboardPanel {
  /** Stable key the digest emits / the view renders. */
  key: string;
  title: string;
  /** CSS color for the dot accent. */
  accent?: string;
  /**
   * 'digest' — an AI bucket; `desc` tells the model what belongs here.
   * 'today'  — a raw, AI-free list that live-tails the work-log for today.
   */
  render?: 'digest' | 'today';
  /** For render:'digest' — what the model should put in this bucket. */
  desc?: string;
}

/**
 * Heavy customization surface for `think dashboard`. Every field is optional;
 * omitting the whole block reproduces the built-in three-panel default.
 */
export interface DashboardConfig {
  /** Path to a custom view .tsx (absolute, or relative to cwd). */
  view?: string;
  /** Days of work-log history the digest summarizes. Default 7. */
  windowDays?: number;
  /** Panels, in order. Defaults to working-on / shipped-today / unfinished. */
  panels?: DashboardPanel[];
  /** Override the digest model / extra system guidance. */
  digest?: { model?: string; prompt?: string };
  /** Extra MCP servers the agentic prompt box may search, keyed by name. */
  ask?: { servers?: Record<string, DashboardMcpServer>; model?: string; maxTurns?: number };
}

export interface Config {
  peerId: string;
  syncPort: number;
  cortex?: CortexConfig;
  paused?: boolean;
  subscriptions?: SubscriptionsConfig;
  search?: SearchConfig;
  daemon?: DaemonConfig;
  recall?: RecallConfig;
  compaction?: CompactionConfig;
  proxy?: ProxyConfig;
  dashboard?: DashboardConfig;
}

export function getConfigDir(): string {
  return getThinkConfigDir();
}

function configPath(): string {
  return path.join(getConfigDir(), 'config.json');
}

export function saveConfig(config: Config): void {
  const dir = getConfigDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
}

// Module-local guard so a long-lived process that calls getConfig() many
// times only emits the v2 deprecation banner once. The persisted file is
// rewritten on the first call so subsequent processes never re-warn.
let legacyServerWarned = false;

export function getConfig(): Config {
  const fp = configPath();
  if (fs.existsSync(fp)) {
    const raw = fs.readFileSync(fp, 'utf-8');
    const parsed = JSON.parse(raw) as Config & { cortex?: { server?: { url?: unknown } } };
    if (parsed.cortex && 'server' in parsed.cortex) {
      // Echo the dropped URL (token stays redacted) so a user who upgrades,
      // runs anything, then realizes they wanted to migrate has a trace
      // they can paste into a v1 invocation. Token is intentionally never
      // surfaced — it lands in stderr/cron logs/scrollback otherwise.
      const droppedUrl = typeof parsed.cortex.server?.url === 'string' ? parsed.cortex.server.url : null;
      // Side-channel backup before the destructive prune. Most users don't
      // back up ~/.think/config.json; if they miss the one-shot stderr
      // banner (cron, piped output, scrollback), the URL/token are gone.
      // Same dir, same perms (0o600 enforced via fs.writeFileSync mode).
      const backupPath = `${fp}.pre-v2-prune`;
      let backupOk = false;
      try {
        fs.writeFileSync(backupPath, raw, { mode: 0o600 });
        backupOk = true;
      } catch {
        // Backup failure is non-fatal but load-bearing for recovery — the
        // banner copy below branches on backupOk so the user is never
        // told a backup exists when it doesn't.
      }
      delete parsed.cortex.server;
      if (!legacyServerWarned) {
        legacyServerWarned = true;
        const urlLine = droppedUrl
          ? `       URL was: ${droppedUrl}  (token redacted)\n`
          : '';
        // Backup status is load-bearing: a user who reads "backup written"
        // and then deletes their notes assuming they have a fallback has
        // lost data. Fail loud when the backup didn't take.
        const backupLine = backupOk
          ? `       A backup of the pre-prune config was written to ${backupPath} (mode 0600).\n`
          : `       WARNING: failed to write a backup to ${backupPath}.\n` +
            `       The URL echoed above is your only record of the dropped server config.\n`;
        process.stderr.write(
          `think: dropped legacy \`cortex.server\` from ${fp} — the http backend retired in v2.\n` +
          urlLine +
          backupLine +
          '       If you have data on the v1 http backend, downgrade to think-cli v1 and run\n' +
          '         `think cortex migrate --to fs --path <path>`\n' +
          '       FIRST to preserve it. Then upgrade and run `think cortex setup --fs <path>`.\n' +
          '       If you have no data to preserve, run `think cortex setup --fs <path>` directly.\n',
        );
      }
      saveConfig(parsed);
    }
    return parsed;
  }

  const config: Config = {
    peerId: uuidv4(),
    syncPort: 47821,
  };
  saveConfig(config);
  return config;
}

/**
 * Returns this peer's stable UUID. Self-heals legacy configs that pre-date
 * the auto-generated `peerId` field by minting one and persisting it back —
 * users on an older install don't need to delete their config to upgrade.
 */
export function getPeerId(): string {
  const config = getConfig();
  if (typeof config.peerId === 'string' && config.peerId.length > 0) {
    return config.peerId;
  }
  config.peerId = uuidv4();
  saveConfig(config);
  return config.peerId;
}
